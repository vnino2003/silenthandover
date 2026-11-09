import type { AssistantPageContext, Role } from '@sh/shared';
export interface MicaSuggestion { label:string; message:string; kind?:'prepare'|'leave' }
export function micaSuggestions(page:AssistantPageContext,role:Role|null):MicaSuggestion[] {
  if(page==='my_schedule') return [{label:'My upcoming shifts',message:'When are my shifts this week?'},{label:'My leave status',message:'What is my upcoming leave status?'},{label:'Prepare leave',message:'Prepare leave',kind:'leave'}];
  if(page==='leave') return [{label:'Prepare leave',message:'Prepare leave',kind:'leave'},{label:'My leave status',message:'What is my leave status?'}];
  if(page==='leave_requests') return [{label:'Pending decisions',message:'Which leave requests need my decision?'},{label:'Check coverage',message:'What is the staffing coverage this week?'},{label:'Explain the process',message:'Explain how leave decisions work'}];
  if(page==='review') return [{label:'What needs attention?',message:'What needs my decision in this review?'},{label:'Explain the review',message:'Explain how I should review a shift endorsement'}];
  if(page==='schedule') return [{label:'Coverage this week',message:'Which shifts are short this week?'},{label:'Explain scheduling',message:'Explain how schedules and coverage work'}];
  if(role==='employee') return [{label:'Prepare my endorsement',message:'I want to prepare my shift endorsement',kind:'prepare'},{label:'Record a concern',message:'I want to report an incident',kind:'prepare'},{label:'Help with this page',message:'How do I use this page?'}];
  if(role==='admin') return [{label:'Hospital status',message:'What do the current records show?'},{label:'Help with this page',message:'How do I use this page?'}];
  return [{label:'Help with this page',message:'How do I use this page?'},{label:'What needs attention?',message:'What needs my attention?'}];
}
