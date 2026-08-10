import TelegramBot from 'node-telegram-bot-api';
import EventEmitter from 'events';
import { getPortalSecret } from '../api/auth.js';
import { pool } from '../db/connection.js';
import { createPhaseFromPayload } from '../core/phaseImport.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;

export const telegramEmitter = new EventEmitter();

export const TELEGRAM_MAIN_KEYBOARD = {
  keyboard: [
    [{ text: "📊 Live Status" }, { text: "⚡ Force Resume & Fix" }],
    [{ text: "⏭ Skip Active Task" }, { text: "▶️ Resume Poller" }]
  ],
  resize_keyboard: true,
  persistent: true
};

/**
 * Builds live pipeline status text and inline keyboard buttons.
 */
export async function getStatusSummaryMessage() {
  const [phases] = await pool.query("SELECT * FROM phases WHERE status = 'active' ORDER BY id DESC LIMIT 1");
  const phase = phases[0];

  if (!phase) {
    return {
      text: "ℹ️ No active phase currently running.",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🌐 Open Dashboard", url: "https://jules.sandeepbuilds.com" }]
        ]
      }
    };
  }

  const [tasks] = await pool.query("SELECT * FROM tasks WHERE phase_id = ? ORDER BY sort_order ASC", [phase.id]);
  const total = tasks.length;
  const merged = tasks.filter(t => t.status === 'merged' || t.status === 'skipped').length;
  const activeTask = tasks.find(t => t.status === 'running' || t.status === 'pr_open' || t.status === 'waiting_answer');

  const pct = Math.round((merged / total) * 100) || 0;
  const filled = Math.round((pct / 100) * 10);
  const progressBar = "█".repeat(filled) + "░".repeat(10 - filled);

  let statusText = `📊 Phase Status: ${phase.title}\n`;
  statusText += `Target Branch: ${phase.phase_branch}\n`;
  statusText += `Progress: [${progressBar}] ${merged}/${total} Tasks (${pct}%)\n\n`;

  if (activeTask) {
    statusText += `🔄 Active Task #${activeTask.id}:\n"${activeTask.title}"\nStatus: ${activeTask.status}\n`;
    if (activeTask.pr_url) {
      statusText += `PR: ${activeTask.pr_url}\n`;
    }
  } else {
    statusText += `✅ All active tasks up to date.`;
  }

  const buttons = [];
  if (activeTask && activeTask.pr_url) {
    buttons.push([{ text: "🔗 Open Active PR on GitHub", url: activeTask.pr_url }]);
  }
  buttons.push([
    { text: "📊 Refresh Status", callback_data: "cmd_status" },
    { text: "🌐 Open Dashboard", url: "https://jules.sandeepbuilds.com" }
  ]);

  return {
    text: statusText,
    reply_markup: { inline_keyboard: buttons }
  };
}

let bot;

