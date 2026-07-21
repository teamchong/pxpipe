// Controlled diagnostic for Gemini 3.6 Flash RGB separation.
// Compares one candidate RGB-overprint image with exact channel extractions from that same PNG.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { callGemini } from './gemini-client.mjs';
import { renderRgbMultiplex } from '../sol-profile/rgb-multiplex-renderer.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '.work', 'rgb-separation-diagnostic');
const RESULT = join(HERE, 'rgb-separation-diagnostic-results.json');
const MODEL = process.env.MODEL || 'gemini-3.6-flash';
const LIVE = process.env.LIVE === '1';
const TIMEOUT = Number(process.env.TIMEOUT_MS || 120000);
mkdirSync(OUT, { recursive: true });

const words = [
  'amber', 'birch', 'cedar', 'delta', 'ember', 'fjord', 'grove', 'harbor',
  'ivory', 'jungle', 'karma', 'linen', 'maple', 'north', 'olive', 'pearl',
  'quartz', 'river', 'solar', 'tulip', 'umber', 'violet', 'willow', 'xenon',
  'yellow', 'zephyr', 'acorn', 'bloom', 'coral', 'dune', 'elm', 'flint',
  'glade', 'hazel', 'iris', 'jade',
];
const logical = Array.from({ length: 36 }, (_, i) => {
  const code = String((i * 7919 + 104729) % 100000).padStart(5, '0');
  return `L${String(i + 1).padStart(2, '0')} word=${words[i]} code=${code}`;
});
const expected = {
  red: logical.filter((_, i) => i % 3 === 0),
  green: logical.filter((_, i) => i % 3 === 1),
  blue: logical.filter((_, i) => i % 3 === 2),
};

const images = renderRgbMultiplex(logical.join('\n'), { cols: 95, maxHeightPx: 1932 });
if (images.length !== 1) throw new Error(`expected one diagnostic image, got ${images.length}`);
const combined = images[0];
writeFileSync(join(OUT, 'combined.png'), combined.png);

const decoded = await loadImage(Buffer.from(combined.png));
const sourceCanvas = createCanvas(decoded.width, decoded.height);
const sourceCtx = sourceCanvas.getContext('2d');
sourceCtx.drawImage(decoded, 0, 0);
const source = sourceCtx.getImageData(0, 0, decoded.width, decoded.height).data;
const channelNames = ['red', 'green', 'blue'];
const artifacts = { combined: combined.png };

for (let channel = 0; channel < 3; channel++) {
  for (const grayscale of [false, true]) {
    const canvas = createCanvas(decoded.width, decoded.height);
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(decoded.width, decoded.height);
    for (let i = 0; i < decoded.width * decoded.height; i++) {
      const value = source[i * 4 + channel];
      image.data[i * 4] = grayscale ? value : channel === 0 ? value : 0;
      image.data[i * 4 + 1] = grayscale ? value : channel === 1 ? value : 0;
      image.data[i * 4 + 2] = grayscale ? value : channel === 2 ? value : 0;
      image.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    const name = `${channelNames[channel]}-${grayscale ? 'white' : 'color'}`;
    artifacts[name] = canvas.toBuffer('image/png');
    writeFileSync(join(OUT, `${name}.png`), artifacts[name]);
  }
}

const imagePart = (png) => ({
  type: 'input_image',
  image_url: `data:image/png;base64,${Buffer.from(png).toString('base64')}`,
});

function parseJson(text) {
  const start = Math.min(...['{', '['].map((ch) => {
    const i = text.indexOf(ch); return i < 0 ? Infinity : i;
  }));
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (!Number.isFinite(start) || end < start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function score(expectedLines, answer) {
  const got = Array.isArray(answer) ? answer.map(String) : [];
  const exact = expectedLines.filter((line) => got.includes(line)).length;
  return { exact, total: expectedLines.length, got };
}

async function run() {
  console.log(`=== Gemini 3.6 Flash RGB Channel Separation Diagnostic ===\n`);
  const rows = [];

  if (LIVE) {
    // 1. Combined RGB arm
    console.log('Testing combined RGB arm...');
    const combinedPrompt = [
      'This image overlays three independent text streams in RGB color channels.',
      'Within each physical row, read RED first, then GREEN, then BLUE.',
      'Return only JSON with keys red, green, blue. Each value must be an array of the 12 exact lines in reading order.',
    ].join(' ');
    try {
      const response = await callGemini({
        model: MODEL,
        content: [imagePart(artifacts.combined), { type: 'input_text', text: combinedPrompt }],
        maxOutputTokens: 1600,
        timeoutMs: TIMEOUT,
      });
      const parsed = parseJson(response.text) || {};
      const row = {
        arm: 'combined',
        red: score(expected.red, parsed.red),
        green: score(expected.green, parsed.green),
        blue: score(expected.blue, parsed.blue),
        raw: response.text,
        usage: response.usage,
        ms: response.ms,
      };
      rows.push(row);
      console.log(`Combined RGB -> Red: ${row.red.exact}/12, Green: ${row.green.exact}/12, Blue: ${row.blue.exact}/12`);
    } catch (error) {
      console.error('Error on combined RGB:', error.message);
      rows.push({ arm: 'combined', error: String(error?.message || error) });
    }

    // 2. Extracted single channels
    for (const channel of channelNames) {
      for (const mode of ['color', 'white']) {
        const arm = `${channel}-${mode}`;
        console.log(`Testing extracted arm ${arm}...`);
        const prompt = `Read the single visible text stream. Return only a JSON array containing all 12 exact lines in top-to-bottom order.`;
        try {
          const response = await callGemini({
            model: MODEL,
            content: [imagePart(artifacts[arm]), { type: 'input_text', text: prompt }],
            maxOutputTokens: 700,
            timeoutMs: TIMEOUT,
          });
          const sc = score(expected[channel], parseJson(response.text));
          rows.push({
            arm,
            score: sc,
            raw: response.text,
            usage: response.usage,
            ms: response.ms,
          });
          console.log(`Extracted ${arm} -> ${sc.exact}/12`);
        } catch (error) {
          console.error(`Error on ${arm}:`, error.message);
          rows.push({ arm, error: String(error?.message || error) });
        }
      }
    }

    // 3. Combined focused arms
    for (const channel of channelNames) {
      const arm = `combined-focus-${channel}`;
      console.log(`Testing focused arm ${arm}...`);
      const prompt = `Ignore every other color. Read only the ${channel.toUpperCase()} text stream from this RGB-overlaid image. Return only a JSON array containing its 12 exact lines in top-to-bottom order.`;
      try {
        const response = await callGemini({
          model: MODEL,
          content: [imagePart(artifacts.combined), { type: 'input_text', text: prompt }],
          maxOutputTokens: 700,
          timeoutMs: TIMEOUT,
        });
        const sc = score(expected[channel], parseJson(response.text));
        rows.push({
          arm,
          score: sc,
          raw: response.text,
          usage: response.usage,
          ms: response.ms,
        });
        console.log(`Focused ${arm} -> ${sc.exact}/12`);
      } catch (error) {
        console.error(`Error on ${arm}:`, error.message);
        rows.push({ arm, error: String(error?.message || error) });
      }
    }
  }

  const result = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    live: LIVE,
    image: { width: combined.width, height: combined.height, bytes: combined.png.length },
    expected,
    rows,
  };
  writeFileSync(RESULT, JSON.stringify(result, null, 2) + '\n');
  console.log(`\nRGB diagnostic results saved to ${RESULT}`);
}

run();
