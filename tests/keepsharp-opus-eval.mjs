import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

// Start pxpipe on port 47822 with keepSharp and all patterns enabled
console.log('Starting pxpipe on port 47822 with keepSharp (incl. number) enabled...');
const proxy = spawn('node', ['dist/node.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: '47822',
    PXPIPE_MODELS: 'claude-3-5-opus-20241022', // Update to the new Opus model identifier when released
    PXPIPE_KEEPSHARP_ENABLED: 'true',
    PXPIPE_KEEPSHARP_PATTERNS: 'hex,path,port,flag,number',
    PXPIPE_EVENTS: 'scratch_events.jsonl'
  },
  stdio: 'inherit'
});

proxy.on('error', (err) => {
  console.error('Failed to start proxy:', err);
  process.exit(1);
});

// Wait 2 seconds for proxy to bind
await setTimeout(2000);

async function sendRequest(label, toolResultContent) {
  console.log(`\n--- Sending ${label} ---`);
  const requestBody = {
    model: 'claude-3-5-opus-20241022', // Update to the new Opus model identifier when released
    max_tokens: 100,
    system: 's'.repeat(2500),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_dummy_id_123',
            content: toolResultContent
          }
        ]
      }
    ]
  };

  try {
    await fetch('http://127.0.0.1:47822/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'sk-ant-dummy-key-for-local-testing',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(requestBody)
    });
  } catch (e) {
    // 401 Expected on dummy key
  }

  // Wait for proxy tracker to write telemetry
  await setTimeout(1000);

  // Fetch telemetry
  try {
    const statsRes = await fetch('http://127.0.0.1:47822/proxy-recent');
    const statsData = await statsRes.json();
    const recentList = statsData.recent || statsData;
    const postRequests = Array.isArray(recentList) ? recentList.filter(r => r.method === 'POST' && r.path === '/v1/messages') : [];
    const latest = postRequests[postRequests.length - 1];
    
    console.log(`Telemetry for ${label}:`);
    console.log(JSON.stringify(latest, null, 2));
  } catch (e) {
    console.error('Failed to fetch telemetry:', e.message);
  }
}

// 1. Tool result content with keepSharp tokens (path, port, flag, number)
const keepSharpContent = 'This tool result output contains path: D:/JaskierTools/pxpipe/src/core/keepsharp.ts, flag: --verbose, port: 47821, commit: e8a510f2c6a782b8, and numbers: 543210.\n' + 'x'.repeat(7000);

// 2. Tool result content with pure text (no patterns matched)
const pureContent = 'This is a pure text tool result block with no paths, no ports, no hex hashes, no CLI flags, and no numbers.\n' + 'x'.repeat(7000);

await sendRequest('Request with keepSharp Tokens in tool_result (Should NOT compress)', keepSharpContent);
await sendRequest('Request with Pure Text in tool_result (Should COMPRESS)', pureContent);

console.log('\nStopping local proxy...');
proxy.kill();