if (!token || token.startsWith('your_') || process.env.NODE_ENV === 'test' || process.env.JULES_SUPERVISOR_TEST === '1') {
  console.warn('WARNING: TELEGRAM_BOT_TOKEN is not defined, placeholder, or in TEST mode. Telegram service running in mock mode.');
  bot = {
    sendMessage: async (cid, text, options) => {
      console.log(`[Mock Telegram] Send to ${cid || chatId}: ${text}`, options || '');
      return { message_id: Math.floor(Math.random() * 1000000000) };
    },
    answerCallbackQuery: async () => {},
    setWebHook: async (url) => {
      console.log(`[Mock Telegram] Webhook set to ${url}`);
    },
    deleteWebhook: async () => {},
    startPolling: () => {},
    stopPolling: async () => {},
    on: () => {}
  };
} else {
  if (webhookUrl) {
    bot = new TelegramBot(token, { polling: false });
    console.log('Telegram Bot configured for Webhook mode.');
  } else {
    bot = new TelegramBot(token, { polling: false });

    bot.on('polling_error', (error) => {
      if (error.message && error.message.includes('409 Conflict')) {
        // intentionally silent — expected during hot-reload
      } else {
        console.error('Telegram Bot Polling Error:', error);
      }
    });

    const stopAndExit = async (signal) => {
      try {
        await bot.stopPolling();
      } catch (_) {}
      process.kill(process.pid, signal);
    };

    process.once('SIGUSR2', () => stopAndExit('SIGUSR2'));
    process.once('SIGINT',  async () => { try { await bot.stopPolling(); } catch (_) {} process.exit(0); });
    process.once('SIGTERM', async () => { try { await bot.stopPolling(); } catch (_) {} process.exit(0); });

    setTimeout(() => {
      bot.startPolling();
      console.log('Telegram Bot configured for Long-Polling mode.');
    }, 1500);
  }

  // Incoming text messages & commands
  bot.on('message', async (msg) => {
    if (chatId && String(msg.chat.id) !== String(chatId)) {
      console.warn(`Blocked incoming Telegram message from unauthorized chat ID: ${msg.chat.id}`);
      return;
    }

    const text = (msg.text || '').trim();

    // 1. Live Status Command or Button
    if (text === '/status' || text === '/start' || text === '/help' || text === '📊 Live Status') {
      try {
        const summary = await getStatusSummaryMessage();
        await bot.sendMessage(chatId, summary.text, {
          reply_markup: TELEGRAM_MAIN_KEYBOARD
        });
      } catch (err) {
        console.error('Error handling Telegram /status command:', err);
        await bot.sendMessage(chatId, `Error fetching status: ${err.message}`, { reply_markup: TELEGRAM_MAIN_KEYBOARD });
      }
      return;
    }

    // 1b. Force Resume & Fix Button / Command
    if (text === '⚡ Force Resume & Fix' || /^\/restart\b/i.test(text) || /^\/force_resume\b/i.test(text)) {
      try {
        const { forceResumeAll } = await import('../core/poller.js');
        const res = await forceResumeAll();
        await bot.sendMessage(chatId, `⚡ *Supervisor Force Resumed & Unstuck!*\n\nAll pollers auto-revived. Reset active phases: ${res.revivedPhaseIds.join(', ') || 'None'}.\nGitHub PR scan running now...`, {
          parse_mode: 'Markdown',
          reply_markup: TELEGRAM_MAIN_KEYBOARD
        });
      } catch (err) {
        console.error('Error force resuming supervisor via Telegram:', err);
        await bot.sendMessage(chatId, `❌ Error force resuming supervisor: ${err.message}`, { reply_markup: TELEGRAM_MAIN_KEYBOARD });
      }
      return;
    }

    // 2. Pause Poller Button
    if (text === '⏸ Pause Poller') {
      try {
        const [phases] = await pool.query("SELECT * FROM phases WHERE status = 'active' ORDER BY id DESC LIMIT 1");
        const phase = phases[0];
        if (!phase) {
          await bot.sendMessage(chatId, "ℹ️ No active phase running to pause.", { reply_markup: TELEGRAM_MAIN_KEYBOARD });
          return;
        }
        const { pausePhase } = await import('../core/phaseLifecycle.js');
        await pausePhase(phase.id);
        await bot.sendMessage(chatId, `⏸ Supervisor paused for Phase "${phase.title}". Jules may keep working, but this supervisor will not poll, launch, review, or merge until resumed.`, {
          reply_markup: TELEGRAM_MAIN_KEYBOARD
        });
      } catch (err) {
        console.error('Error pausing poller:', err);
        await bot.sendMessage(chatId, `Error pausing poller: ${err.message}`, { reply_markup: TELEGRAM_MAIN_KEYBOARD });
      }
      return;
    }

    // 3. Resume Poller Button
    if (text === '▶️ Resume Poller') {
      try {
        const [phases] = await pool.query("SELECT * FROM phases WHERE status = 'paused' ORDER BY id DESC LIMIT 1");
        const phase = phases[0];
        if (!phase) {
          await bot.sendMessage(chatId, "ℹ️ No paused phase found to resume.", { reply_markup: TELEGRAM_MAIN_KEYBOARD });
          return;
        }
        const { resumePhase } = await import('../core/phaseLifecycle.js');
        await resumePhase(phase.id);
        await bot.sendMessage(chatId, `▶️ Supervisor resumed for Phase "${phase.title}". It is reconciling Jules/GitHub state and will continue from the current task state.`, {
          reply_markup: TELEGRAM_MAIN_KEYBOARD
        });
      } catch (err) {
        console.error('Error resuming poller:', err);
        await bot.sendMessage(chatId, `Error resuming poller: ${err.message}`, { reply_markup: TELEGRAM_MAIN_KEYBOARD });
      }
      return;
    }

    // 4. Skip Active Task Button
    if (text === '⏭ Skip Active Task') {
      try {
        const [phases] = await pool.query("SELECT * FROM phases WHERE status = 'active' ORDER BY id DESC LIMIT 1");
        const phase = phases[0];
        if (!phase) {
          await bot.sendMessage(chatId, "ℹ️ No active phase running.", { reply_markup: TELEGRAM_MAIN_KEYBOARD });
          return;
        }
        const [activeTasks] = await pool.query(
          "SELECT * FROM tasks WHERE phase_id = ? AND status IN ('running', 'waiting_answer', 'pr_open') LIMIT 1",
          [phase.id]
        );
        const task = activeTasks[0];
        if (!task) {
          await bot.sendMessage(chatId, "ℹ️ No running task to skip.", { reply_markup: TELEGRAM_MAIN_KEYBOARD });
          return;
        }
        await pool.query("UPDATE tasks SET status = 'skipped' WHERE id = ?", [task.id]);
        
        const taskManager = await import('../core/taskManager.js');
        const started = await taskManager.startReadyTasks(phase.id, phase.phase_branch);
        
        await bot.sendMessage(chatId, `⏭ Task #${task.id} ("${task.title}") was skipped. ${started > 0 ? 'Next task started automatically!' : 'No more queued tasks ready.'}`, {
          reply_markup: TELEGRAM_MAIN_KEYBOARD
        });
      } catch (err) {
        console.error('Error skipping task:', err);
        await bot.sendMessage(chatId, `Error skipping task: ${err.message}`, { reply_markup: TELEGRAM_MAIN_KEYBOARD });
      }
      return;
    }

    // 5. /sample — sends the JSON format /import accepts, as a code block so it's easy
    // to copy, paste into an LLM to generate real tasks in this shape, then send back
    // via /import.
    if (/^\/sample\b/i.test(text)) {
      const sampleJson = JSON.stringify({
        title: 'Payment Integration',
        description: 'Add Stripe subscription billing.',
        mainBranch: 'main',
        tasks: [
          { title: 'Add Stripe SDK wrapper', description: 'Wrap the Stripe SDK for our billing use case.' },
          { title: 'Add webhook handler', description: 'Handle subscription lifecycle events.', depends_on: [0] },
          { title: 'Write API docs', description: 'Document the new endpoints.' }
        ]
      }, null, 2);

      await bot.sendMessage(
        chatId,
        `Here's the format /import accepts — copy this, edit it (or hand it to an LLM to generate real tasks in this shape), then send it back prefixed with /import:\n\n\`\`\`\n${sampleJson}\n\`\`\`\n\n"depends_on" is a list of 0-based indices into "tasks" — [0] means "depends on the first task above."`,
        { parse_mode: 'Markdown', reply_markup: TELEGRAM_MAIN_KEYBOARD }
      );
      return;
    }

    // 6. /import — bulk phase/task import. Send "/import" followed by a JSON object
    // (same message) to create a whole phase and its tasks in one shot, using the same
    // schema and same validated path as the dashboard's "Create Running Phase" form —
    // then immediately starts it (creates the branch, launches Jules on the first ready
    // tasks). Falls back to leaving it as a draft only if starting itself fails.
    if (/^\/import\b/i.test(text)) {
      const jsonText = text.replace(/^\/import\b/i, '').trim();

      if (!jsonText) {
        await bot.sendMessage(
          chatId,
          'Send the phase JSON right after /import, e.g.:\n/import {"title": "Payment Integration", "tasks": [{"title": "Add Stripe SDK wrapper"}, {"title": "Add webhook handler", "depends_on": [0]}]}',
          { reply_markup: TELEGRAM_MAIN_KEYBOARD }
        );
        return;
      }

      try {
        const parsed = JSON.parse(jsonText);
        if (Array.isArray(parsed)) {
          await bot.sendMessage(
            chatId,
            '⚠️ /import needs a full phase object, not just a task list:\n/import { "title": "...", "description": "...", "tasks": [ { "title": "..." } ] }',
            { reply_markup: TELEGRAM_MAIN_KEYBOARD }
          );
          return;
        }
        const { phaseId, taskCount } = await createPhaseFromPayload(parsed);

        // /import runs the phase immediately (unlike the dashboard's Import JSON, which
        // stays a draft) — that's the point of importing from your phone: it should just go.
        // Dynamic import avoids a circular dependency: phaseLifecycle -> poller -> telegram.
        try {
          const { startPhase } = await import('../core/phaseLifecycle.js');
          const { branch } = await startPhase(phaseId);
          await bot.sendMessage(
            chatId,
            `🚀 Created phase #${phaseId} ("${parsed.title}") with ${taskCount} task(s) and started it on branch \`${branch}\`.\n\nJules is working now — check /status or the dashboard.`,
            { parse_mode: 'Markdown', reply_markup: TELEGRAM_MAIN_KEYBOARD }
          );
        } catch (startErr) {
          console.error(`Error auto-starting phase #${phaseId} from Telegram import:`, startErr);
          await bot.sendMessage(
            chatId,
            `✅ Created phase #${phaseId} ("${parsed.title}") with ${taskCount} task(s), but couldn't start it automatically: ${startErr.message}\n\nIt's saved as a draft — open the dashboard to start it manually.`,
            { reply_markup: TELEGRAM_MAIN_KEYBOARD }
          );
        }
      } catch (err) {
        console.error('Error importing phase from Telegram JSON:', err);
        await bot.sendMessage(chatId, `❌ Couldn't import that: ${err.message}`, { reply_markup: TELEGRAM_MAIN_KEYBOARD });
      }
      return;
    }

    if (msg.reply_to_message) {
      telegramEmitter.emit('reply', {
        replyToMessageId: msg.reply_to_message.message_id,
        text: msg.text
      });
    }
  });

  // Incoming inline button clicks
  bot.on('callback_query', async (query) => {
    if (chatId && String(query.message?.chat?.id) !== String(chatId)) {
      return;
    }

    const data = query.data;
    if (data === 'cmd_status') {
      try {
        const summary = await getStatusSummaryMessage();
        try { await bot.answerCallbackQuery(query.id, { text: 'Status updated!' }); } catch (_) {}
        await bot.sendMessage(chatId, summary.text, {
          reply_markup: summary.reply_markup
        });
      } catch (err) {
        console.error('Error handling callback_query cmd_status:', err);
      }
    }
  });
}

