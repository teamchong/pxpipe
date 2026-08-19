/**
 * Unit tests for the Google AI Studio / Gemini API transformer.
 */

import { describe, expect, it } from 'vitest';
import {
  transformGoogleGenerateContent,
  parseGoogleModelFromPath,
  normalizeGoogleTurnRoles,
} from '../src/core/google.js';
import { geminiVisionTokens } from '../src/core/gemini-model-profiles.js';

describe('parseGoogleModelFromPath', () => {
  it('extracts model name from Google AI Studio URL path', () => {
    expect(parseGoogleModelFromPath('/google-ai-studio/v1beta/models/gemini-3.6-flash:generateContent')).toBe('gemini-3.6-flash');
    expect(parseGoogleModelFromPath('/google-ai-studio/v1/models/gemini-3.6-flash:streamGenerateContent')).toBe('gemini-3.6-flash');
    expect(parseGoogleModelFromPath('/v1beta/models/gemini-3.6-flash:streamGenerateContent')).toBeNull();
    expect(parseGoogleModelFromPath('/foo/google-ai-studio/v1beta/models/gemini-3.6-flash:generateContent')).toBeNull();
    expect(parseGoogleModelFromPath('/google-ai-studio/v1beta/models/gemini-3.6-flash:countTokens')).toBeNull();
    expect(parseGoogleModelFromPath('/v1/messages')).toBeNull();
  });
});

