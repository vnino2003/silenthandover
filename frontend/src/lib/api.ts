import { isNative } from './native';

const BUILT_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
const BASE_KEY = 'sh.apiBase';

/**
 * The API address. Web: the build's VITE_API_URL (empty = same origin). Android app: an HTTPS address
 * the person saved on the connection screen, else the one built in.
 */
export function apiBase(): string {
  if (!isNative) return BUILT_BASE;
  try {
    return (localStorage.getItem(BASE_KEY) || BUILT_BASE).replace(/\/$/, '');
  } catch {
    return BUILT_BASE;
  }
}
/** Saves the Android app's server address. Only HTTPS is accepted. */
export function setApiBase(url: string): string | null {
  const value = url.trim().replace(/\/$/, '');
  if (!/^https:\/\/[^\s/]+(\/.*)?$/i.test(value)) return 'Enter the server’s https:// address.';
  try {
    localStorage.setItem(BASE_KEY, value);
  } catch {
    return 'The address could not be saved on this device.';
  }
  return null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: Record<string, string> = {},
    readonly requestId?: string,
  ) {
    super(message);
  }
}

type TokenSource = () => Promise<string | null>;
let tokenSource: TokenSource = async () => null;
let onUnauthorized: () => void = () => {};

export function configureApi(opts: { token: TokenSource; onUnauthorized: () => void }) {
  tokenSource = opts.token;
  onUnauthorized = opts.onUnauthorized;
}

export async function request<T>(method: string, path: string, body?: unknown, options?: { signal?: AbortSignal }): Promise<T> {
  const headers: Record<string, string> = {};
  const token = await tokenSource();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: options?.signal });
  } catch (e) {
    if (options?.signal?.aborted) throw e;
    throw new ApiError(0, 'network', 'Can’t reach the server. Check your connection and try again.');
  }
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; fields?: Record<string, string>; request_id?: string } })?.error;
    if (res.status === 401 && path !== '/auth/login') onUnauthorized();
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? 'Something went wrong', err?.fields ?? {}, err?.request_id);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown, options?: { signal?: AbortSignal }) => request<T>('POST', path, body ?? {}, options),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

/** Binary download with the session token (for <img> sources that need authentication). */
export async function fetchBlob(path: string): Promise<Blob> {
  const token = await tokenSource();
  const res = await fetch(`${apiBase()}/api${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(res.status, 'error', 'Could not load the file');
  return res.blob();
}

export function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong';
}
