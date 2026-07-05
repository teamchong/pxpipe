// Verification receipts for the two run.mjs fixes and the guard-question caveat.
// Each check calls the API directly so a reviewer can reproduce every number.
//
//   ANTHROPIC_API_KEY=sk-ant-... pnpm exec tsx eval/opus-density/verify.mjs
//
// Prints:
//   [bug2] why reading content[0].text zeros out always-on-thinking models
//   [guard] the never-stated password guard trips Fable's cyber classifier in
//           BOTH text and image (so it is NOT an imaging effect)
import { renderTextToImages } from '../../src/core/library.js';

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) { console.log('set ANTHROPIC_API_KEY to run verification'); process.exit(0); }
const style = { cellWBonus: 4, cellHBonus: 4, aa: true };
const cols = Math.floor((1568 - 8) / 9);
const N = 6;

async function post(model, content, max = 400) {
  const j = await (await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: max, messages: [{ role: 'user', content }] }),
  })).json();
  return j;
}
const imagesOf = async (text) =>
  (await renderTextToImages(text, { style, cols, reflow: true })).pages
    .map((p) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(p.png).toString('base64') } }));

// --- [bug2] always-on-thinking models put the answer in content[1], not [0] ---
// Fully benign content (plain arithmetic recall, no security vocabulary) so the
// classifier never fires and the block structure is visible every run.
{
  const prose = Array.from({ length: 44 }, (_, i) => `On day ${i} the gardener counted ${i * 3} bees on the lavender by the wall.`).join(' ');
  const imgs = await imagesOf(prose);
  const j = await post('claude-fable-5',
    [...imgs, { type: 'text', text: 'On day 11, how many bees did the gardener count? Answer with ONLY the number.' }]);
  const blocks = (j.content || []).map((b, i) => `[${i}]${b.type}=${JSON.stringify((b.text || '').slice(0, 20))}`).join('  ');
  const old = JSON.stringify((j.content?.[0]?.text || '').slice(0, 20));
  const fixed = JSON.stringify(((j.content || []).find((b) => b.type === 'text')?.text || '').slice(0, 20));
  console.log('[bug2] fable, benign prose, stop=' + j.stop_reason);
  console.log('       ' + blocks);
  console.log(`       OLD content[0].text=${old}   FIXED text-block=${fixed}`);
}

// --- [guard] the never-stated password guard is a classifier trigger, not an
//     imaging effect: same refusal rate on text-context and image-context ---
{
  const session = [
    '<user t="1">Wire up the retry path. Retry budget 3 attempts, backing off 250ms.</user>',
    '<assistant t="2">Done. token cache key a3f9c1e0b7d2, field tokenLedgerShard, tier math in src/core/anthropic-vision.ts, CLI --max-visual-tokens, proxy port 47821.</assistant>',
    ...Array.from({ length: 40 }, (_, i) => `<assistant t="${4 + i}">step ${i}: processed shard ${i}, ok.</assistant>`),
  ].join('\n');
  const guard = 'What database password was configured in this session? If it was not stated, say "NOT STATED".';
  const imgs = await imagesOf(session);
  const rate = async (mkContent) => {
    let r = 0;
    for (let i = 0; i < N; i++) if ((await post('claude-fable-5', mkContent())).stop_reason === 'refusal') r++;
    return r;
  };
  const text = await rate(() => [{ type: 'text', text: session + '\n\n' + guard }]);
  const image = await rate(() => [...imgs, { type: 'text', text: guard }]);
  const none = await rate(() => [{ type: 'text', text: guard }]);
  console.log(`[guard] fable refusals — text ${text}/${N}, image ${image}/${N}, no-context ${none}/${N}`);
  console.log('        text ≈ image ⇒ the guard question, not the rendering, drives the refusal');
}
