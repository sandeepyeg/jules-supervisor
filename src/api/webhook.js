import express from 'express';
import * as questionHandler from '../core/questionHandler.js';

const router = express.Router();

/**
 * Common handler for incoming webhooks from the Telegram Bot API.
 */
const handleUpdate = async (req, res) => {
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
};

/**
 * Secure Endpoint with path-based secret token matching.
 */
router.post('/telegram/:secret', (req, res, next) => {
  const portalSecret = process.env.PORTAL_SECRET;
  if (portalSecret && portalSecret !== 'choose_a_random_string' && req.params.secret !== portalSecret) {
    console.warn('Blocked Telegram webhook call: Invalid secret token in URL path.');
    return res.status(403).send('Forbidden');
  }
  next();
}, handleUpdate);

/**
 * Fallback/Legacy Endpoint (returns 403 if PORTAL_SECRET is set but path token is missing).
 */
router.post('/telegram', (req, res, next) => {
  const portalSecret = process.env.PORTAL_SECRET;
  if (portalSecret && portalSecret !== 'choose_a_random_string') {
    console.warn('Blocked unauthenticated Telegram webhook call: Missing secret path token.');
    return res.status(403).send('Forbidden');
  }
  next();
}, handleUpdate);

export default router;
