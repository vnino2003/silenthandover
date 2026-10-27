/**
 * Prompt templates with named fields: `{{field}}` or `{{field | "fallback"}}`.
 *
 * When a field is blank (the employee left it empty, or a list has no items) the fallback is
 * used instead, so the model always sees an explicit "(none stated)" rather than a gap it might
 * fill in by guessing. Values are inserted in a single pass, so text an employee types that
 * looks like `{{...}}` is never treated as another field.
 */
export interface TemplateField {
  name: string;
  /** The text used when the value is blank, or null when the field has no fallback. */
  fallback: string | null;
  usedFallback: boolean;
  value: string;
}

export interface FilledTemplate {
  text: string;
  fields: TemplateField[];
}

const FIELD = /\{\{\s*([a-z_]+)\s*(?:\|\s*"([^"]*)"\s*)?\}\}/g;

export function fillTemplate(template: string, values: Record<string, string | null | undefined>): FilledTemplate {
  const fields: TemplateField[] = [];
  const text = template.replace(FIELD, (_match, name: string, fallback: string | undefined) => {
    const raw = values[name] ?? '';
    const blank = raw.trim() === '';
    const value = blank ? (fallback ?? '') : raw;
    fields.push({ name, fallback: fallback ?? null, usedFallback: blank && fallback !== undefined, value });
    return value;
  });
  return { text, fields };
}

/** The field names a template uses, in order (for showing the template itself). */
export function templateFields(template: string): { name: string; fallback: string | null }[] {
  return [...template.matchAll(FIELD)].map((m) => ({ name: m[1]!, fallback: m[2] ?? null }));
}
