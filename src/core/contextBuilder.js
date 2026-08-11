import { getPhase } from '../db/queries.js';

/**
 * AI Task Prompt Synthesizer & Context Injector
 * Builds a precision prompt combining Phase Goals, target domain modules, and execution boundaries
 * to ensure Jules writes correct code in the right files on the first attempt.
 */
export async function buildContext(task, phaseId) {
  const phase = await getPhase(phaseId);
  const phaseBranch = phase ? phase.phase_branch || 'phase branch' : 'phase branch';
  const phaseDescription = phase?.description || '';

  // Extract domain keywords to assist Jules in identifying target scope
  const combinedText = `${task.title} ${task.description || ''}`.toLowerCase();
  const domainKeywords = [];

  if (combinedText.includes('lead') || combinedText.includes('beta') || combinedText.includes('demo') || combinedText.includes('newsletter')) {
    domainKeywords.push('- Target Scope: Public Conversion & Lead Management (apps/api/src/.../Leads, apps/web/src/.../leads or public features)');
  }
  if (combinedText.includes('seo') || combinedText.includes('ssr') || combinedText.includes('meta') || combinedText.includes('sitemap')) {
    domainKeywords.push('- Target Scope: SEO & Discoverability (apps/web/src/app/seo, metadata headers, sitemap endpoints)');
  }
  if (combinedText.includes('crs') || combinedText.includes('calculator') || combinedText.includes('tool') || combinedText.includes('points')) {
    domainKeywords.push('- Target Scope: Public Tools & CRS Calculators (apps/web/src/.../tools, CrsScore calculation services)');
  }
  if (combinedText.includes('data') || combinedText.includes('ingestion') || combinedText.includes('radar') || combinedText.includes('official')) {
    domainKeywords.push('- Target Scope: Official Data Ingestion Pipeline (apps/api/src/.../Ingestion, FormRadar background workers)');
  }
  if (combinedText.includes('product') || combinedText.includes('feature') || combinedText.includes('marketing') || combinedText.includes('page')) {
    domainKeywords.push('- Target Scope: Product & Marketing Pages (apps/web/src/app/features/public/product)');
  }

  const domainScopeText = domainKeywords.length > 0
    ? `\n\n🎯 RECOMMENDED DOMAIN MODULE SCOPE:\n${domainKeywords.join('\n')}`
    : '';

  const prompt = `${task.title}

${task.description || ''}

Target branch: ${phaseBranch}
Open your pull request against ${phaseBranch}.
${domainScopeText}

📋 PHASE OVERVIEW & CONSTRAINTS:
${phaseDescription}

⚡ STRICT EXECUTION BOUNDARIES & INSTRUCTIONS:
- Do NOT open PRs against main or develop. Open PR strictly against ${phaseBranch}.
- Focus exclusively on clean, modular implementation of THIS specific task requirement.
- Do NOT modify unrelated project files, Directory.Build.props, or unrelated domain models outside this task's scope.
- Proceed directly to implementation and code execution. Implement changes, commit, push, and open the Pull Request against ${phaseBranch} immediately.`;

  return prompt;
}
