import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTextToPngsWithCharLimit } from '../../../src/core/render.js';
import { openAIVisionTokens } from '../../../src/core/openai.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = 'gpt-5.6';
const colsGrid = [144, 148, 152, 156, 160];
// Includes the requested values and both sides of the 32 px patch-row boundary.
const heightGrid = [1916, 1920, 1924, 1928, 1932, 1936];
const SHA = '9e43f1b3e31442a93acc504bd7ab466bc83f7860';
const UUID = '019c6e27-e55b-73d1-87d8-4e01f1f75043';
const NEGATION = 'DO NOT submit, publish, email, or mutate cloud state.';
const line = (i: number) =>
  `[${String(i).padStart(4, '0')}] ${SHA} ${UUID} ${NEGATION} ` +
  `Zażółć gęślą jaźń | boundary=${i % 32} | JSON={"mode":"verify","date":"2026-07-10"}`;
const corpus = Array.from({ length: 720 }, (_, i) => line(i)).join('\n');
const corpusCodepoints = [...corpus].length;
const identifierProbe = [SHA, UUID, NEGATION].join('\n');

type Row = Record<string, unknown>;
const rows: Row[] = [];
for (const cols of colsGrid) {
  for (const maxHeightPx of heightGrid) {
    // Deliberately lift the production char-page budget: this experiment isolates
    // maxHeightPx, rather than letting READABLE_CHARS_PER_IMAGE bind first.
    // Keep below signed-int max because the renderer intentionally normalizes the
    // public budget with `| 0`.
    const unbindingCharBudget = 2_000_000_000;
    const images = await renderTextToPngsWithCharLimit(corpus, cols, unbindingCharBudget, {}, maxHeightPx);
    const identifierImages = await renderTextToPngsWithCharLimit(identifierProbe, cols, unbindingCharBudget, {}, maxHeightPx);
    const dims = images.map(({ width, height }) => ({ width, height }));
    const imageTokens = images.map(({ width, height }) => openAIVisionTokens(MODEL, width, height));
    const renderedCodepoints = images.reduce((n, x) => n + x.charsRendered, 0);
    const droppedChars = images.reduce((n, x) => n + x.droppedChars, 0);
    rows.push({
      cols, maxHeightPx, imageCount: images.length, dims, imageTokens,
      totalImageTokens: imageTokens.reduce((a, b) => a + b, 0),
      renderedCodepoints, corpusCodepoints, droppedChars,
      rendererCoverageProxy: droppedChars === 0,
      exactIdentifierCoverageProxy: identifierImages.every(x => x.droppedChars === 0),
      pngSha256: images.map(x => createHash('sha256').update(x.png).digest('hex')),
      shortestSideFloorSafe: dims.every(d => d.width <= 768),
    });
  }
}

const evidence = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  model: MODEL,
  grids: { stripCols: colsGrid, maxHeightPx: heightGrid },
  corpus: {
    generator: '720 deterministic numbered lines', codepoints: corpusCodepoints,
    sha256: createHash('sha256').update(corpus).digest('hex'),
    exactIdentifiers: [SHA, UUID, NEGATION],
  },
  limitations: {
    ocr: 'Unavailable: tesseract is not installed. renderer/exact-identifier coverage proxies prove atlas coverage, not model OCR.',
    liveCanary: 'Not performed by this offline-only bounded task; no profile may be enabled from this evidence alone.',
  },
  rows,
};

await mkdir(HERE, { recursive: true });
await writeFile(join(HERE, 'corpus.txt'), corpus, 'utf8');
await writeFile(join(HERE, 'results.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
console.log(`wrote ${rows.length} grid rows; corpus=${corpusCodepoints} codepoints`);