export { bot };



/**
 * Sends an escalation message when AI confidence is low.
 */
export async function sendEscalation(taskTitle, taskId, question) {
  const formatted = `Jules needs your input\n\nTask: ${taskTitle}\nTask ID: ${taskId}\n\nJules asks:\n${question}\n\nReply to THIS message to answer Jules.`;
  return bot.sendMessage(chatId, formatted);
}

/**
 * Sends a threaded reminder for a pending question.
 */
export async function sendReminder(taskTitle, question, originalMessageId) {
  const formatted = `Reminder: Jules is still waiting for your input on task "${taskTitle}".\n\nQuestion:\n${question}`;
  return bot.sendMessage(chatId, formatted, { reply_parameters: { message_id: originalMessageId } });
}

/**
 * Sends a general notification message.
 */
export async function sendNotification(text) {
  return bot.sendMessage(chatId, text);
}

/**
 * Sends an alert when a Jules task PR is blocked or revision requested.
 * Uses Yellow ⚠️ icon for soft retries/revisions, and Red 🚨 icon for hard stops/failures.
 */
export async function sendPRBlockedNotification({ taskTitle, prUrl, riskLevel, blockingReason, julesFix, reviewerSource, isHardStop = false }) {
  const icon = isHardStop ? '🚨' : '⚠️';
  const header = isHardStop ? 'PR Hard-Blocked / Escalated' : 'PR Revision Requested';
  let formatted = `${icon} ${header}\n\nTask: ${taskTitle}\nPR URL: ${prUrl}\nRisk Level: ${riskLevel}`;
  if (reviewerSource) {
    formatted += `\nReviewer: ${reviewerSource}`;
  }
  formatted += `\nReason: ${blockingReason}\nJules Instruction: ${julesFix}`;
  
  const options = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔗 Open PR on GitHub", url: prUrl }],
        [{ text: "📊 Check Status", callback_data: "cmd_status" }, { text: "🌐 Open Dashboard", url: "https://jules.sandeepbuilds.com" }]
      ]
    }
  };
  return bot.sendMessage(chatId, formatted, options);
}

