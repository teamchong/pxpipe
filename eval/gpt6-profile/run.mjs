// Profile-aligned standard suite; old v1 receipts in this directory are historical.
import { runQuality } from '../model-quality/run.mjs';
await runQuality({ defaultModel: 'gpt-6-astra', liveEnv: 'GPT6_LIVE' });
