// Verify the shipped Grok pure-image 5x8 packing (profile geometry/style, no factsheet).
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTextToPngs } from '../../dist/core/render.js';
import { resolveGptProfile } from '../../dist/core/gpt-model-profiles.js';
import { visionTokensForModel } from '../../dist/core/openai.js';
import { appendIdsBlock } from '../../dist/core/factsheet.js';

const here = dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.GROK_DENSITY_MODEL || 'grok-4.5';
const TIMEOUT_MS = Number(process.env.GROK_DENSITY_TIMEOUT_MS || 180000);
const LIVE = process.env.GROK_DENSITY_LIVE === '1';
const profile = resolveGptProfile(MODEL);
const COLS = profile.stripCols;
const MAX_H = profile.maxHeightPx;
const STYLE = {
  aa: profile.style.aa,
  grid: profile.style.grid,
  gridCols: profile.style.gridCols,
  colorCycle: profile.style.colorCycle,
  cellWBonus: profile.style.cellWBonus,
  cellHBonus: profile.style.cellHBonus,
};
const TRUTH = { hex:'a3f9c1e0b7d2', camel:'tokenLedgerShard', path:'src/core/anthropic-vision.ts', port:'47821' };
// Classic short fixture (matches original density harness) + multipage bulk variant.
function session(bulk) {
  return [
    '<user t="1">Wire up the retry path. Use a retry budget of 3 attempts, backing off 250ms.</user>',
    `<assistant t="2">Done. The token cache key is ${TRUTH.hex}. I renamed the field to ${TRUTH.camel}`,
    `and moved the tier math into ${TRUTH.path}. The CLI now takes --max-visual-tokens. Proxy stays on port ${TRUTH.port}.</assistant>`,
    '<user t="3">Good. Keep the retry budget as decided; do not change the backoff.</user>',
    ...Array.from({ length: bulk }, (_, i) =>
      `<assistant t="${4 + i}">step ${i}: processed shard ${i} of the ${TRUTH.camel}${bulk>40?` path=${TRUTH.path} port=${TRUTH.port} key=${TRUTH.hex}`:''}, ok, continuing the run.</assistant>`),
  ].join('\n');
}
const QUESTIONS = [
  { id:'hex', kind:'exact', q:'What is the exact token cache key (12-char hex) mentioned in the transcript?', answer:TRUTH.hex },
  { id:'camel', kind:'exact', q:'What is the exact field name the assistant renamed the field to?', answer:TRUTH.camel },
  { id:'path', kind:'exact', q:'What exact file path did the tier math move into?', answer:TRUTH.path },
  { id:'port', kind:'exact', q:'What port does the proxy stay on?', answer:TRUTH.port },
  { id:'gist', kind:'gist', q:'What retry budget was decided (a number of attempts)?', answer:'3' },
  { id:'guard', kind:'guard', q:'What database password was configured in this session? If it was not stated, say "NOT STATED".', answer:'NOT STATED' },
];
function responsesBaseUrl(){const b=(process.env.OPENAI_BASE_URL||'').replace(/\/$/,'');if(!b)throw new Error('OPENAI_BASE_URL');return b.endsWith('/responses')?b:`${b}/responses`;}
async function callModel(dataUrls, question){
  const c=new AbortController(); const t=setTimeout(()=>c.abort(),TIMEOUT_MS); const t0=Date.now();
  try{
    const res=await fetch(responsesBaseUrl(),{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${process.env.OPENAI_API_KEY}`},body:JSON.stringify({model:MODEL,stream:false,max_output_tokens:512,input:[{role:'user',content:[...dataUrls.map(u=>({type:'input_image',image_url:u,detail:'original'})),{type:'input_text',text:question+'\nAnswer with ONLY the exact value, or "NOT STATED" if it is not present. Do not guess.'}]}]}),signal:c.signal});
    const raw=await res.text(); const j=JSON.parse(raw); if(!res.ok) throw new Error(`HTTP ${res.status}: ${j?.error?.message||raw.slice(0,160)}`);
    let text=typeof j.output_text==='string'?j.output_text:'';
    if(!text&&Array.isArray(j.output)) for(const item of j.output){ if(!item||item.type!=='message'||!Array.isArray(item.content)) continue; for(const part of item.content) if(part&&(part.type==='output_text'||part.type==='text')&&typeof part.text==='string') text+=part.text; }
    return {text:text.trim(), ms:Date.now()-t0};
  } finally { clearTimeout(t); }
}
function score(kind, expected, got){
  if(!got) return {ok:false,abstained:false,confab:false,refused:true};
  const g=got.toLowerCase();
  const abstained=/not stated|unknown|not safe|can't|cannot|not present|i don't know|do not know/.test(g);
  if(kind==='guard') return {ok:abstained,abstained,confab:!abstained,refused:false};
  if(kind==='gist') return {ok:g.includes(String(expected).toLowerCase()),abstained,confab:false,refused:false};
  return {ok:got.includes(expected),abstained,confab:!got.includes(expected)&&!abstained,refused:false};
}
const rows=[];
for (const [id, bulk] of [['shipped_short', 40], ['shipped_bulk', 220]]) {
  const SESSION = appendIdsBlock(session(bulk)); // production pure-image recipe
  const imgs = await renderTextToPngs(SESSION, COLS, STYLE, MAX_H);
  const dims = imgs.map(im=>`${im.width}x${im.height}`);
  const shortSide = Math.min(...imgs.map(im=>Math.min(im.width, im.height)));
  const imageTokens = imgs.reduce((n,im)=>n+visionTokensForModel(MODEL,im.width,im.height),0);
  console.log(`\n[${id}] pages=${imgs.length} dims=${dims.slice(0,3).join(',')} short=${shortSide} tok=${imageTokens}`);
  const row = { id, bulk, cols:COLS, maxH:MAX_H, style:STYLE, pages:imgs.length, dims, shortSide, noResize:shortSide<=768, imageTokens, model:null };
  if (LIVE) {
    const dataUrls = imgs.map(im=>`data:image/png;base64,${Buffer.from(im.png).toString('base64')}`);
    const m = { exactCorrect:0, exactTotal:0, confab:0, gistOk:false, guardOk:false, answers:[] };
    for (const q of QUESTIONS) {
      try {
        const r = await callModel(dataUrls, q.q);
        const s = score(q.kind, q.answer, r.text);
        if (q.kind==='exact') { m.exactTotal++; if (s.ok) m.exactCorrect++; if (s.confab) m.confab++; }
        else if (q.kind==='gist') m.gistOk = s.ok;
        else if (q.kind==='guard') m.guardOk = s.ok;
        m.answers.push({ id:q.id, kind:q.kind, expected:q.answer, got:r.text, ...s, ms:r.ms });
        console.log(`  ${q.id}: ${JSON.stringify(r.text)} ok=${s.ok}`);
      } catch (err) {
        m.answers.push({ id:q.id, kind:q.kind, expected:q.answer, got:'', error:String(err.message||err) });
        console.log(`  ${q.id}: ERROR ${err.message||err}`);
        if (q.kind==='exact') m.exactTotal++;
      }
    }
    m.pass = m.exactCorrect===4 && m.confab===0 && m.gistOk && m.guardOk;
    row.model = m;
    console.log(`  → exact ${m.exactCorrect}/4 confab ${m.confab} gist ${m.gistOk} guard ${m.guardOk} ${m.pass?'*** PASS ***':''}`);
  }
  rows.push(row);
  writeFileSync(join(here,'five-by-eight-shipped-results.json'), JSON.stringify({
    generatedAt:new Date().toISOString(), model:MODEL, live:LIVE, pureImage:true, density:'5x8', profile:{cols:COLS,maxH:MAX_H,style:STYLE}, rows,
  }, null, 2));
}
