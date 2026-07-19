// Targeted diagnostic (Phase B verification): does collapseHistory's chunk
// boundary / carryOverImageOrdinal ever REGRESS turn-to-turn on a growing,
// otherwise-unchanged conversation prefix? If it does, that's a real,
// reproducible cache-bust mechanism worth patching. If it never regresses
// under realistic conditions, the "profitability oscillation" theory from
// the earlier live-log analysis was a red herring and we should not patch
// collapseHistory blindly.
//
// This exercises the REAL collapseHistory()/findClosedPrefixBoundary() code
// (not a re-implementation) against a synthetic, deterministically-growing
// message list — no network calls, no PNG dashboard, no live traffic needed.
//
// Usage: npx tsx scripts/diagnose-boundary-monotonic.ts [turns]

import { collapseHistory, HISTORY_DEFAULTS } from '../src/core/history.js';
import type { Message } from '../src/core/types.js';

const TURNS = Number(process.argv[2] ?? 60);

// Build a growing conversation: user text turn, assistant turn that opens a
// tool_use every 3rd turn (realistic — most turns are plain text, some carry
// tool calls), followed immediately by its tool_result so the prefix stays
// "closed" except for the live tail. Content text differs per turn (like a
// real session) but PRIOR turns are never mutated once appended — exactly
// the invariant Anthropic's cache and pxpipe's append-only design assume.
function buildMessages(turns: number): Message[] {
  const messages: Message[] = [];
  for (let t = 0; t < turns; t++) {
    messages.push({
      role: 'user',
      content: `Turn ${t}: please do something moderately verbose so the transcript has real bulk. `.repeat(8),
    });
    if (t % 3 === 2) {
      const toolId = `tool_${t}`;
      messages.push({
        role: 'assistant',
        content: [
          { type: 'text', text: `Turn ${t}: I will call a tool.` },
          { type: 'tool_use', id: toolId, name: 'demo_tool', input: { turn: t } },
        ],
      });
      messages.push({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: toolId, content: `Result for turn ${t}: `.repeat(20) },
        ],
      });
    } else {
      messages.push({
        role: 'assistant',
        content: `Turn ${t}: here is a plain-text reply of moderate length. `.repeat(6),
      });
    }
  }
  return messages;
}

async function main() {
  const all = buildMessages(TURNS);
  // isProfitable: pure content-size gate, priorWarmTokens/priorWarmImageTokens
  // fixed at 0 — matches PRODUCTION reality (node.ts:970 confirmed transform()
  // always uses static DEFAULTS with priorWarm*=0; there is no live feedback
  // loop). If instability shows up even with this constant, warmth feedback is
  // NOT the cause and Phase B should target something else.
  const isProfitable = (text: string): boolean => text.length > 2000;

  let prevCollapseLen = -1;
  let prevCarryOver: number | undefined;
  let prevImageCount = -1;
  const regressions: string[] = [];

  // Replay turn-by-turn: at "turn i" the client has sent messages[0..cutoffMsgIdx)
  // — i.e. everything BEFORE the live tail for that turn. We approximate this by
  // slicing the full transcript progressively, exactly like successive requests
  // in the same session each carrying one more turn than the last.
  for (let t = 4; t <= TURNS; t++) {
    // Reconstruct how many raw messages exist after `t` user turns.
    let msgCount = 0;
    let turnsSeen = 0;
    for (let i = 0; i < all.length && turnsSeen < t; i++) {
      if (all[i]!.role === 'user' && typeof all[i]!.content === 'string') turnsSeen++;
      else if (all[i]!.role === 'user' && Array.isArray(all[i]!.content)) {
        // tool_result-carrying user message doesn't start a new "turn" here
      }
      msgCount = i + 1;
    }
    const slice = all.slice(0, msgCount);

    const { info } = await collapseHistory(slice, isProfitable, {
      cols: HISTORY_DEFAULTS.cols,
      protectedPrefix: 0,
      reflow: HISTORY_DEFAULTS.reflow,
    });

    const collapseLen = info.collapsedTurns > 0 ? info.collapsedTurns : -1;
    const carryOver = info.carryOverImageOrdinal;
    const imageCount = info.collapsedImages;

    if (info.collapsedTurns > 0) {
      if (prevCollapseLen >= 0 && collapseLen < prevCollapseLen) {
        regressions.push(
          `t=${t}: collapsedTurns REGRESSED ${prevCollapseLen} -> ${collapseLen}`,
        );
      }
      if (
        prevCarryOver !== undefined &&
        carryOver !== undefined &&
        carryOver < prevCarryOver
      ) {
        regressions.push(
          `t=${t}: carryOverImageOrdinal REGRESSED ${prevCarryOver} -> ${carryOver}`,
        );
      }
      if (prevImageCount >= 0 && imageCount < prevImageCount) {
        regressions.push(
          `t=${t}: collapsedImages REGRESSED ${prevImageCount} -> ${imageCount}`,
        );
      }
      prevCollapseLen = collapseLen;
      prevCarryOver = carryOver;
      prevImageCount = imageCount;
    }

    console.log(
      `t=${String(t).padStart(3)}  msgs=${String(msgCount).padStart(4)}  reason=${(info.reason ?? 'collapsed').padEnd(16)}  collapsedTurns=${String(info.collapsedTurns).padStart(4)}  images=${String(info.collapsedImages).padStart(2)}  carryOverOrdinal=${carryOver ?? '-'}`,
    );
  }

  console.log('\n=== Result ===');
  if (regressions.length === 0) {
    console.log('NO regressions observed: collapsedTurns / carryOverImageOrdinal / collapsedImages were monotonic non-decreasing across all turns.');
    console.log('=> The "boundary regresses turn-to-turn" hypothesis is NOT reproduced under realistic append-only growth with priorWarmTokens=0 (production reality).');
  } else {
    console.log(`${regressions.length} regression(s) found:`);
    for (const r of regressions) console.log('  ' + r);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
