/**
 * Deterministic prompt-injection detector. It runs on every report before the AI call and
 * its findings become verification flags regardless of what the model returns. Detection is
 * a signal for the reviewer, not the protection itself: the protection is that the model has
 * no tools, its output is schema-validated, and a human must approve.
 */

export interface InjectionFinding {
  rule: string;
  excerpt: string;
}

const RULES: { rule: string; re: RegExp }[] = [
  { rule: 'override_instructions', re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|system|your)\b[^.\n]{0,20}\b(instructions?|rules?|prompts?|guidelines?)/i },
  { rule: 'role_change', re: /\b(you are now|from now on you|act as|pretend (to be|you are)|new instructions?)\b/i },
  { rule: 'approval_manipulation', re: /\b(auto-?approve|approve (this|the|my) (report|handover)|mark (it|this|everything|all( issues)?) (as )?(approved|resolved|safe|verified)|no need (for|to) (review|verif|check))/i },
  { rule: 'skip_review', re: /\b(skip|bypass|do not|don'?t)\b[^.\n]{0,20}\b(review|verification|flag|human|supervisor)\b/i },
  { rule: 'secret_exfiltration', re: /\b(reveal|print|show|output|repeat)\b[^.\n]{0,30}\b(system prompt|instructions|api key|secret|password|token|prompt)\b/i },
  { rule: 'delimiter_tampering', re: /<\/?\s*(raw_input|system|instructions?|open_issues|approved_records|assistant|user)\s*>/i },
  { rule: 'output_tampering', re: /("requires_human_review"\s*:\s*false|"report_id"\s*:|```json|respond only with)/i },
];

export function detectInjection(text: string): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  for (const { rule, re } of RULES) {
    const m = re.exec(text);
    if (!m) continue;
    // Widen to whole words so the reviewer sees a readable quote.
    let start = Math.max(0, m.index - 30);
    let end = Math.min(text.length, m.index + m[0].length + 30);
    while (start > 0 && /\S/.test(text[start - 1]!)) start -= 1;
    while (end < text.length && /\S/.test(text[end]!)) end += 1;
    findings.push({ rule, excerpt: text.slice(start, end).replace(/\s+/g, ' ').trim() });
  }
  return findings;
}
