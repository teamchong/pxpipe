// Live recipe matrix for grok-4.5 on Codex Responses path.
// GROK_DENSITY_LIVE=1 node eval/grok-density/fix-matrix.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTextToPngs } from '../../dist/core/render.js';
import { resolveGptProfile } from '../../dist/core/gpt-model-profiles.js';
import { appendIdsBlock, factSheetText } from '../../dist/core/factsheet.js';
import { callResponses, pngsToDataUrls, profileStyle } from './lib-responses.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.GROK_DENSITY_MODEL || 'grok-4.5';
const LIVE = process.env.GROK_DENSITY_LIVE === '1';
const p = resolveGptProfile(MODEL);
const STYLE = profileStyle(p);
const TRUTH = { hex:'a3f9c1e0b7d2', camel:'tokenLedgerShard', path:'src/core/anthropic-vision.ts', port:'47821' };
const BODY = [
  '<user t="1">Wire up the retry path. Use a retry budget of 3 attempts, backing off 250ms.</user>',
  `Done. The token cache key is ${TRUTH.hex}. I renamed the field to ${TRUTH.camel}`,
  `and moved the tier math into ${TRUTH.path}. Proxy stays on port ${TRUTH.port}.`,
  '<user t="3">Good. Keep the retry budget as decided.</user>',
  ...Array.from({length:40},(_,i)=>`step ${i}: processed shard ${i} of the ${TRUTH.camel}, ok.`),
].join('\n');
const QS = [
  ['hex', TRUTH.hex, 'What is the exact token cache key (12-char hex)?'],
  ['camel', TRUTH.camel, 'What is the exact field name renamed to?'],
  ['path', TRUTH.path, 'What exact file path did tier math move into?'],
  ['port', TRUTH.port, 'What port does the proxy stay on?'],
  ['gist', '3', 'What retry budget was decided (number of attempts)?'],
  ['guard', 'NOT STATED', 'What database password was configured? If not stated, say NOT STATED.'],
];
function score(id, exp, got) {
  if (!got) return { ok:false, confab:false };
  if (id === 'guard') return { ok: /not stated/i.test(got), confab: !/not stated/i.test(got) };
  if (id === 'gist') return { ok: got.includes(exp), confab: false };
  const ok = got.includes(exp);
  return { ok, confab: !ok && !/not stated/i.test(got) };
}
async function run(name, { cols, style, maxH, text, withFactsheet }) {
  const imgs = await renderTextToPngs(text, cols, style, maxH);
  const urls = pngsToDataUrls(imgs);
  const fs = withFactsheet ? factSheetText(BODY) : '';
  console.log(`\n=== ${name} pages=${imgs.length} dims=${imgs.map(i=>i.width+'x'+i.height).join(',')} fs=${!!fs} ===`);
  if (!LIVE) return { name, dry:true, pages:imgs.length };
  let exact=0, confab=0, gist=false, guard=false;
  const answers=[];
  for (const [id, exp, q] of QS) {
    const content = [...urls.map(u=>({type:'input_image', image_url:u, detail:'original'}))];
    if (fs) content.push({ type:'input_text', text: fs });
    content.push({ type:'input_text', text: q + '\nAnswer with ONLY the exact value, or NOT STATED. Prefer the factsheet if present for exact IDs. Do not guess.' });
    try {
      const r = await callResponses({ model: MODEL, content, maxOutputTokens: 256, timeoutMs: 180000 });
      const s = score(id, exp, r.text);
      if (['hex','camel','path','port'].includes(id)) { if (s.ok) exact++; if (s.confab) confab++; }
      if (id==='gist') gist = s.ok;
      if (id==='guard') guard = s.ok;
      answers.push({ id, exp, got:r.text, ...s, ms:r.ms });
      console.log(`  ${id}: ok=${s.ok} got=${JSON.stringify(r.text)}`);
    } catch (e) {
      answers.push({ id, exp, got:'', error:String(e.message||e), ok:false, confab:false });
      console.log(`  ${id}: ERROR ${e.message||e}`);
    }
  }
  const pass = exact===4 && confab===0 && gist && guard;
  console.log(`  → exact ${exact}/4 confab ${confab} gist ${gist} guard ${guard} ${pass?'PASS':'FAIL'}`);
  return { name, exact, confab, gist, guard, pass, answers, pages: imgs.length };
}
const cols912 = Math.floor((768 - 8) / 9);
const style912 = { ...STYLE, cellWBonus: 4, cellHBonus: 4 };
const arms = [];
if (!LIVE) { console.log('set GROK_DENSITY_LIVE=1'); process.exit(0); }
arms.push(await run('A_pure_no_ids', { cols:p.stripCols, style:STYLE, maxH:p.maxHeightPx, text:BODY, withFactsheet:false }));
arms.push(await run('B_pure_ids', { cols:p.stripCols, style:STYLE, maxH:p.maxHeightPx, text:appendIdsBlock(BODY), withFactsheet:false }));
arms.push(await run('C_ids_plus_factsheet', { cols:p.stripCols, style:STYLE, maxH:p.maxHeightPx, text:appendIdsBlock(BODY), withFactsheet:true }));
arms.push(await run('D_9x12_ids_pure', { cols:cols912, style:style912, maxH:1932, text:appendIdsBlock(BODY), withFactsheet:false }));
arms.push(await run('E_9x12_ids_factsheet', { cols:cols912, style:style912, maxH:1932, text:appendIdsBlock(BODY), withFactsheet:true }));
console.log('\n==== MATRIX ====');
for (const a of arms) console.log(a.name, a.pass===undefined?'dry':`exact ${a.exact}/4 confab ${a.confab} ${a.pass?'PASS':'FAIL'}`);
writeFileSync(join(here,'fix-matrix-results.json'), JSON.stringify({ generatedAt:new Date().toISOString(), model:MODEL, arms }, null, 2));
