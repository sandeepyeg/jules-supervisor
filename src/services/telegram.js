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

    if (typeof bot.deleteWebhook === 'function') {
      bot.deleteWebhook({ drop_pending_updates: true })
        .then(() => {
          bot.startPolling();
          console.log('Telegram Bot configured for Long-Polling mode (stale sessions cleared).');
        })
        .catch((err) => {
          console.error('Failed to clear Telegram webhook before polling:', err.message);
          bot.startPolling();
        });
    } else {
      bot.startPolling();
      console.log('Telegram Bot configured for Long-Polling mode.');
    }

    // Silence 409 Conflict spams cleanly
    bot.on('polling_error', (error) => {
      if (error.message && error.message.includes('409 Conflict')) {
        console.log('Telegram Bot: Connection conflict (409) detected during watch restart. Suppressing trace logs; retrying...');
      } else {
        console.error('Telegram Bot Polling Error:', error);
      }
    });
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

  // Clean shutdown on process exit to avoid 409 conflict on node --watch restarts
  const cleanExit = async () => {
    try {
      if (bot && typeof bot.stopPolling === 'function') {
        await bot.stopPolling();
      }
    } catch (e) {}
    process.exit(0);
  };
  process.once('SIGINT', cleanExit);
  process.once('SIGTERM', cleanExit);
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
