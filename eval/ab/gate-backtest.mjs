#!/usr/bin/env node
// Cache-aware realized-savings reconciliation + gate-policy back-test, straight
// from the proxy log. Answers "when does pxpipe actually save vs cost tokens, and
// could a smarter gate avoid the losses?" — re-run this per model release (the
// reconciliation node.ts asks for before wiring a live-feedback gate).
//
// Streams the log (works on a multi-GB events.jsonl; unlike ab/savings.mjs which
// slurps the whole file — fine for small A/B logs, not the full production log).
//
// Scoring is faithful and mirrors src/core/baseline.ts exactly:
//   actual_eff   = input + cc·1.25 + cr·0.1            (what pxpipe's imaged request paid)
//   baseline_eff = cache-aware cost of the SAME body as TEXT (the count_tokens
//                  counterfactual, priced warm/cold by this turn's observed cr)
//   saved        = baseline_eff − actual_eff           (<0 ⇒ imaging COST tokens)
// Sessions are reconstructed by first_user_sha8 + ts order so warm/cold and the
// reused/grown prefix split match what the proxy computes live.
//
// The policy frontier scores hypothetical gates by replaying each row:
//   image  -> realized actual_eff (from the row)
//   pass   -> text baseline_eff   (what NOT imaging would have cost)
// DECISION inputs are limited to what the proxy has at transform time: block size
// (orig_chars) and PRIOR-turn warmth/size. This is what makes it an honest test of
// a shippable rule, not an oracle. Finding (2026-07, several-thousand-row samples):
// losses run ~4% of net savings, ~100% warm + large, and are NOT separable from
// winners at decision time —
// every passthrough rule that catches losers destroys 10–50× more in winners, so a
// risk-gated passthrough backfires. Don't ship one; fix churn at the source instead.
//
//   node eval/ab/gate-backtest.mjs                 # ~/.pxpipe/events.jsonl (or $PXPIPE_LOG)
//   node eval/ab/gate-backtest.mjs <log> [family]  # e.g. ... events.jsonl fable
//
// Pure Node built-ins; keeps CACHE_* rates in sync with src/core/baseline.ts.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const CACHE_CREATE_RATE = 1.25; // src/core/baseline.ts
const CACHE_READ_RATE = 0.1;
const TTL_SEC = 300;

const logFile = process.argv[2] || process.env.PXPIPE_LOG || path.join(os.homedir(), '.pxpipe', 'events.jsonl');
const family = (process.argv[3] || 'fable').toLowerCase(); // imaged family to score
const familyRe = new RegExp(family, 'i');

const actualEff = (inp, cc, cr) => inp + cc * CACHE_CREATE_RATE + cr * CACHE_READ_RATE;
function baselineEff(baseline, baseCacheable, inp, cc, cr, warm, prevCacheable) {
  if (baseline <= 0) return 0;
  if (baseCacheable <= 0) return actualEff(inp, cc, cr); // probe couldn't split prefix ⇒ credit nothing
  const cacheable = Math.min(baseCacheable, baseline);
  const coldTail = baseline - cacheable;
  if (warm) {
    const reused = Math.min(Math.max(prevCacheable, 0), cacheable);
    return reused * CACHE_READ_RATE + (cacheable - reused) * CACHE_CREATE_RATE + coldTail;
  }
  return cacheable * CACHE_CREATE_RATE + coldTail;
}

if (!fs.existsSync(logFile)) {
  console.error(`[gate-backtest] no log at ${logFile} (pass a path or set PXPIPE_LOG)`);
  process.exit(1);
}

