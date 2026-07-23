import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformGoogleGenerateContent } from '../../dist/core/google.js';
import { resolveGeminiProfile } from '../../dist/core/gemini-model-profiles.js';
import { callGeminiRequest } from './gemini-client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULT = join(HERE, 'lost-in-middle-results.json');
const MODEL = 'gemini-3.6-flash';
const DEPTHS = [0.05, 0.25, 0.5, 0.75, 0.95];
const SIZES = (process.env.SIZES || '2000,6000,10000')
  .split(',')
  .map(Number)
  .filter((n) => Number.isInteger(n) && n > 0);
const REPEATS = Math.max(1, Number(process.env.REPEATS || 2));
const TIMEOUT = Number(process.env.TIMEOUT_MS || 240000);
const OLD_TURNS = 35;
const profile = resolveGeminiProfile();
const statuses = ['amber', 'cobalt', 'jade', 'plum', 'silver'];
const regions = ['alder', 'birch', 'cedar', 'maple', 'willow'];

function hash(index, repeat) {
  return ((index + 1) * 2654435761 + repeat * 2246822519) >>> 0;
}

function recordFor(index, repeat) {
  const n = hash(index, repeat);
  return {
    key: `case_${String(index).padStart(6, '0')}`,
    status: statuses[n % statuses.length],
    region: regions[Math.floor(n / statuses.length) % regions.length],
    reference: `ref-${n.toString(36).padStart(7, '0')}`,
    text: `case_${String(index).padStart(6, '0')} | region=${regions[Math.floor(n / statuses.length) % regions.length]} | status=${statuses[n % statuses.length]} | reference=ref-${n.toString(36).padStart(7, '0')} | queue=archive`,
  };
}

function parseAnswer(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function score(response, target) {
  const parsed = parseAnswer(response);
  const acknowledged = parsed?.target_present === true;
  const absentRejected = parsed?.absent_present === false;
  const regionCorrect = String(parsed?.region ?? '').toLowerCase() === target.region;
  const statusCorrect = String(parsed?.status ?? '').toLowerCase() === target.status;
  const referenceCorrect = String(parsed?.reference ?? '').toLowerCase() === target.reference;
  return {
    parsed,
    acknowledged,
    absentRejected,
    regionCorrect,
    statusCorrect,
    referenceCorrect,
    localization: regionCorrect,
    recognition: regionCorrect && statusCorrect,
    exact: regionCorrect && statusCorrect && referenceCorrect,
  };
}

function makeRequest(records, target, absentKey) {
  const buckets = Array.from({ length: OLD_TURNS }, () => []);
  records.forEach((record, index) => {
    buckets[Math.min(OLD_TURNS - 1, Math.floor(index * OLD_TURNS / records.length))].push(record.text);
  });
  const contents = buckets.map((lines, index) => ({
    role: index % 2 === 0 ? 'user' : 'model',
    parts: [{ text: lines.join('\n') }],
  }));
  contents.push(
    { role: 'model', parts: [{ text: 'I have retained the archived case table for later lookup.' }] },
    { role: 'user', parts: [{ text: 'Continue to preserve the archived table.' }] },
    { role: 'model', parts: [{ text: 'The table remains available as prior context.' }] },
    { role: 'user', parts: [{ text: 'Use only the archived table, without guessing.' }] },
    { role: 'model', parts: [{ text: 'Ready for a case lookup.' }] },
    {
      role: 'user',
      parts: [{
        text: [
          `Look up ${target.key} in the archived case table and also check whether ${absentKey} exists.`,
          'Return only a JSON object with exactly these fields. Do not use Markdown fences:',
          '{"target_present":boolean,"absent_present":boolean,"region":string,"status":string,"reference":string}',
          'Copy region, status, and reference only from the target row. If the target is absent, use empty strings.',
        ].join('\n'),
      }],
    },
  );
  return {
    contents,
    generationConfig: { responseMimeType: 'application/json' },
  };
}

function sheetText(request) {
  return (request.contents || [])
    .flatMap((content) => content.parts || [])
    .map((part) => typeof part.text === 'string' && part.text.startsWith('[Exact ') ? part.text : '')
    .filter(Boolean)
    .join('\n');
}

function summarize(rows) {
  const complete = rows.filter((row) => !row.error);
  const arm = (name) => ({
    acknowledged: complete.filter((row) => row[name].score.acknowledged).length,
    absentRejected: complete.filter((row) => row[name].score.absentRejected).length,
    localization: complete.filter((row) => row[name].score.localization).length,
    recognition: complete.filter((row) => row[name].score.recognition).length,
    exact: complete.filter((row) => row[name].score.exact).length,
  });
  return {
    completed: complete.length,
    errors: rows.length - complete.length,
    raw: arm('raw'),
    pxpipe: arm('pxpipe'),
    bySizeDepth: Object.fromEntries(SIZES.map((size) => [
      size,
      Object.fromEntries(DEPTHS.map((depth) => {
        const cells = complete.filter((row) => row.records === size && row.depth === depth);
        return [depth, {
          n: cells.length,
          raw: {
            acknowledged: cells.filter((row) => row.raw.score.acknowledged).length,
            absentRejected: cells.filter((row) => row.raw.score.absentRejected).length,
            localization: cells.filter((row) => row.raw.score.localization).length,
            recognition: cells.filter((row) => row.raw.score.recognition).length,
            exact: cells.filter((row) => row.raw.score.exact).length,
          },
          pxpipe: {
            acknowledged: cells.filter((row) => row.pxpipe.score.acknowledged).length,
            absentRejected: cells.filter((row) => row.pxpipe.score.absentRejected).length,
            localization: cells.filter((row) => row.pxpipe.score.localization).length,
            recognition: cells.filter((row) => row.pxpipe.score.recognition).length,
            exact: cells.filter((row) => row.pxpipe.score.exact).length,
          },
        }];
      })),
    ])),
  };
}

function save(rows) {
  const result = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    methodology: {
      task: 'production-faithful old-history lookup by relative record depth',
      depths: DEPTHS,
      sizes: SIZES,
      repeats: REPEATS,
      oldTurns: OLD_TURNS,
      imageCap: profile.history.maxImages,
      transformer: 'transformGoogleGenerateContent',
      factsheet: 'production output, target coverage recorded per probe',
      measures: {
        acknowledged: 'model says the named target key exists; weak evidence by itself',
        absentRejected: 'model correctly says a matched nonexistent key is absent',
        localization: 'correct adjacent region word copied from the target row',
        recognition: 'localization plus correct semantic status word',
        exact: 'recognition plus exact synthetic reference',
      },
    },
    summary: summarize(rows),
    rows,
  };
  writeFileSync(RESULT, JSON.stringify(result, null, 2));
  return result;
}

