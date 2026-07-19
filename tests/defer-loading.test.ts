/**
 * Tools managed by Anthropic's tool-search beta must pass through the tool
 * rewrite untouched.
 *
 * A tool marked `defer_loading: true` is not injected into context until the
 * model searches for it — the server bills it at ~zero until then. Rewriting
 * it (stub description + annotation-stripped schema) and rendering its full
 * docs into the imaged Tool Reference would materialize documentation the API
 * was deliberately keeping out of context: with a large MCP surface, Claude
 * Code ships hundreds of deferred tools (~477k chars observed), all of which
 * were being imaged into every request. The search tool itself
 * (`tool_search_tool_regex_20251119` / `_bm25_`) is schema-less and
 * server-defined and must also survive byte-identical.
 *
 * Contract being verified:
 *   - `defer_loading: true` tools keep their original description and
 *     input_schema and gain no stub.
 *   - `tool_search_tool_*` server tools pass through unchanged.
 *   - Deferred tools' docs do NOT count toward info.toolDocsChars.
 *   - Non-deferred tools in the same request are still rewritten (stubbed).
 *   - A request with no deferred tools behaves exactly as before.
 */

import { describe, expect, it } from 'vitest';
import { transformRequest } from '../src/core/transform.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

const DEFERRED_DESC =
  'Query the observability backend for traces. '.repeat(40);
const PLAIN_DESC = 'Run a shell command in the workspace. '.repeat(40);

function makeReq(tools: unknown[]) {
  return enc.encode(
    JSON.stringify({
      model: 'claude-3-5-sonnet',
      // Large static slab so the compression path definitely runs.
      system: 'x'.repeat(80_000),
      tools,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  );
}

function parse(body: Uint8Array): any {
  return JSON.parse(dec.decode(body));
}

const deferredTool = {
  name: 'mcp__datadog__get_traces',
  description: DEFERRED_DESC,
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Trace search query' },
    },
    required: ['query'],
  },
  defer_loading: true,
};

const searchTool = {
  type: 'tool_search_tool_regex_20251119',
  name: 'tool_search_tool_regex',
};

const plainTool = {
  name: 'bash',
  description: PLAIN_DESC,
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to execute' },
    },
    required: ['command'],
  },
};

describe('defer_loading tools pass through the tool rewrite', () => {
  it('leaves deferred tools byte-identical and still rewrites the rest', async () => {
    const { body, info } = await transformRequest(
      makeReq([searchTool, deferredTool, plainTool]),
      {},
    );
    const out = parse(body);
    expect(out.tools).toHaveLength(3);

    const [outSearch, outDeferred, outPlain] = out.tools;

    // Search tool: byte-identical.
    expect(outSearch).toEqual(searchTool);

    // Deferred tool: original description + schema + flag survive; no stub.
    expect(outDeferred).toEqual(deferredTool);
    expect(outDeferred.description).toBe(DEFERRED_DESC);
    expect(outDeferred.input_schema.properties.query.description).toBe(
      'Trace search query',
    );

    // Plain tool: still rewritten — stub description pointing at the
    // Tool Reference, schema annotations stripped.
    expect(outPlain.description).toContain('## Tool: bash');
    expect(outPlain.description).not.toBe(PLAIN_DESC);
    expect(outPlain.input_schema.properties.command.description).toBeUndefined();

    // Deferred docs excluded from the imaged reference accounting.
    expect(info.toolDocsChars).toBeGreaterThan(0);
    expect(info.toolDocsChars!).toBeLessThan(
      PLAIN_DESC.length + DEFERRED_DESC.length,
    );
  });

  it('keeps deferred docs out of the imaged Tool Reference text', async () => {
    const { body } = await transformRequest(
      makeReq([deferredTool, plainTool]),
      {},
    );
    const out = parse(body);
    // The system field carries the imaged slab plus any text tail; no
    // rendered remnant of the deferred tool's doc heading should exist
    // anywhere in the outgoing body except the tool's own definition.
    const raw = dec.decode(body);
    expect(raw).not.toContain('## Tool: mcp__datadog__get_traces');
    expect(raw).toContain('## Tool: bash');
    // And the deferred tool's full description exists exactly once — in
    // its own tools[] entry, not duplicated into any reference text.
    expect(raw.split(DEFERRED_DESC).length - 1).toBe(1);
    expect(out.tools[0]).toEqual(deferredTool);
  });

  it('is a no-op for requests without deferred tools', async () => {
    const { body } = await transformRequest(makeReq([plainTool]), {});
    const out = parse(body);
    expect(out.tools[0].description).toContain('## Tool: bash');
  });

  it('stays byte-identical when every tool is deferred and the request falls below the compression gate', async () => {
    // Tiny system prompt + all-deferred tools -> toolDocsText stays empty and
    // combinedRaw lands under minCompressChars, taking the below_min_chars
    // early return (before req.tools = toolsRewritten runs). The passthrough
    // this suite verifies elsewhere must still hold on that path.
    const req = {
      model: 'claude-3-5-sonnet',
      system: 'hi',
      tools: [searchTool, deferredTool],
      messages: [{ role: 'user', content: 'hello' }],
    };
    const reqBytes = enc.encode(JSON.stringify(req));
    const { body, info } = await transformRequest(reqBytes, {});
    expect(info.compressed).toBe(false);
    expect(dec.decode(body)).toBe(dec.decode(reqBytes));
    const out = parse(body);
    expect(out.tools).toEqual([searchTool, deferredTool]);
  });
});
