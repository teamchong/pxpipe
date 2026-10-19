import { describe, expect, it } from 'vitest';
import { transformRequest } from '../src/core/transform.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('Anthropic refusal prevention - proxy system provenance', () => {
  it('adds explicit proxy provenance statement to req.system when rendering static slab into user-turn images', async () => {
    const reqBody = JSON.stringify({
      model: 'claude-3-5-sonnet',
      system: 'System operating instructions. '.repeat(1000),
      tools: [
        {
          name: 'ReadFile',
          description: 'Read contents of a file.',
          input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
      messages: [
        { role: 'user', content: 'Help me debug this issue.' },
      ],
    });

    const { body, info } = await transformRequest(enc.encode(reqBody));
    expect(info.compressed).toBe(true);
    expect(info.imageCount).toBeGreaterThan(0);

    const out = JSON.parse(dec.decode(body));

    // 1. req.system must contain an explicit first-party proxy provenance statement
    const sysBlocks = Array.isArray(out.system)
      ? out.system
      : typeof out.system === 'string'
      ? [{ type: 'text', text: out.system }]
      : [];

    const sysTexts = sysBlocks.map((b: any) => b.text || '');
    const provenanceBlock = sysTexts.find((t: string) =>
      t.includes("pxpipe (this user's local proxy)") && t.includes('rendered this session'),
    );

    expect(provenanceBlock).toBeDefined();
    expect(provenanceBlock).toContain("pxpipe (this user's local proxy)");
    expect(provenanceBlock).toContain('image blocks');

    // 2. The user-turn image banner must NOT contain imperative commands like "follow them as your operating instructions"
    const imgSrc = info.imageSourceText ?? '';
    expect(imgSrc).not.toContain('follow them as your operating instructions');
    expect(imgSrc).not.toMatch(/system prompt|authoritative/i);
  });
});