const rows = [];
for (const recordsCount of SIZES) {
  for (let repeat = 0; repeat < REPEATS; repeat++) {
    const records = Array.from({ length: recordsCount }, (_, index) => recordFor(index, repeat));
    for (const depth of DEPTHS) {
      const index = Math.min(recordsCount - 1, Math.floor(depth * recordsCount));
      const target = records[index];
      const absentKey = `case_x${String(index).padStart(5, '0')}`;
      const rawRequest = makeRequest(records, target, absentKey);
      const transformed = await transformGoogleGenerateContent(
        new TextEncoder().encode(JSON.stringify(rawRequest)),
        MODEL,
        { compress: true, compressToolResults: false },
      );
      const pxpipeRequest = JSON.parse(new TextDecoder().decode(transformed.body));
      const images = transformed.info.collapsedImages ?? 0;
      if (transformed.info.historyReason !== 'collapsed' || images < 1 || images > profile.history.maxImages) {
        throw new Error(
          `${recordsCount} records did not produce valid production history compression: ` +
          `reason=${transformed.info.historyReason} images=${images}`,
        );
      }
      const factsheet = sheetText(pxpipeRequest);
      const row = {
        records: recordsCount,
        sourceChars: records.reduce((sum, record) => sum + record.text.length + 1, 0),
        repeat,
        depth,
        index,
        target,
        absentKey,
        production: {
          collapsedTurns: transformed.info.collapsedTurns,
          collapsedImages: images,
          collapsedChars: transformed.info.collapsedChars,
          imageTokens: transformed.info.imageTokens,
          baselineImagedTokens: transformed.info.baselineImagedTokens,
          factsheetChars: factsheet.length,
          targetKeyInFactsheet: factsheet.includes(target.key),
          targetRegionInFactsheet: factsheet.includes(target.region),
          targetStatusInFactsheet: factsheet.includes(target.status),
          targetReferenceInFactsheet: factsheet.includes(target.reference),
        },
        raw: { response: '', usage: null, ms: null, score: score('', target) },
        pxpipe: { response: '', usage: null, ms: null, score: score('', target) },
        error: null,
      };
      try {
        const [raw, pxpipe] = await Promise.all([
          callGeminiRequest({ model: MODEL, request: rawRequest, maxOutputTokens: 2048, timeoutMs: TIMEOUT }),
          callGeminiRequest({ model: MODEL, request: pxpipeRequest, maxOutputTokens: 2048, timeoutMs: TIMEOUT }),
        ]);
        row.raw = { response: raw.text, usage: raw.usage, ms: raw.ms, score: score(raw.text, target) };
        row.pxpipe = { response: pxpipe.text, usage: pxpipe.usage, ms: pxpipe.ms, score: score(pxpipe.text, target) };
      } catch (error) {
        row.error = String(error?.message || error);
      }
      rows.push(row);
      save(rows);
      console.log(
        `${recordsCount} r${repeat + 1} d${depth}: images=${images} ` +
        `raw=${Number(row.raw.score.localization)}/${Number(row.raw.score.recognition)}/${Number(row.raw.score.exact)} ` +
        `px=${Number(row.pxpipe.score.localization)}/${Number(row.pxpipe.score.recognition)}/${Number(row.pxpipe.score.exact)}` +
        (row.error ? ` error=${row.error}` : ''),
      );
    }
  }
}

const result = save(rows);
console.log(JSON.stringify(result.summary, null, 2));
console.log(`Receipt: ${RESULT}`);