describe('transformGoogleGenerateContent', () => {
  it('passes an unvalidated Gemini model through unchanged', async () => {
    const raw = JSON.stringify({
      systemInstruction: { parts: [{ text: 'System instruction. '.repeat(300) }] },
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });
    for (const unmeasuredModel of ['gemini-3.6-flash-preview', 'gemini-3.7-flash-preview', 'gemini-pro']) {
      const result = await transformGoogleGenerateContent(
        new TextEncoder().encode(raw),
        unmeasuredModel,
        { compress: true },
      );

      expect(new TextDecoder().decode(result.body)).toBe(raw);
      expect(result.info.compressed).toBe(false);
      expect(result.info.reason).toBe('unsupported_model');
    }
  });

  it('compresses system instruction for gemini-3.7-flash when above profitability threshold', async () => {
    const sampleBody = {
      systemInstruction: {
        parts: [{ text: 'System instruction text for testing Google transformer. '.repeat(300) }],
      },
      contents: [{ role: 'user', parts: [{ text: 'User question' }] }],
    };
    const bodyBytes = new TextEncoder().encode(JSON.stringify(sampleBody));
    const result = await transformGoogleGenerateContent(bodyBytes, 'gemini-3.7-flash', { compress: true });

    expect(result.info.compressed).toBe(true);
    expect(result.info.imageCount).toBeGreaterThan(0);
    expect(result.info.imageTokens).toBe(result.info.imageDims?.reduce(
      (sum, image) => sum + geminiVisionTokens('gemini-3.7-flash', image.width, image.height),
      0,
    ));
  });

  it('compresses system instruction when above profitability threshold', async () => {
    const sampleBody = {
      systemInstruction: {
        parts: [{ text: 'System instruction text for testing Google transformer. '.repeat(300) }],
      },
      contents: [{ role: 'user', parts: [{ text: 'User question' }] }],
    };
    const bodyBytes = new TextEncoder().encode(JSON.stringify(sampleBody));
    const result = await transformGoogleGenerateContent(bodyBytes, 'gemini-3.6-flash', { compress: true });

    expect(result.info.compressed).toBe(true);
    expect(result.info.imageCount).toBeGreaterThan(0);
    expect(result.info.imageTokens).toBe(result.info.imageDims?.reduce(
      (sum, image) => sum + geminiVisionTokens('gemini-3.6-flash', image.width, image.height),
      0,
    ));
    expect(result.info.baselineImagedTokens).toBeGreaterThan(1078);
    expect(result.info.nativeInjectedTokens).toBeGreaterThan(0);
    expect(result.info.imagePngs).toHaveLength(result.info.imageCount);
    expect(result.info.imageDims).toHaveLength(result.info.imageCount);
    expect(result.info.imageSourceTexts).toHaveLength(result.info.imageCount);
    expect(result.info.firstImagePng).toBe(result.info.imagePngs?.[0]);

    const outReq = JSON.parse(new TextDecoder().decode(result.body));
    expect(outReq.systemInstruction.parts[0].text).toContain('same authority and priority');
    expect(outReq.contents[0].parts[0].inlineData).toBeDefined();
    expect(outReq.contents[0].parts[0].inlineData.mimeType).toBe('image/png');
  });

  it('keeps a short system instruction as text', async () => {
    const sampleBody = {
      systemInstruction: {
        parts: [{ text: 'Short system prompt.' }],
      },
      contents: [{ role: 'user', parts: [{ text: 'User question' }] }],
    };
    const bodyBytes = new TextEncoder().encode(JSON.stringify(sampleBody));
    const result = await transformGoogleGenerateContent(bodyBytes, 'gemini-3.6-flash', { compress: true });

    expect(result.info.compressed).toBe(false);
    expect(result.info.reason).toBe('not_profitable');
    expect(result.info.gateEval?.profitable).toBe(false);
    expect(new TextDecoder().decode(result.body)).toBe(JSON.stringify(sampleBody));
  });

  it('moves Gemini tool descriptions and schema annotations into the static image', async () => {
    const description = 'Read files with detailed operational guidance. '.repeat(180);
    const sampleBody = {
      systemInstruction: {
        parts: [{ text: 'You are a coding agent. '.repeat(120) }],
      },
      tools: [{
        functionDeclarations: [{
          name: 'read',
          description,
          parameters: {
            type: 'object',
            properties: {
              filePath: { type: 'string', description: 'Absolute file path to read.' },
            },
            required: ['filePath'],
          },
        }],
      }],
      contents: [{ role: 'user', parts: [{ text: 'Read the repository.' }] }],
    };
    const result = await transformGoogleGenerateContent(
      new TextEncoder().encode(JSON.stringify(sampleBody)),
      'gemini-3.6-flash',
      { compress: true },
    );

    expect(result.info.compressed).toBe(true);
    expect(result.info.toolDocsChars).toBeGreaterThan(description.length);
    expect(result.info.imageSourceText).toContain('## Tool: read');
    expect(result.info.imageSourceText).toContain('Absolute file path to read.');
    const out = JSON.parse(new TextDecoder().decode(result.body));
    const tool = out.tools[0].functionDeclarations[0];
    expect(tool.description).toContain('## Tool: read');
    expect(tool.description).not.toContain(description.slice(0, 100));
    expect(tool.parameters.properties.filePath.description).toBeUndefined();
    expect(tool.parameters.required).toEqual(['filePath']);
  });

  it('collapses old closed Gemini tool history while keeping the live request and recent tail native', async () => {
    const contents: Array<Record<string, unknown>> = [
      { role: 'user', parts: [{ text: 'LIVE TASK: inspect this repository carefully.' }] },
    ];
    for (let i = 0; i < 24; i++) {
      contents.push({
        role: 'model',
        parts: [{ functionCall: { name: 'read', args: { filePath: `/tmp/file-${i}.ts` } } }],
      });
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: 'read',
            response: { name: 'read', content: `result-${i} `.repeat(180) },
          },
        }],
      });
    }
    const sampleBody = {
      systemInstruction: { parts: [{ text: 'You are a coding agent. '.repeat(300) }] },
      contents,
    };
    const result = await transformGoogleGenerateContent(
      new TextEncoder().encode(JSON.stringify(sampleBody)),
      'gemini-3.6-flash',
      { compress: true, compressToolResults: false },
    );

    expect(result.info.compressed).toBe(true);
    expect(result.info.historyReason).toBe('collapsed');
    expect(result.info.collapsedImages ?? 0).toBeGreaterThan(0);
    expect(result.info.imageCount).toBeGreaterThan(1);
    expect(result.info.baselineImagedTokens ?? 0).toBeGreaterThan(result.info.imageTokens ?? 0);
    const out = JSON.parse(new TextDecoder().decode(result.body));
    const serialized = JSON.stringify(out.contents);
    expect(serialized).toContain('LIVE TASK: inspect this repository carefully.');
    expect(serialized).toContain('Earlier turns in image(s)');
    expect(serialized).toContain('Exact rendered identifiers');
    expect(serialized).toContain('result-23');
    expect(serialized).not.toContain('result-0 result-0 result-0');
    expect(result.info.collapsedImages ?? 0).toBeLessThanOrEqual(72);
    const firstNativeIndex = 1 + (result.info.collapsedTurns ?? 0);
    const firstNativeResponse = contents.slice(firstNativeIndex).find((content) => {
      const parts = content.parts as Array<Record<string, unknown>> | undefined;
      return parts?.some((part) => part.functionResponse !== undefined);
    });
    const firstNativeText = JSON.stringify(firstNativeResponse);
    expect(serialized).toContain(firstNativeText.match(/result-\d+/)?.[0]);
  });

  it('preserves full tools when history compresses but the static slab does not', async () => {
    const contents: Array<Record<string, unknown>> = [
      { role: 'user', parts: [{ text: 'Inspect the repository.' }] },
    ];
    for (let i = 0; i < 24; i++) {
      contents.push({
        role: 'model',
        parts: [{ functionCall: { name: 'read', args: { filePath: `/tmp/file-${i}.ts` } } }],
      });
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name: 'read', response: { content: `result-${i} `.repeat(180) } } }],
      });
    }
    const description = 'Read a file exactly as documented.';
    const sampleBody = {
      systemInstruction: { parts: [{ text: 'You are a coding agent.' }] },
      tools: [{ functionDeclarations: [{
        name: 'read',
        description,
        parameters: {
          type: 'object',
          properties: { filePath: { type: 'string', description: 'Absolute path.' } },
          required: ['filePath'],
        },
      }] }],
      contents,
    };
    const result = await transformGoogleGenerateContent(
      new TextEncoder().encode(JSON.stringify(sampleBody)),
      'gemini-3.6-flash',
      { compress: true, compressToolResults: false },
    );

    expect(result.info.historyReason).toBe('collapsed');
    expect(result.info.bucketChars?.static_slab).toBeUndefined();
    const out = JSON.parse(new TextDecoder().decode(result.body));
    const tool = out.tools[0].functionDeclarations[0];
    expect(tool.description).toBe(description);
    expect(tool.parameters.properties.filePath.description).toBe('Absolute path.');
    expect(out.systemInstruction.parts[0].text).toBe('You are a coding agent.');
  });

  it('collapses completed parallel Gemini function-call rounds', async () => {
    const contents: Array<Record<string, unknown>> = [
      { role: 'user', parts: [{ text: 'LIVE TASK: inspect files in parallel.' }] },
    ];
    for (let i = 0; i < 12; i++) {
      contents.push({
        role: 'model',
        parts: [
          { functionCall: { name: `read_left_${i}`, args: { filePath: `/tmp/left-${i}.ts` } } },
          { functionCall: { name: `read_right_${i}`, args: { filePath: `/tmp/right-${i}.ts` } } },
        ],
      });
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: `read_right_${i}`,
              response: { content: `right-result-${i} `.repeat(220) },
            },
          },
          {
            functionResponse: {
              name: `read_left_${i}`,
              response: { content: `left-result-${i} `.repeat(220) },
            },
          },
        ],
      });
    }
    const sampleBody = {
      systemInstruction: { parts: [{ text: 'You are a coding agent. '.repeat(300) }] },
      contents,
    };
    const result = await transformGoogleGenerateContent(
      new TextEncoder().encode(JSON.stringify(sampleBody)),
      'gemini-3.6-flash',
      { compress: true, compressToolResults: false },
    );

    expect(result.info.historyReason).toBe('collapsed');
    expect(result.info.collapsedTurns ?? 0).toBeGreaterThanOrEqual(10);
    const out = JSON.parse(new TextDecoder().decode(result.body));
    const serialized = JSON.stringify(out.contents);
    expect(serialized).toContain('LIVE TASK: inspect files in parallel.');
    expect(serialized).toContain('Earlier turns in image(s)');
    expect(serialized).not.toContain('left-result-0 left-result-0');
    expect(serialized).not.toContain('right-result-0 right-result-0');
    expect(serialized).toContain('left-result-11');
    expect(serialized).toContain('right-result-11');
  });

  it('compresses a large completed Gemini function response in place', async () => {
    const longResult = Array.from(
      { length: 1200 },
      (_, i) => `src/file-${i}.ts:${i + 1}: exported value ${i}`,
    ).join('\n');
    const sampleBody = {
      systemInstruction: { parts: [{ text: 'You are a coding agent. '.repeat(300) }] },
      contents: [
        { role: 'user', parts: [{ text: 'Inspect the output.' }] },
        { role: 'model', parts: [{ functionCall: { name: 'search', args: { pattern: 'export' } } }] },
        {
          role: 'user',
          parts: [{
            functionResponse: {
              name: 'search',
              response: { name: 'search', content: longResult },
            },
          }],
        },
      ],
    };
    const result = await transformGoogleGenerateContent(
      new TextEncoder().encode(JSON.stringify(sampleBody)),
      'gemini-3.6-flash',
      { compress: true, collapseHistory: false },
    );

    expect(result.info.toolResultImgs ?? 0).toBeGreaterThan(0);
    expect(result.info.imageCount).toBeGreaterThan(1);
    const toolResultChars = (result.info.bucketChars?.tool_result_log ?? 0)
      + (result.info.bucketChars?.tool_result_prose ?? 0)
      + (result.info.bucketChars?.tool_result_json ?? 0);
    expect(toolResultChars).toBe(longResult.length);
    const out = JSON.parse(new TextDecoder().decode(result.body));
    const response = out.contents[2].parts[0].functionResponse;
    expect(response.response.content).toContain('rendered in the attached image');
    expect(response.parts[0].inlineData.mimeType).toBe('image/png');
    expect(JSON.stringify(out)).not.toContain('src/file-1199.ts:1200');
  });

  it('collapses closed history with thought signatures while stamping and preserving tail signatures', async () => {
    const contents: Array<Record<string, unknown>> = [
      { role: 'user', parts: [{ text: 'Initial prompt for task.' }] },
    ];
    for (let i = 0; i < 20; i++) {
      contents.push({
        role: 'model',
        parts: [{
          functionCall: { name: 'read', args: { filePath: `/tmp/file-${i}.ts` } },
          thoughtSignature: `sig-${i}`,
        }],
      });
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: 'read',
            response: { content: `result-${i} `.repeat(180) },
          },
        }],
      });
    }
    const sampleBody = {
      systemInstruction: { parts: [{ text: 'You are a coding agent. '.repeat(300) }] },
      contents,
    };
    const result = await transformGoogleGenerateContent(
      new TextEncoder().encode(JSON.stringify(sampleBody)),
      'gemini-3.6-flash',
      { compress: true, compressToolResults: false },
    );

    expect(result.info.historyReason).toBe('collapsed');
    expect(result.info.collapsedImages ?? 0).toBeGreaterThan(0);
    const out = JSON.parse(new TextDecoder().decode(result.body));
    const serialized = JSON.stringify(out.contents);
    expect(serialized).toContain('Earlier turns in image(s)');
    // The native kept-tail turns retain their thought signatures
    expect(serialized).toContain('sig-19');
  });

  it('stamps thought signature onto unsigned sibling function calls in the same turn', async () => {
    const sampleBody = {
      contents: [
        { role: 'user', parts: [{ text: 'Run tools' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: { name: 'tool_a', args: { cmd: 'ls' } },
              thoughtSignature: 'shared_turn_signature',
            },
            {
              functionCall: { name: 'tool_b', args: { cmd: 'pwd' } },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'tool_a', response: { output: 'a' } } },
            { functionResponse: { name: 'tool_b', response: { output: 'b' } } },
          ],
        },
      ],
    };
    const result = await transformGoogleGenerateContent(
      new TextEncoder().encode(JSON.stringify(sampleBody)),
      'gemini-3.6-flash',
      { compress: false },
    );

    const out = JSON.parse(new TextDecoder().decode(result.body));
    expect(out.contents[1].parts[0].thoughtSignature).toBe('shared_turn_signature');
    expect(out.contents[1].parts[1].thoughtSignature).toBe('shared_turn_signature');
    expect(out.contents[1].parts[1].functionCall.thoughtSignature).toBeUndefined();
    expect(out.contents[1].parts[1].functionCall.thought_signature).toBeUndefined();
  });

  it('stamps thought signature from thought block onto unsigned functionCall parts including position 2', async () => {
    const sampleBody = {
      contents: [
        { role: 'user', parts: [{ text: 'Run complex task' }] },
        {
          role: 'model',
          parts: [
            {
              thought: true,
              text: 'Planning steps...',
              thought_signature: 'sig_from_thought_block',
            },
            {
              functionCall: { name: 'read_file', args: { path: 'foo.ts' } },
            },
            {
              functionCall: { name: 'default_api:task', args: { task_id: '123' }, thought_signature: 'nested_sig' },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'read_file', response: { content: 'ok' } } },
            { functionResponse: { name: 'default_api:task', response: { result: 'done' } } },
          ],
        },
      ],
    };
    const result = await transformGoogleGenerateContent(
      new TextEncoder().encode(JSON.stringify(sampleBody)),
      'gemini-3.6-flash',
      { compress: false },
    );

    const out = JSON.parse(new TextDecoder().decode(result.body));
    const modelTurn = out.contents[1];
    // Position 1: read_file (stamped from thought block donor)
    expect(modelTurn.parts[1].thoughtSignature).toBe('sig_from_thought_block');
    expect(modelTurn.parts[1].functionCall.thought_signature).toBeUndefined();
    expect(modelTurn.parts[1].functionCall.thoughtSignature).toBeUndefined();
    // Position 2: default_api:task (cleans misplaced functionCall.thought_signature and sets part.thoughtSignature)
    expect(modelTurn.parts[2].thoughtSignature).toBe('nested_sig');
    expect(modelTurn.parts[2].functionCall.thought_signature).toBeUndefined();
    expect(modelTurn.parts[2].functionCall.thoughtSignature).toBeUndefined();
  });

  it.each([
    'null',
    '[]',
    '42',
    JSON.stringify({ systemInstruction: { parts: 'bad' } }),
    JSON.stringify({ systemInstruction: { parts: [null] } }),
    JSON.stringify({ systemInstruction: { parts: [{ text: 'x'.repeat(10000) }] }, contents: 'bad' }),
  ])('passes unsupported request shape through unchanged: %s', async (raw) => {
    const bytes = new TextEncoder().encode(raw);
    const result = await transformGoogleGenerateContent(bytes, 'gemini-3.6-flash', { compress: true });
    expect(new TextDecoder().decode(result.body)).toBe(raw);
    expect(result.info.compressed).toBe(false);
  });

  describe('normalizeGoogleTurnRoles', () => {
    it('appends a user turn if the last turn is model', () => {
      const turns = [
        { role: 'user', parts: [{ text: 'hello' }] },
        { role: 'model', parts: [{ text: 'world' }] },
      ];
      const normalized = normalizeGoogleTurnRoles(turns);
      expect(normalized).toHaveLength(3);
      expect(normalized[0]?.role).toBe('user');
      expect(normalized[1]?.role).toBe('model');
      expect(normalized[2]?.role).toBe('user');
      expect(normalized[2]?.parts).toEqual([{ text: ' ' }]);
    });

    it('prepends a user turn if the first turn is model', () => {
      const turns = [
        { role: 'model', parts: [{ text: 'world' }] },
        { role: 'user', parts: [{ text: 'hello' }] },
      ];
      const normalized = normalizeGoogleTurnRoles(turns);
      expect(normalized).toHaveLength(3);
      expect(normalized[0]?.role).toBe('user');
      expect(normalized[0]?.parts).toEqual([{ text: ' ' }]);
      expect(normalized[1]?.role).toBe('model');
      expect(normalized[2]?.role).toBe('user');
    });

    it('merges adjacent turns with the same role', () => {
      const turns = [
        { role: 'user', parts: [{ text: 'part 1' }] },
        { role: 'user', parts: [{ text: 'part 2' }] },
        { role: 'model', parts: [{ text: 'answer' }] },
        { role: 'user', parts: [{ text: 'part 3' }] },
      ];
      const normalized = normalizeGoogleTurnRoles(turns);
      expect(normalized).toHaveLength(3);
      expect(normalized[0]?.role).toBe('user');
      expect(normalized[0]?.parts).toEqual([{ text: 'part 1' }, { text: 'part 2' }]);
      expect(normalized[1]?.role).toBe('model');
      expect(normalized[2]?.role).toBe('user');
    });
  });
});
