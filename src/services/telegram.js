import TelegramBot from 'node-telegram-bot-api';
import EventEmitter from 'events';

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
    on: () => {}
  };
} else {
  const options = {};
  if (webhookUrl) {
    options.polling = false;
    console.log('Telegram Bot configured for Webhook mode.');
  } else {
    options.polling = true;
    console.log('Telegram Bot configured for Long-Polling mode.');
  }
  
  bot = new TelegramBot(token, options);

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
 * Registers the webhook with the Telegram API.
 */
export async function setupWebhook(appUrl) {
  if (bot.setWebHook) {
    const webhookSecret = process.env.PORTAL_SECRET || 'default_webhook_secret';
    const hookUrl = `${appUrl}/api/webhook/telegram/${webhookSecret}`;
    console.log(`Setting Telegram Webhook to: ${hookUrl}`);
    await bot.setWebHook(hookUrl);
  }
}
