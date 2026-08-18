#!/usr/bin/env node
// Tiny shim: dispatch the dedicated Codex launcher before the bundled server
// entry. All other CLI logic remains in src/node.ts.
const entry = process.argv[2] === 'codex' ? '../dist/codex-entry.js' : '../dist/node.js';
import(entry).catch((err) => {
  console.error('[pxpipe] failed to start:', err);
  console.error('[pxpipe] did you forget to `npm run build`?');
  process.exit(1);
});
