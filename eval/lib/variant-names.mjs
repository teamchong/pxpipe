/**
 * eval/lib/variant-names.mjs
 *
 * The L1 render variants, by name, in run order.
 *
 * Why this exists as its own module: the cost estimator needs the variant COUNT
 * (L1 makes one API call per variant per block), but the variants themselves live
 * in eval-l1-ocr.mjs as closures over the render bridge — importing that file to
 * count them would execute the whole eval. Duplicating the list instead risks the
 * two drifting apart silently, which is exactly the bug this fixes: run-eval.mjs
 * assumed 2 calls per block while L1 was running 11, understating the bill 5.5×.
 *
 * eval-l1-ocr.mjs asserts its VARIANTS array matches this list at startup, so a
 * variant added in one place and not the other fails loudly instead of drifting.
 */
export const L1_VARIANT_NAMES = [
  'baseline',
  'reflow',
  'reflow-6x9',
  'reflow-7x9',
  'reflow-6x10',
  'reflow-7x10',
  'reflow-8x10',
  'aa-5x8',
  'aa-5x8-color',
  'aa-7x10',
  'reflow-inimage',
];
