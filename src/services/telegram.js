import TelegramBot from 'node-telegram-bot-api';
import EventEmitter from 'events';
import { getPortalSecret } from '../api/auth.js';
import { pool } from '../db/connection.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;

export const telegramEmitter = new EventEmitter();

export const TELEGRAM_MAIN_KEYBOARD = {
  keyboard: [
    [{ text: "📊 Live Status" }, { text: "⏭ Skip Active Task" }],
    [{ text: "⏸ Pause Poller" }, { text: "▶️ Resume Poller" }]
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

if (!token || token.startsWith('your_')) {
  console.warn('WARNING: TELEGRAM_BOT_TOKEN is not defined or is a placeholder. Telegram service running in mock mode.');
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

    // 2. Pause Poller Button
    if (text === '⏸ Pause Poller') {
      try {
        const [phases] = await pool.query("SELECT * FROM phases WHERE status = 'active' ORDER BY id DESC LIMIT 1");
        const phase = phases[0];
        if (!phase) {
          await bot.sendMessage(chatId, "ℹ️ No active phase running to pause.", { reply_markup: TELEGRAM_MAIN_KEYBOARD });
          return;
        }
        const poller = await import('../core/poller.js');
        poller.stopPoller(phase.id);
        await bot.sendMessage(chatId, `⏸ Supervisor poller paused for Phase "${phase.title}".`, {
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
        const [phases] = await pool.query("SELECT * FROM phases WHERE status = 'active' ORDER BY id DESC LIMIT 1");
        const phase = phases[0];
        if (!phase) {
          await bot.sendMessage(chatId, "ℹ️ No active phase found to resume.", { reply_markup: TELEGRAM_MAIN_KEYBOARD });
          return;
        }
        const poller = await import('../core/poller.js');
        poller.startPoller(phase.id);
        await bot.sendMessage(chatId, `▶️ Supervisor poller resumed for Phase "${phase.title}".`, {
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
  return bot.sendMessage(chatId, formatted, { reply_to_message_id: originalMessageId });
}

/**
 * Sends a general notification message.
 */
export async function sendNotification(text) {
  return bot.sendMessage(chatId, text);
}

/**
 * Sends an alert when a Jules task PR is blocked.
 */
export async function sendPRBlockedNotification({ taskTitle, prUrl, riskLevel, blockingReason, julesFix }) {
  const formatted = `🚨 PR Blocked by Supervisor\n\nTask: ${taskTitle}\nPR URL: ${prUrl}\nRisk Level: ${riskLevel}\nReason: ${blockingReason}\nJules Instruction: ${julesFix}`;
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
export async function sendPRReadyNotification({ taskTitle, prUrl }) {
  const formatted = `✅ PR Ready for Review\n\nTask: ${taskTitle}\nPR URL: ${prUrl}\n\nTask PR appears ready for human review/merge into phase branch.`;
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
  const formatted = `✅ Task #${taskId} Merged\n\nTask: ${taskTitle}\nPR URL: ${prUrl || 'N/A'}\nBranch: ${phaseBranch}\n\n${nextTaskTitle ? `Next task starting: "${nextTaskTitle}"` : 'All phase tasks completed!'}`;
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
  const formatted = `🏁 Phase Complete\n\nPhase: ${phaseTitle}\n\nPhase complete. Review branch ${phaseBranch}. Human should manually create/review/merge final PR into main.`;
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
