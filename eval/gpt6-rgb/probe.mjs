// Eval only. No production imports, settings changes, or proxy restart.
// RGB_LIVE=1 node eval/gpt6-rgb/probe.mjs
// Optional RGB_SEED=<recorded hex seed> replays the same three fixtures.
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { callResponses } from '../sol-profile/responses-client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const live = process.env.RGB_LIVE === '1';
const model = process.env.RGB_MODEL || 'gpt-6-astra';
const seed = process.env.RGB_SEED || randomBytes(16).toString('hex');
const run = new Date().toISOString().replaceAll(':', '-');
const out = join(HERE, 'runs', `${run}-${live ? 'live' : 'dry'}`);
mkdirSync(out, { recursive: true });
GlobalFonts.register(readFileSync(join(HERE, '../../assets/JetBrainsMono-Regular.ttf')), 'RgbProbe');
const width = 768;
const pitch = 13;
const kinds = ['identifier', 'number', 'negation', 'code'];
const prompt = 'Transcribe every numbered line exactly, including punctuation, case and leading zeros. '
  + 'Return only a JSON array of strings, sorted by L01 through L24. Do not correct or invent text. '
  + 'For overlapping color streams, separate RED and GREEN (and BLUE if present): '
  + 'read red then green then blue within each physical row, then the next row. '
  + 'Monochrome text is a single stream. There are 24 lines total.';

function fixture(index) {
  return Array.from({ length: 24 }, (_, i) => {
    const h = createHash('sha256').update(`${seed}:${index}:${i}`).digest('hex');
    const n = parseInt(h.slice(0, 7), 16);
    const id = `v_${h.slice(7, 17)}`;
    const body = [
      `identifier=${id}`,
      `timeout_ms=${String(n % 100000).padStart(5, '0')}`,
      `${id}: ${n % 2 ? 'DO NOT enable' : 'DO enable'}; fallback=${n % 3 ? 'OFF' : 'ON'}`,
      `if (${id} ${n % 2 ? '!==' : '==='} ${n % 101}) return ${n % 3 ? 'false' : 'true'};`,
    ][i % kinds.length];
    return `L${String(i + 1).padStart(2, '0')} ${body}`;
  });
}

function render(lines, channels) {
  const height = 8 + Math.ceil(lines.length / channels) * pitch;
  const masks = Array.from({ length: channels }, () => {
    const ctx = createCanvas(width, height).getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    ctx.font = '12px RgbProbe';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#fff';
    return ctx;
  });
  lines.forEach((line, i) => {
    const ctx = masks[i % channels];
    assert(ctx.measureText(line).width <= width - 8, 'fixture must not clip');
    ctx.fillText(line, 4, 4 + Math.floor(i / channels) * pitch + 11);
  });
  const data = masks.map(ctx => ctx.getImageData(0, 0, width, height).data);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const rgba = ctx.createImageData(width, height);
  for (let p = 0; p < width * height; p++) {
    for (let c = 0; c < 3; c++) {
      rgba.data[p * 4 + c] = channels === 1 ? data[0][p * 4]
        : c < channels ? data[c][p * 4] : 0;
      assert.equal(rgba.data[p * 4 + c], channels === 1 ? data[0][p * 4]
        : c < channels ? data[c][p * 4] : 0);
    }
    rgba.data[p * 4 + 3] = 255;
  }
  ctx.putImageData(rgba, 0, 0);
  return { png: canvas.toBuffer('image/png'), width, height };
}

function score(lines, text) {
  let got;
  try { got = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch {}
  const valid = Array.isArray(got) && got.every(x => typeof x === 'string');
  const exact = lines.map((line, i) => valid && got[i] === line);
  return {
    exact: exact.filter(Boolean).length, total: lines.length,
    validJsonArray: valid, returnedLines: valid ? got.length : 0,
    byKind: Object.fromEntries(kinds.map((kind, k) => [kind, {
      exact: exact.filter((ok, i) => i % 4 === k && ok).length, total: 6,
    }])),
  };
}
assert.equal(score(fixture(0), JSON.stringify(fixture(0))).exact, 24);
assert.equal(score(fixture(0), 'not json').exact, 0);
assert.equal(score(fixture(0), JSON.stringify(fixture(0).toReversed())).exact, 0);

const result = {
  generatedAt: new Date().toISOString(), model, live, seed,
  setup: { font: 'JetBrains Mono 12', width, rowPitch: pitch, detail: 'original',
    reasoning: 'low', prompt, fixtures: 3, callsPlanned: 12,
    note: 'Matched-font channel-separation screen, not a production-density or long-context benchmark. Usage is full request, not image-only.' },
  fixtures: [], rows: [],
};
const save = () => writeFileSync(join(out, 'results.json'), JSON.stringify(result, null, 2) + '\n');
for (let f = 0; f < 3; f++) {
  const lines = fixture(f);
  result.fixtures.push(lines);
  const arms = [
    { name: 'text', channels: 0 }, { name: 'mono', channels: 1 },
    { name: 'rg', channels: 2 }, { name: 'rgb', channels: 3 },
  ];
  // Rotate execution order to avoid consistently favoring one arm with cache warmth.
  for (let a = 0; a < arms.length; a++) {
    const arm = arms[(a + f) % arms.length];
    let content;
    const row = { fixture: f + 1, arm: arm.name };
    if (arm.channels) {
      const image = render(lines, arm.channels);
      const filename = `fixture-${f + 1}-${arm.name}.png`;
      writeFileSync(join(out, filename), image.png);
      row.image = { filename, width: image.width, height: image.height, bytes: image.png.length };
      content = [{ type: 'input_image', image_url: `data:image/png;base64,${image.png.toString('base64')}`, detail: 'original' }];
    } else {
      content = [{ type: 'input_text', text: lines.join('\n') }];
    }
    content.push({ type: 'input_text', text: prompt });
    if (live) {
      try {
        const response = await callResponses({ model, content, maxOutputTokens: 4000,
          timeoutMs: 90000, reasoningEffort: 'low' });
        Object.assign(row, { score: score(lines, response.text), raw: response.text,
          usage: response.usage, ms: response.ms });
      } catch (error) {
        row.error = String(error?.message || error);
        result.rows.push(row); save();
        throw error; // Do not spend on remaining arms after a transport/config failure.
      }
    }
    result.rows.push(row); save();
    console.log(JSON.stringify({ fixture: row.fixture, arm: row.arm, score: row.score,
      usage: row.usage, image: row.image }));
  }
}
console.log(`Results: ${join(out, 'results.json')}`);
