// Transport selection is separate from rendering: all clients receive the SAME
// profile-derived content parts. No client may substitute a font or fixture.
export function inferenceSettings(model) {
  const family = /gemini/i.test(model) ? 'gemini' : /qwen/i.test(model) ? 'qwen'
    : /glm/i.test(model) ? 'glm' : /grok/i.test(model) ? 'grok'
    : /claude/i.test(model) ? 'claude' : /kimi/i.test(model) ? 'kimi' : 'responses';
  const reasoning = family === 'grok' ? process.env.GROK_QUALITY_REASONING_EFFORT || 'high'
    : family === 'responses' ? process.env.QUALITY_REASONING || (/gpt-6/i.test(model) ? 'low' : 'none')
    : 'provider-default';
  return { family, reasoning };
}
export async function callModel(args) {
  const { family, reasoning } = inferenceSettings(args.model);
  // Do not send a pre-rendered eval through pxpipe for a second transformation.
  if (family !== 'claude') {
    const base = family === 'kimi' ? process.env.KIMI_QUALITY_BASE_URL : process.env.OPENAI_BASE_URL;
    if (!base || new URL(base).port === '47821') throw new Error('Quality eval needs an explicit direct upstream, not the pxpipe port');
  }
  if (family === 'gemini') return (await import('../gemini-profile/gemini-client.mjs')).callGemini(args);
  if (family === 'qwen') return (await import('../qwen-profile/qwen-client.mjs')).callQwen(args);
  if (family === 'glm') return (await import('../glm-profile/glm-client.mjs')).callGlm(args);
  if (family === 'grok') return (await import('../grok-profile/responses-client.mjs')).callResponses(args);
  return (await import('../sol-profile/responses-client.mjs')).callResponses({ ...args, reasoningEffort: reasoning });
}
