#!/usr/bin/env node
/**
 * eval/ab/variants.mjs — A/B test variant definitions
 *
 * Defines 13 variants for systematic QW evaluation:
 * - A0: bypass (PXPIPE_DISABLE=1)
 * - A1: baseline (all QW OFF)
 * - B01–B10: individual QW ON (each one in isolation)
 *   - Exception: B06 = both QW02+QW06 ON (per debata werdykt)
 * - B-all: all QW ON
 *
 * Returns an array of { name, env } objects for runner to consume.
 * QW07 is specially handled for cold vs warm cache in runner.
 */

/**
 * @typedef {Object} Variant
 * @property {string} name — variant identifier (e.g. 'A0', 'B01', 'B-all')
 * @property {Record<string, string>} env — environment variables to set
 *   (PXPIPE_QWxx, PXPIPE_DISABLE, etc.)
 */

export const VARIANTS = [
  // Arm A: Control arms
  {
    name: 'A0-bypass',
    env: {
      PXPIPE_DISABLE: '1',
    },
  },
  {
    name: 'A1-baseline',
    env: {
      // All QW OFF (default)
      PXPIPE_QW01: '0',
      PXPIPE_QW02: '0',
      PXPIPE_QW03: '0',
      PXPIPE_QW04: '0',
      PXPIPE_QW05: '0',
      PXPIPE_QW06: '0',
      PXPIPE_QW07: '0',
      PXPIPE_QW08: '0',
      PXPIPE_QW09: '0',
      PXPIPE_QW10: '0',
    },
  },

  // Arm B: Individual QW isolation
  {
    name: 'B01-qw01',
    env: {
      PXPIPE_QW01: '1',
      PXPIPE_QW02: '0',
      PXPIPE_QW03: '0',
      PXPIPE_QW04: '0',
      PXPIPE_QW05: '0',
      PXPIPE_QW06: '0',
      PXPIPE_QW07: '0',
      PXPIPE_QW08: '0',
      PXPIPE_QW09: '0',
      PXPIPE_QW10: '0',
    },
  },
  {
    name: 'B02-qw02',
    env: {
      PXPIPE_QW01: '0',
      PXPIPE_QW02: '1',
      PXPIPE_QW03: '0',
      PXPIPE_QW04: '0',
      PXPIPE_QW05: '0',
      PXPIPE_QW06: '0',
      PXPIPE_QW07: '0',
      PXPIPE_QW08: '0',
      PXPIPE_QW09: '0',
      PXPIPE_QW10: '0',
    },
  },
  {
    name: 'B03-qw03',
    env: {
      PXPIPE_QW01: '0',
      PXPIPE_QW02: '0',
      PXPIPE_QW03: '1',
      PXPIPE_QW04: '0',
      PXPIPE_QW05: '0',
      PXPIPE_QW06: '0',
      PXPIPE_QW07: '0',
      PXPIPE_QW08: '0',
      PXPIPE_QW09: '0',
      PXPIPE_QW10: '0',
    },
  },
  {
    name: 'B04-qw04',
    env: {
      PXPIPE_QW01: '0',
      PXPIPE_QW02: '0',
      PXPIPE_QW03: '0',
      PXPIPE_QW04: '1',
      PXPIPE_QW05: '0',
      PXPIPE_QW06: '0',
      PXPIPE_QW07: '0',
      PXPIPE_QW08: '0',
      PXPIPE_QW09: '0',
      PXPIPE_QW10: '0',
    },
  },
  {
    name: 'B05-qw05',
    env: {
      PXPIPE_QW01: '0',
      PXPIPE_QW02: '0',
      PXPIPE_QW03: '0',
      PXPIPE_QW04: '0',
      PXPIPE_QW05: '1',
      PXPIPE_QW06: '0',
      PXPIPE_QW07: '0',
      PXPIPE_QW08: '0',
      PXPIPE_QW09: '0',
      PXPIPE_QW10: '0',
    },
  },
  {
    name: 'B06-qw02+qw06',
    env: {
      PXPIPE_QW01: '0',
      PXPIPE_QW02: '1',
      PXPIPE_QW03: '0',
      PXPIPE_QW04: '0',
      PXPIPE_QW05: '0',
      PXPIPE_QW06: '1',
      PXPIPE_QW07: '0',
      PXPIPE_QW08: '0',
      PXPIPE_QW09: '0',
      PXPIPE_QW10: '0',
    },
  },
  {
    name: 'B07-qw07-cold',
    env: {
      PXPIPE_QW01: '0',
      PXPIPE_QW02: '0',
      PXPIPE_QW03: '0',
      PXPIPE_QW04: '0',
      PXPIPE_QW05: '0',
      PXPIPE_QW06: '0',
      PXPIPE_QW07: '1',
      PXPIPE_QW08: '0',
      PXPIPE_QW09: '0',
      PXPIPE_QW10: '0',
      // Marker for runner: clean cache before each run
      _CACHE_MODE: 'cold',
    },
  },
  {
    name: 'B07-qw07-warm',
    env: {
      PXPIPE_QW01: '0',
      PXPIPE_QW02: '0',
      PXPIPE_QW03: '0',
      PXPIPE_QW04: '0',
      PXPIPE_QW05: '0',
      PXPIPE_QW06: '0',
      PXPIPE_QW07: '1',
      PXPIPE_QW08: '0',
      PXPIPE_QW09: '0',
      PXPIPE_QW10: '0',
      // Marker for runner: reuse cache across runs (warm)
      _CACHE_MODE: 'warm',
    },
  },
  {
    name: 'B08-qw08',
    env: {
      PXPIPE_QW01: '0',
      PXPIPE_QW02: '0',
      PXPIPE_QW03: '0',
      PXPIPE_QW04: '0',
      PXPIPE_QW05: '0',
      PXPIPE_QW06: '0',
      PXPIPE_QW07: '0',
      PXPIPE_QW08: '1',
      PXPIPE_QW09: '0',
      PXPIPE_QW10: '0',
    },
  },
  {
    name: 'B09-qw09',
    env: {
      PXPIPE_QW01: '0',
      PXPIPE_QW02: '0',
      PXPIPE_QW03: '0',
      PXPIPE_QW04: '0',
      PXPIPE_QW05: '0',
      PXPIPE_QW06: '0',
      PXPIPE_QW07: '0',
      PXPIPE_QW08: '0',
      PXPIPE_QW09: '1',
      PXPIPE_QW10: '0',
    },
  },
  {
    name: 'B10-qw10',
    env: {
      PXPIPE_QW01: '0',
      PXPIPE_QW02: '0',
      PXPIPE_QW03: '0',
      PXPIPE_QW04: '0',
      PXPIPE_QW05: '0',
      PXPIPE_QW06: '0',
      PXPIPE_QW07: '0',
      PXPIPE_QW08: '0',
      PXPIPE_QW09: '0',
      PXPIPE_QW10: '1',
    },
  },

  // Arm B: All-on
  {
    name: 'B-all-on',
    env: {
      PXPIPE_QW01: '1',
      PXPIPE_QW02: '1',
      PXPIPE_QW03: '1',
      PXPIPE_QW04: '1',
      PXPIPE_QW05: '1',
      PXPIPE_QW06: '1',
      PXPIPE_QW07: '1',
      PXPIPE_QW08: '1',
      PXPIPE_QW09: '1',
      PXPIPE_QW10: '1',
    },
  },
];

export default VARIANTS;
