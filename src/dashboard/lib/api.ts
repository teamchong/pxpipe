// Fetch helpers + endpoint URL constants + mutation wrappers.
//
// The dashboard talks to the same Node host that serves it, so all URLs are
// path-relative. The handlers live in `src/dashboard.ts` — keep this file in
// sync with the routing table there.

import type {
  CompressionToggleResponse,
} from '../types.js';

export const API = {
  stats: '/proxy-stats',
  recent: '/proxy-recent',
  latestPng: '/proxy-latest-png',
  sessions: '/api/sessions.json',
  fullStats: '/api/stats.json',
  currentSession: '/api/current-session.json',
  compressionToggle: '/api/compression',
} as const;

/** Fetch JSON or throw. Errors propagate so stores can surface them. */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    // Try to surface server error JSON if it exists; fall back to status.
    let body = '';
    try {
      body = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(
      `${url}: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`,
    );
  }
  return res.json() as Promise<T>;
}

/** POST JSON helper. */
export async function postJson<T>(url: string, body: unknown): Promise<T> {
  return fetchJson<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function setCompressionEnabled(enabled: boolean): Promise<CompressionToggleResponse> {
  return postJson<CompressionToggleResponse>(API.compressionToggle, { enabled });
}
