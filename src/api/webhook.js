import express from 'express';
import * as questionHandler from '../core/questionHandler.js';

const router = express.Router();

/**
 * POST /api/webhook/telegram
 * Handles incoming webhooks from the Telegram Bot API when using webhook mode.
 */
router.post('/telegram', async (req, res) => {
  try {
    const update = req.body;
    
    if (update && update.message) {
      const message = update.message;
      
      // Filter out messages from unauthorized chats for security
      const authorizedChatId = process.env.TELEGRAM_CHAT_ID;
      if (authorizedChatId && String(message.chat.id) !== String(authorizedChatId)) {
        console.warn(`Blocked incoming Telegram webhook from unauthorized chat ID: ${message.chat.id}`);
        return res.status(200).send('OK');
      }

      // Check if message is a reply to another message
      if (message.reply_to_message && message.text) {
        await questionHandler.handleTelegramReply(
          message.reply_to_message.message_id,
          message.text
        );
      }
    }
  } catch (error) {
    console.error('Error handling Telegram webhook payload:', error);
  }
  
  // Always respond with 200 OK immediately to acknowledge receipt of webhook from Telegram
  res.status(200).send('OK');
});

export default router;
