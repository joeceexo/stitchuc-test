import type { PublicConfig, Result, StaffDetail } from '../../server/src/types';

export interface SiteConfig extends PublicConfig {
  link: { company: string; office: string | null } | null;
  linkMissing: boolean;
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public body: any) { super(message); }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: init?.signal, cache: 'no-store', credentials: 'same-origin',
  });
  let body: any = null;
  try { body = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new ApiError(body?.error ?? 'Something went wrong. Please try again.', res.status, body);
  return body as T;
}

export const getConfig = (link?: string) => api<SiteConfig>(`/api/config${link ? `?link=${encodeURIComponent(link)}` : ''}`);
export const getResult = (code: string) => api<Result>(`/api/results/${encodeURIComponent(code)}`);

export interface StaffRow { code: string; company: string | null; office: string | null; origin: string; verdict: 'good' | 'fair' | 'poor'; worst: string | null; provider: string | null; created_at: string }
export interface StaffLink { slug: string; url: string; company: string; office: string | null; created_at: string; tests: number }
export type { Result, StaffDetail };
