// Reactive stores for each dashboard panel. The polling cadence matches the
// legacy dashboard exactly: 2s for the live counters + recent table,
// 5s for the slower aggregates. The Svelte stores are dev-time only — the
// proxy still serves a single static HTML string at runtime (built by
// scripts/build-dashboard-ui.mjs from these sources).

import { writable } from 'svelte/store';
import { pollJson } from './poll.js';
import type {
  StatsPayload,
  RecentPayload,
  SessionsPayload,
  FullStatsPayload,
  CurrentSessionPayload,
} from '../types.js';

// Live counters + recent table (legacy poll cadence: 2s).
export const stats = pollJson<StatsPayload>('/proxy-stats', 2000);
export const recent = pollJson<RecentPayload>('/proxy-recent', 2000);

// Slower endpoints (legacy: 5s).
export const sessions = pollJson<SessionsPayload>('/api/sessions.json', 5000);
export const fullStats = pollJson<FullStatsPayload>('/api/stats.json', 5000);
export const currentSession = pollJson<CurrentSessionPayload>('/api/current-session.json', 2000);

// when null the image viewer follows the latest render; when set it pins that image id. ui-only state.
export const selectedImageId = writable<number | null>(null);

// Toast-style messages for confirm/error feedback. Components can push and
// the App-level component renders them. Tiny on purpose — full toast library
// would blow the zero-dep budget.
export interface Toast {
  id: number;
  level: 'info' | 'error';
  text: string;
}
function makeToastStore() {
  const { subscribe, update } = writable<Toast[]>([]);
  let nextId = 1;
  return {
    subscribe,
    push(level: Toast['level'], text: string) {
      const id = nextId++;
      update((arr) => [...arr, { id, level, text }]);
      setTimeout(() => update((arr) => arr.filter((t) => t.id !== id)), 5000);
    },
    dismiss(id: number) {
      update((arr) => arr.filter((t) => t.id !== id));
    },
  };
}
export const toasts = makeToastStore();
