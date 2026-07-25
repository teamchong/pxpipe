/**
 * Real-task demo setup.
 *
 * template/ is a real project. Each Claude column gets its own /tmp working copy
 * so the two instances edit + run independently.
 *
 * CLEAN, config-isolated run: each copy carries its OWN cc settings, written into
 * the copy's .claude/settings.json below, and is launched with
 * `--setting-sources project` — so cc reads ONLY the project's settings and
 * ignores your global ~/.claude/settings.json (which sets the model + MCP and
 * was the source of the 1m-vs-200k / MCP-loaded confounds). Auth is untouched
 * (it is not a "setting source"), and no credentials are copied into /tmp.
 *
 *   bash demo/cost-ab/setup.sh [model]   # resolves the model, then runs this
 */
import { cpSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(HERE, 'template');

// The project cc config both columns run under — written here so the demo does not
// depend on the operator's ~/.claude/settings.json. MCP intentionally unset.
//
// The model comes from setup.sh's resolver (demo/models.sh) via $DEMO_MODEL_ID and
// is NOT a literal. A hardcoded id here outlived the model it named and quietly made
// every run labelled "opus" measure the wrong model; fail loudly instead of guessing.
const MODEL = process.env.DEMO_MODEL_ID;
if (!MODEL) {
  console.error(
    'setup.mjs: $DEMO_MODEL_ID is not set — refusing to guess a model.\n' +
    'Run the demo entrypoint, which resolves it for you:\n' +
    '  bash demo/cost-ab/setup.sh [model]\n',
  );
  process.exit(1);
}
const PROJECT_CC_SETTINGS = { model: MODEL };

const SIDES = { left: '/tmp/pp-demo-left', right: '/tmp/pp-demo-right' };

for (const [name, dest] of Object.entries(SIDES)) {
  rmSync(dest, { recursive: true, force: true });
  cpSync(TEMPLATE, dest, { recursive: true });
  // assemble the per-copy cc config (the throwaway /tmp .claude/ is never committed)
  mkdirSync(join(dest, '.claude'), { recursive: true });
  writeFileSync(join(dest, '.claude', 'settings.json'), JSON.stringify(PROJECT_CC_SETTINGS, null, 2));
  console.log(`copied template -> ${dest}   (${name} working dir; project cc config seeded)`);
}

const PROMPT =
  'This project has a failing test suite. Read SPEC.md and the source, then fix ' +
  'src/pricing.js so it follows SPEC.md exactly and `node --test` passes. Run the ' +
  'tests to confirm.';

// Both arms run through a proxy so BOTH are logged. LEFT = passthrough (normal),
// RIGHT = pxpipe. See demo/cost-ab/README.md for the 4-terminal layout that starts them.
const ON_PROXY = process.env.DEMO_ON_PROXY ?? 'http://127.0.0.1:47824';   // pxpipe
const OFF_PROXY = process.env.DEMO_OFF_PROXY ?? 'http://127.0.0.1:47823';  // passthrough

// --setting-sources project -> use ONLY the seeded project settings (model [1m],
//   no MCP); ignore the user global ~/.claude/settings.json.
// --strict-mcp-config       -> double-ensure no MCP servers load.
const FLAGS = '--setting-sources project --strict-mcp-config --dangerously-skip-permissions';

console.log(`
Both proxies should already be running in Terminal 1 (see demo/cost-ab/README.md):
  ON  (pxpipe):      PXPIPE_LOG=~/.pxpipe/ab-on.jsonl  PORT=47824 ... node dist/node.js &
  OFF (passthrough): PXPIPE_LOG=~/.pxpipe/ab-off.jsonl PORT=47823 PXPIPE_DISABLE=1 ... node dist/node.js &
(Re-run this script before each A/B iteration to reset both /tmp working copies.)

--- Terminal 3 — LEFT column: normal (through the passthrough, logged) ---
cd /tmp/pp-demo-left  && ANTHROPIC_BASE_URL=${OFF_PROXY} claude ${FLAGS}

--- Terminal 4 — RIGHT column: pxpipe ---
cd /tmp/pp-demo-right && ANTHROPIC_BASE_URL=${ON_PROXY} claude ${FLAGS}

--- paste this prompt into BOTH Claude columns ---
${PROMPT}

Both columns read ONLY the seeded project config (model ${MODEL}, no MCP) and
ignore your global settings — so the only variable is the proxy. Auth is
untouched.

--- verify each ---
node --test          # 5 tests; "pass 5 / fail 0" means done

--- COMPARE ---
node eval/ab/analyze.mjs ~/.pxpipe/ab-on.jsonl ~/.pxpipe/ab-off.jsonl
Also /cost inside each column (the in-session list-$ view; NOT /context, which is
a local pre-proxy estimate and reads the same on both). Read the analyzer output
honestly: the API-$ view is real if you pay per token; the cap?? column ASSUMES
cache reads are free against the Pro/Max cap (UNCONFIRMED rumor, not measured);
and the two columns diverge, so trust the per-request compression line or run a
few times per arm.`);
