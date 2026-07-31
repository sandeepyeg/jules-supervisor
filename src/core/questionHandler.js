import {
  updateTaskStatus,
  createTelegramPending,
  logQA,
  getTelegramPendingByMessageId,
  resolveTelegramPending,
  getTask
} from '../db/queries.js';
import { buildContext } from './contextBuilder.js';
import * as jules from '../services/jules.js';
import * as telegram from '../services/telegram.js';
import * as ai from '../services/ai.js';
import { telegramEmitter } from '../services/telegram.js';

const AI_CONFIDENCE_THRESHOLD = parseInt(process.env.AI_CONFIDENCE_THRESHOLD || '7', 10);

/**
 * Handles an agent question activity, choosing between AI auto-answering and Telegram escalation.
 */
export async function handleQuestion(task, question, activityId) {
  console.log(`Handling question for task #${task.id} ("${task.title}"). Activity ID: ${activityId}`);
  
  // 1. Update task: last_activity_id = activityId, status = 'waiting_answer'
  await updateTaskStatus(task.id, 'waiting_answer', {
    last_activity_id: activityId
  });

  // 2. If task mode is manual, escalate immediately
  if (task.mode === 'manual') {
    console.log(`Task #${task.id} is in manual mode. Escalating directly to Telegram.`);
    const sentMsg = await telegram.sendEscalation(task.title, task.id, question);
    await createTelegramPending(task.id, question, sentMsg.message_id);
    return { escalated: true };
  }

  // 3. Build context
  const context = await buildContext(task, task.phase_id);

  // 4. Consult AI with confidence threshold
  console.log(`Consulting AI with confidence threshold ${AI_CONFIDENCE_THRESHOLD}...`);
  let result = null;
  try {
    result = await ai.askWithConfidence(context, question);
    console.log(`AI Confidence: ${result.confidence}/10. Reason: ${result.reason}`);
  } catch (aiErr) {
    console.error(`AI service error during askWithConfidence:`, aiErr.message);
    result = { confidence: 0, answer: '', reason: aiErr.message };
  }

  // 5. Check if confidence meets threshold
  if (result && result.confidence >= AI_CONFIDENCE_THRESHOLD && result.answer && result.answer.trim().length > 0) {
    console.log(`AI confidence meets threshold. Auto-answering Jules session.`);
    await jules.sendMessage(task.jules_session_id, result.answer);
    
    // Log to QA log
    await logQA(task.id, question, result.answer, result.provider || 'ai', result.confidence);
    
    // Update task back to running
    await updateTaskStatus(task.id, 'running');
    
    return { escalated: false, answer: result.answer };
  } else {
    const reasonText = result ? (result.confidence < AI_CONFIDENCE_THRESHOLD ? `Low AI Confidence: ${result.confidence}/10` : 'AI Error') : 'Escalated';
    console.log(`AI confidence insufficient (${reasonText}). Escalating to Telegram.`);
    
    const sentMsg = await telegram.sendEscalation(
      `${task.title} (${reasonText})`,
      task.id,
      question
    );
    
    await createTelegramPending(task.id, question, sentMsg.message_id);
    
    // Log to QA log
    await logQA(task.id, question, `[Escalated] ${result?.answer || ''}`, 'telegram', result?.confidence || 0);
    
    return { escalated: true };
  }
}

/**
 * Handles incoming developer replies via Telegram.
 */
export async function handleTelegramReply(replyToMessageId, answerText) {
  console.log(`Received Telegram reply for message ID: ${replyToMessageId}`);
  
  // 1. Load pending record
  const pending = await getTelegramPendingByMessageId(replyToMessageId);
  if (!pending) {
    console.log(`No active telegram_pending found for reply message ID: ${replyToMessageId}. Ignoring.`);
    return;
  }

  // 2. Load task
  const task = await getTask(pending.task_id);
  if (!task) {
    console.warn(`Task #${pending.task_id} not found for pending Telegram response.`);
    return;
  }

  console.log(`Answering Jules for task #${task.id} ("${task.title}"): ${answerText}`);
  
  // 3. Send answer to Jules
  await jules.sendMessage(task.jules_session_id, answerText);

  // 4. Log to QA log
  await logQA(task.id, pending.jules_question, answerText, 'telegram', null);

  // 5. Resolve pending Telegram record
  await resolveTelegramPending(pending.id);

  // 6. Update task status back to running
  await updateTaskStatus(task.id, 'running');
  
  console.log(`Telegram reply processed successfully for task #${task.id}.`);
}

// Bind incoming replies from telegram emitter
telegramEmitter.on('reply', async ({ replyToMessageId, text }) => {
  try {
    await handleTelegramReply(replyToMessageId, text);
  } catch (error) {
    console.error('Error in Telegram reply handler event:', error);
  }
});
