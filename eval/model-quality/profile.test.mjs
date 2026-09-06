import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveGptProfile, renderProfileFixture, profileRecipe, sha256, assertBuildFresh } from './profile-render.mjs';
import { hexFixtures, gistFixtures, arithmeticFixtures } from './fixtures.mjs';
import { grade } from './tasks.mjs';
import { renderTextToPngs, reflow, neutralizeSentinel } from '../../dist/core/render.js';
import { factSheetText } from '../../dist/core/factsheet.js';
import { openAIImageDetail, historyFactSheet } from '../../dist/core/openai.js';
import { summarize } from './summarize.mjs';

test('built modules are fresh before paid evaluation', () => assertBuildFresh());
for (const model of ['gpt-6-astra', 'gpt-5.6-sol', 'grok-4.6', 'google/gemini-3.6-flash',
  'google/gemini-3.8-flash', 'claude-fable-5', 'claude-opus-5',
  'workers-ai/@cf/qwen/qwen3.8-27b', '@cf/zai-org/glm-5.3-flash', 'unknown-model']) {
  test(`${model}: eval uses the runtime profile and exact renderer bytes`, async () => {
    const p = resolveGptProfile(model);
    const source = 'The selected package is immer.\nACTIVE_PORT=8431\nThe exact id is ab91cd45ef67.';
    for (const purpose of ['content', 'history']) {
      const got = await renderProfileFixture(source, model, purpose);
      const config = profileRecipe(model, purpose);
      assert.deepEqual(config.profile, p);
      assert.equal(config.cols, purpose === 'history' ? p.historyStripCols ?? p.stripCols : p.stripCols);
      assert.deepEqual(config.style, purpose === 'history' ? p.historyStyle ?? p.style : p.style);
      assert.equal(config.maxHeightPx, p.maxHeightPx);
      const safe = neutralizeSentinel(source);
      const expected = await renderTextToPngs(config.reflow ? reflow(safe) ?? safe : safe, config.cols, config.style, config.maxHeightPx);
      assert.deepEqual(got.provenance.images.map(im => im.sha256), expected.map(im => sha256(im.png)));
      assert.equal(got.provenance.factsheetHash, sha256(purpose === 'history' ? historyFactSheet(source, p) : factSheetText(source, p.factSheetFormat)));
      assert.equal(got.provenance.detail, openAIImageDetail(model));
    }
  });
}
test('runtime profile overrides propagate without separate eval geometry', async () => {
  const old = process.env.PXPIPE_GPT_PROFILES;
  try {
    process.env.PXPIPE_GPT_PROFILES = JSON.stringify({ 'gpt-6-astra': {
      stripCols: 90, maxHeightPx: 512, style: { font: 'jetbrains-mono-14' }, factSheetFormat: 'full',
      history: { reflow: false },
    } });
    const got = await renderProfileFixture('line one\nport 4500', 'gpt-6-astra', 'history');
    assert.equal(got.provenance.recipe.cols, 90);
    assert.equal(got.provenance.recipe.maxHeightPx, 512);
    assert.equal(got.provenance.recipe.style.font, 'jetbrains-mono-14');
    assert.equal(got.provenance.recipe.reflow, false);
    assert.equal(got.provenance.recipe.factSheetFormat, 'full');
  } finally {
    if (old === undefined) delete process.env.PXPIPE_GPT_PROFILES; else process.env.PXPIPE_GPT_PROFILES = old;
  }
});
test('shared source fixture has 15 unique unmarked targets at varying depths', () => {
  const hex = hexFixtures();
  assert.deepEqual(hex, hexFixtures());
  assert.deepEqual(hex, JSON.parse(readFileSync(new URL('./hex-source.json', import.meta.url), 'utf8')));
  assert.notDeepEqual(hex.pages, hexFixtures(1234).pages);
  assert.equal(hex.trials.length, 15);
  const records = hex.pages.flatMap(p => p.split('\n').slice(1).map(s => JSON.parse(s)));
  assert.equal(new Set(records.map(r => r.id)).size, 445);
  assert.equal(new Set(records.map(r => r.dur_ms)).size, 445);
  assert(new Set(hex.trials.map(t => t.row)).size > 5);
  assert(!hex.pages.some(p => p.includes('target')));
  for (const t of hex.trials) {
    const matches = records.filter(r => r.dur_ms === t.dur);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].id, t.gold);
  }
  assert.equal(arithmeticFixtures().rows.length, 100);
  const gist = gistFixtures();
  assert.equal(gist.flatMap(s => s.probes).filter(p => p.type !== 'unanswerable').length, 98);
  assert.equal(gist.flatMap(s => s.probes).filter(p => p.type === 'unanswerable').length, 16);
  assert.equal(gist.filter(s => s.tier === 'work3').flatMap(s => s.probes).length, 18);
});
test('GPT-6 history preserves the same native-opaque overflow as normal requests', async () => {
  const source = Array.from({ length: 200 }, (_, i) => `record id=${(100000000 + i).toString(16).padStart(12, '0')} status=ok`).join('\n');
  const p = resolveGptProfile('gpt-6-astra');
  const expected = historyFactSheet(source, p);
  assert(expected.length > factSheetText(source, p.factSheetFormat).length);
  const got = await renderProfileFixture(source, 'gpt-6-astra', 'history');
  assert.equal(got.provenance.factsheetHash, sha256(expected));
  assert(got.parts.some(p => p.type === 'input_text' && p.text === expected));
});
test('common grading rejects malformed arrays and hex answer lists', () => {
  const hex = { meta: { suite: 'hex', gold: 'abc123def456' } };
  assert.equal(grade(hex, 'abc123def456').ok, true);
  assert.equal(grade(hex, 'abc123def456 or 123456abcdef').ok, false);
  assert.throws(() => grade({ meta: { suite: 'gist', probes: [{ gold: 'x' }] } }, 'no JSON'));
  assert.throws(() => summarize({ manifest: { protocol: 'legacy' } }), /Legacy/);
});
test('all standard provider launchers delegate to the common runner', () => {
  for (const family of ['sol', 'grok', 'gemini', 'qwen', 'glm']) {
    for (const suite of ['novel-arithmetic', 'gist-recall', 'verbatim-hex']) {
      const source = readFileSync(new URL(`../${family}-profile/${suite}.mjs`, import.meta.url), 'utf8');
      assert(source.includes("../model-quality/run.mjs"));
      assert(!source.includes('renderTextToPngs'));
      assert(!source.includes('page${'));
    }
  }
});
