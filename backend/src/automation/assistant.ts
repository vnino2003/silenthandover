import { AssistantState, assistantMissing } from '@sh/shared';

/** A deliberately bounded fallback: collects answers in order without pretending to be AI. */
export function guidedReply(message: string, previous: AssistantState): AssistantState {
  const s = structuredClone(previous);
  const text = message.trim();
  if (s.intent === 'unsupported' || s.intent === 'status') {
    s.intent = /\b(status|my reports|progress|check reports)\b/i.test(text) ? 'status'
      : /\b(incident|report an issue|report a problem|hazard)\b/i.test(text) ? 'incident'
        : /\b(help|assistance|support)\b/i.test(text) && !/\breport\b/i.test(text) ? 'assistance'
          : /\b(update|task|ISS-\d+)\b/i.test(text) ? 'task_update'
            : /\b(report|shift|completed|finished)\b/i.test(text) ? 'report' : 'unsupported';
    // Intent selection itself never becomes an answer to a required question.
    return s;
  }
  if (s.intent === 'report') {
    const c = s.content;
    if (c.completed_work.length < 3) c.completed_work = text.slice(0, 4000);
    else if (!c.no_unresolved_issues && !c.problems.length && c.unresolved_issues.length < 3) {
      c.no_unresolved_issues = /^(no|none|no (open )?(problems|issues|tickets))[.!]?$/i.test(text);
      if (!c.no_unresolved_issues) c.unresolved_issues = text.slice(0, 4000);
    } else if (!c.no_pending_tasks && c.pending_tasks.length < 3) {
      c.no_pending_tasks = /^(no|none|nothing|no (pending )?tasks)[.!]?$/i.test(text);
      if (!c.no_pending_tasks) c.pending_tasks = text.slice(0, 4000);
    } else c.handover_notes = [c.handover_notes, text].filter(Boolean).join('\n').slice(0, 3000);
  } else if (s.intent === 'incident' || s.intent === 'assistance') {
    if (s.title.length < 3) s.title = text.slice(0, 160);
    else s.description = [s.description, text].filter(Boolean).join('\n').slice(0, 2000);
  } else if (s.intent === 'task_update') {
    const code = text.match(/\bISS-\d+\b/i)?.[0]?.toUpperCase();
    if (code) s.issue_code = code;
    else s.note = text.slice(0, 2000);
    if (/\b(fixed|finished|completed|done)\b/i.test(text)) s.transition = 'resolution_submitted';
  }
  return AssistantState.parse(s);
}

export function nextQuestion(s: AssistantState): string {
  if (s.intent === 'report') {
    if (s.content.completed_work.length < 3) return 'What did you complete this shift? Include quantities or references if you have them.';
    if (!s.content.no_unresolved_issues && !s.content.problems.length && s.content.unresolved_issues.length < 3) return 'What problems are still open? Say “none” if there are no open problems.';
    if (!s.content.no_pending_tasks && s.content.pending_tasks.length < 3) return 'What must the next shift do? Say “none” if there are no pending tasks.';
  }
  if (s.intent === 'leave' && !assistantMissing(s).length) return 'Your leave dates are ready. Open the Leave form to check them, add a reason if needed, and submit.';
  return assistantMissing(s)[0] ?? 'Your summary is ready. Review and edit it, then confirm when it is accurate.';
}
