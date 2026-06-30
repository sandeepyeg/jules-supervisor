import TelegramBot from 'node-telegram-bot-api';
import EventEmitter from 'events';
import { getPortalSecret } from '../api/auth.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;

export const telegramEmitter = new EventEmitter();

let bot;

if (!token || token.startsWith('your_')) {
  console.warn('WARNING: TELEGRAM_BOT_TOKEN is not defined or is a placeholder. Telegram service running in mock mode.');
  bot = {
    sendMessage: async (cid, text, options) => {
      console.log(`[Mock Telegram] Send to ${cid || chatId}: ${text}`, options || '');
      return { message_id: Math.floor(Math.random() * 1000000000) };
    },
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
    // Webhook mode: disable polling entirely
    bot = new TelegramBot(token, { polling: false });
    console.log('Telegram Bot configured for Webhook mode.');
  } else {
    // Long-polling mode: first create the bot without polling, clear any stale
    // sessions from Telegram's side (prevents 409 Conflict on restart), then
    // start polling cleanly.
    bot = new TelegramBot(token, { polling: false });

    // Silently swallow 409 Conflict — these fire during node --watch restart
    // while the old process is still dying. The library retries automatically.
    bot.on('polling_error', (error) => {
      if (error.message && error.message.includes('409 Conflict')) {
        // intentionally silent — this is expected during hot-reload
      } else {
        console.error('Telegram Bot Polling Error:', error);
      }
    });

    // node --watch sends SIGUSR2 to kill the old process. We must stop polling
    // before the new instance tries to connect, otherwise both fight for the
    // same Telegram long-polling slot and produce 409 conflicts.
    const stopAndExit = async (signal) => {
      try {
        await bot.stopPolling();
      } catch (_) {}
      process.kill(process.pid, signal);
    };

    process.once('SIGUSR2', () => stopAndExit('SIGUSR2'));
    process.once('SIGINT',  async () => { try { await bot.stopPolling(); } catch (_) {} process.exit(0); });
    process.once('SIGTERM', async () => { try { await bot.stopPolling(); } catch (_) {} process.exit(0); });

    // Small startup delay so the previous instance finishes releasing the
    // Telegram polling connection before we open a new one.
    setTimeout(() => {
      bot.startPolling();
      console.log('Telegram Bot configured for Long-Polling mode.');
    }, 1500);
  }

  bot.on('message', (msg) => {
    // Only accept messages from your specific chat ID for security
    if (chatId && String(msg.chat.id) !== String(chatId)) {
      console.warn(`Blocked incoming Telegram message from unauthorized chat ID: ${msg.chat.id}`);
      return;
    }
    if (msg.reply_to_message) {
      telegramEmitter.emit('reply', {
        replyToMessageId: msg.reply_to_message.message_id,
        text: msg.text
      });
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
  return bot.sendMessage(chatId, formatted);
}

/**
 * Sends an alert when a PR is approved but auto-merge is disabled (or blocked by risk/checks).
 */
export async function sendPRReadyNotification({ taskTitle, prUrl }) {
  const formatted = `✅ PR Ready for Review\n\nTask: ${taskTitle}\nPR URL: ${prUrl}\n\nTask PR appears ready for human review/merge into phase branch.`;
  return bot.sendMessage(chatId, formatted);
}

/**
 * Sends an alert when all phase tasks are complete.
 */
export async function sendPhaseCompleteNotification(phaseBranch, phaseTitle) {
  const formatted = `🏁 Phase Complete\n\nPhase: ${phaseTitle}\n\nPhase complete. Review branch ${phaseBranch}. Human should manually create/review/merge final PR into main.`;
  return bot.sendMessage(chatId, formatted);
}

/**
 * Registers the webhook with the Telegram API.
 */
export async function setupWebhook(appUrl) {
  if (bot.setWebHook) {
    const webhookSecret = getPortalSecret();
    const hookUrl = `${appUrl}/api/webhook/telegram/${webhookSecret}`;
    console.log(`Setting Telegram Webhook to: ${hookUrl}`);
    await bot.setWebHook(hookUrl);
  }
}