const rows = [];
const rl = readline.createInterface({ input: fs.createReadStream(logFile) });
rl.on('line', (l) => {
  if (!l.trim()) return;
  let e; try { e = JSON.parse(l); } catch { return; }
  if (!e.model || !familyRe.test(e.model) || !e.compressed) return;
  if (e.baseline_probe_status !== 'ok' || !(e.baseline_tokens > 0)) return; // only honestly scorable rows
  rows.push({
    ts: Date.parse(e.ts) / 1000, sess: e.first_user_sha8 || 'nil', prefix: e.cache_prefix_sha8,
    baseline: e.baseline_tokens, baseCacheable: e.baseline_cacheable_tokens || 0,
    inp: e.input_tokens || 0, cc: e.cache_create_tokens || 0, cr: e.cache_read_tokens || 0,
    orig_chars: e.orig_chars || 0,
  });
});
rl.on('close', () => {
  if (rows.length === 0) { console.error(`[gate-backtest] no scorable compressed "${family}" rows in ${logFile}`); process.exit(1); }
  rows.sort((a, b) => a.ts - b.ts);

  // Attach realized win/loss + decision-time context (prior-turn warmth/size).
  const prev = new Map();
  for (const r of rows) {
    const p = prev.get(r.sess);
    const age = p ? r.ts - p.ts : Infinity;
    const samePrefix = !p || p.prefix == null || r.prefix == null || p.prefix === r.prefix;
    r.warm = r.cr > 0; // realized warmth: the only warm/cold signal (baseline.ts)
    const freshPrior = p && age >= 0 && age < TTL_SEC && samePrefix;
    const prevCacheable = r.warm ? (freshPrior ? p.baseCacheable : r.baseCacheable) : 0;
    r.baseEff = baselineEff(r.baseline, r.baseCacheable, r.inp, r.cc, r.cr, r.warm, prevCacheable);
    r.actEff = actualEff(r.inp, r.cc, r.cr);
    r.saved = r.baseEff - r.actEff;
    r.priorWarm = !!(p && p.cr > 0 && age < TTL_SEC); // proxy knows last response's cr
    r.priorChars = p ? p.orig_chars : 0;
    prev.set(r.sess, { ts: r.ts, baseCacheable: r.baseCacheable, prefix: r.prefix, cr: r.cr, orig_chars: r.orig_chars });
  }

  // --- realized reconciliation ---
  const textBaseline = rows.reduce((s, r) => s + r.baseEff, 0);
  const wins = rows.filter((r) => r.saved >= 0), losses = rows.filter((r) => r.saved < 0);
  const winTok = wins.reduce((s, r) => s + r.saved, 0);
  const lossTok = losses.reduce((s, r) => s + -r.saved, 0);
  const net = textBaseline - rows.reduce((s, r) => s + r.actEff, 0);
  const pct = (x, t) => (100 * x / (t || 1)).toFixed(1);
  const lossWarm = losses.filter((r) => r.warm).length;
  const bucket = (c) => (c < 6000 ? '<6k' : c < 20000 ? '6-20k' : c < 50000 ? '20-50k' : '>50k');
  const byBucket = {}; for (const r of losses) byBucket[bucket(r.orig_chars)] = (byBucket[bucket(r.orig_chars)] || 0) + 1;

  console.log(`log=${logFile}  family=${family}  scorable rows=${rows.length}`);
  console.log(`net saved: ${Math.round(net).toLocaleString()} weighted-input-tok  (${pct(net, textBaseline)}% of text baseline)`);
  console.log(`  wins:   ${wins.length} rows  +${Math.round(winTok).toLocaleString()}`);
  console.log(`  losses: ${losses.length} rows (${pct(losses.length, rows.length)}%)  -${Math.round(lossTok).toLocaleString()}  = ${pct(lossTok, net)}% of net  [warm=${lossWarm}/${losses.length}]`);
  console.log(`  loss rows by orig_chars: ${JSON.stringify(byBucket)}`);

  // --- policy frontier ---
  const score = (name, shouldImage) => {
    let cost = 0, imaged = 0, passed = 0, recov = 0, sacr = 0, recovTok = 0, sacrTok = 0;
    for (const r of rows) {
      if (shouldImage(r)) { cost += r.actEff; imaged++; }
      else { cost += r.baseEff; passed++; if (r.saved < 0) { recov++; recovTok += -r.saved; } else { sacr++; sacrTok += r.saved; } }
    }
    return { name, net: textBaseline - cost, imaged, passed, recov, sacr, recovTok, sacrTok };
  };
  const policies = [
    score('current (always image)', () => true),
    score('ORACLE (pass iff realized loss)', (r) => r.saved >= 0),
  ];
  for (const T of [20000, 40000, 60000]) policies.push(score(`warm & >=${T / 1000}k chars -> pass`, (r) => !(r.priorWarm && r.orig_chars >= T)));
  for (const G of [2000, 8000]) policies.push(score(`warm & grew>=${G / 1000}k & >=20k -> pass`, (r) => !(r.priorWarm && r.orig_chars >= 20000 && Math.abs(r.orig_chars - r.priorChars) >= G)));

  const cur = policies[0].net;
  console.log('\npolicy frontier (Δ vs current; passthrough gates that recover losers but sacrifice winners backfire):');
  console.log(['  ' + 'policy'.padEnd(34), 'net%', 'Δ vs cur', 'imaged', 'passed', 'losers+', 'winners-'].join('  '));
  for (const p of policies) {
    console.log(['  ' + p.name.padEnd(34), pct(p.net, textBaseline).padStart(5), String(Math.round(p.net - cur)).padStart(9),
      String(p.imaged).padStart(6), String(p.passed).padStart(6), `${p.recov}/${Math.round(p.recovTok / 1000)}k`.padStart(8), `${p.sacr}/${Math.round(p.sacrTok / 1000)}k`.padStart(9)].join('  '));
  }
});