/**
 * Sends an alert when a PR is approved but auto-merge is disabled.
 */
export async function sendPRReadyNotification({ taskTitle, prUrl, reviewerSource }) {
  let formatted = `✅ PR Ready for Review\n\nTask: ${taskTitle}\nPR URL: ${prUrl}`;
  if (reviewerSource) {
    formatted += `\nReviewer: ${reviewerSource}`;
  }
  formatted += `\n\nTask PR appears ready for human review/merge into phase branch.`;
  const options = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔗 Open PR on GitHub", url: prUrl }],
        [{ text: "📊 Check Status", callback_data: "cmd_status" }]
      ]
    }
  };
  return bot.sendMessage(chatId, formatted, options);
}

/**
 * Sends an alert when a task starts.
 */
export async function sendTaskStartedNotification(taskTitle, taskId, phaseBranch) {
  const formatted = `🚀 Task #${taskId} Started\n\nTask: ${taskTitle}\nTarget Branch: ${phaseBranch}\n\nJules is actively generating code changes.`;
  const options = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📊 Check Status", callback_data: "cmd_status" }, { text: "🌐 Open Dashboard", url: "https://jules.sandeepbuilds.com" }]
      ]
    }
  };
  return bot.sendMessage(chatId, formatted, options);
}

/**
 * Sends an alert when a PR is created by Jules.
 */
