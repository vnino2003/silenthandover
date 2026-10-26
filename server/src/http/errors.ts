import type { ZodError } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

const STATUS_BY_CODE: Record<string, number> = {
  not_found: 404,
  forbidden: 403,
  not_assigned: 403,
  window_not_open: 409,
  window_closed: 409,
  shift_cancelled: 409,
  already_submitted: 409,
  not_editable: 409,
  invalid_state: 409,
  invalid_transition: 409,
  conflict: 409,
  immutable: 409,
  flags_unresolved: 422,
  validation: 422,
};

interface PgLikeError {
  message?: string;
  detail?: string;
  code?: string;
}

/** Converts database errors into safe API errors. Unknown errors never leak their text. */
export function fromDbError(err: unknown): ApiError | null {
  const e = err as PgLikeError;
  if (typeof e?.message === 'string' && e.message.startsWith('SH:')) {
    const code = e.message.slice(3);
    return new ApiError(STATUS_BY_CODE[code] ?? 400, code, e.detail || 'Request could not be completed');
  }
  if (e?.code === '42501') return new ApiError(403, 'forbidden', 'You do not have permission to do that');
  if (e?.code === '23505') return new ApiError(409, 'conflict', 'That record already exists');
  if (e?.code === '23514' || e?.code === '22P02' || e?.code === '22007' || e?.code === '22008') {
    return new ApiError(422, 'validation', 'Some values are invalid');
  }
  return null;
}

export function fromZodError(err: ZodError): ApiError {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  return new ApiError(422, 'validation', 'Please correct the highlighted fields', fields);
}
