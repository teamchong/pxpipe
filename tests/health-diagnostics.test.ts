import { describe, expect, it } from 'vitest';
import { UpstreamDiagnostics } from '../src/node.js';

describe('UpstreamDiagnostics', () => {
  it('degrades after consecutive failures and recovers after cooldown', () => {
    let now = 100;
    const d = new UpstreamDiagnostics(3, 50, () => now);
    d.record(502); d.record(503);
    expect(d.degraded).toBe(false);
    d.record(500);
    expect(d.degraded).toBe(true);
    now = 151;
    expect(d.degraded).toBe(false);
  });

  it('resets the failure streak on success', () => {
    const d = new UpstreamDiagnostics(2, 100, () => 0);
    d.record(500); d.record(200); d.record(500);
    expect(d.degraded).toBe(false);
  });
});
