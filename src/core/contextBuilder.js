import { getPhase } from '../db/queries.js';

/**
 * Builds the AI instruction context combining global Phase Goals and the current Task Description.
 */
export async function buildContext(task, phaseId) {
  const phase = await getPhase(phaseId);
  if (!phase) {
    throw new Error(`Phase #${phaseId} not found in database`);
  }

  const context = `## Phase Goals & Context\n${phase.description || ''}`;
  const taskDescription = `## Current task\n${task.title}\n\n${task.description}`;

  return `${context}\n\n${taskDescription}`;
}
