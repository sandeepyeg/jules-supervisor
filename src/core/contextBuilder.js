import { getPlanSections } from '../db/queries.js';

/**
 * Builds a formatted context string for the AI using active sprint plan sections and task metadata.
 */
export async function buildContext(task, sprintId) {
  const sections = await getPlanSections(sprintId);
  
  let contextSections = [];
  if (task.context_sections) {
    try {
      contextSections = typeof task.context_sections === 'string'
        ? JSON.parse(task.context_sections)
        : task.context_sections;
    } catch (error) {
      console.error(`Error parsing context_sections for task ${task.id}:`, error);
    }
  }

  let filteredSections = sections;
  if (Array.isArray(contextSections) && contextSections.length > 0) {
    filteredSections = sections.filter(s => contextSections.includes(s.section_key));
  }

  const formattedSections = filteredSections
    .map(s => `## ${s.section_key}\n${s.content}`)
    .join('\n\n');

  const taskDescription = `## Current task\n${task.title}\n\n${task.description}`;

  return formattedSections
    ? `${formattedSections}\n\n${taskDescription}`
    : taskDescription;
}