export async function sendPRCreatedNotification(taskTitle, taskId, prUrl) {
  const formatted = `📝 PR Opened for Task #${taskId}\n\nTask: ${taskTitle}\nPR URL: ${prUrl}\n\nSupervisor is reviewing code changes...`;
  const options = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔗 Open PR on GitHub", url: prUrl }],
        [{ text: "📊 Check Status", callback_data: "cmd_status" }]
      ]
    }
  };
  return bot.sendMessage(chatId, formatted, options);
}

/**
 * Sends an alert when a task PR is merged into phase branch.
 */
export async function sendTaskMergedNotification(taskTitle, taskId, prUrl, phaseBranch, nextTaskTitle) {
  const formatted = `✅ Task #${taskId} Merged\n\nTask: ${taskTitle}\nPR URL: ${prUrl || 'N/A'}\nBranch: ${phaseBranch}\n\nMerged into the phase branch automatically. Please verify this phase before the final main merge.\n\n${nextTaskTitle ? `Next task starting: "${nextTaskTitle}"` : 'All phase tasks completed!'}`;
  const options = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📊 Check Status", callback_data: "cmd_status" }, { text: "🌐 Open Dashboard", url: "https://jules.sandeepbuilds.com" }]
      ]
    }
  };
  return bot.sendMessage(chatId, formatted, options);
}

/**
 * Sends an alert when all phase tasks are complete.
 */
export async function sendPhaseCompleteNotification(phaseBranch, phaseTitle) {
  const formatted = `🏁 Phase Complete\n\nPhase: ${phaseTitle}\n\nPhase tasks completed on branch \`${phaseBranch}\`.\nDraft PR to merge into develop/main is automatically created on GitHub. Please review and merge the PR!`;
  const options = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🌐 Open Dashboard", url: "https://jules.sandeepbuilds.com" }]
      ]
    }
  };
  return bot.sendMessage(chatId, formatted, options);
}

/**
 * Registers the webhook with the Telegram API.
 */
export async function setupWebhook(appUrl) {
  if (bot.setWebHook) {
    const webhookSecret = getPortalSecret();
    const hookUrl = `${appUrl}/api/webhook/telegram/${webhookSecret}`;
    console.log(`Setting Telegram Webhook to ${appUrl}/api/webhook/telegram/[redacted]`);
    await bot.setWebHook(hookUrl);
  }
}
