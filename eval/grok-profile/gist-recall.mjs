// Standard quality entrypoint: shared source fixtures and runtime-resolved model profile.
// Historical receipts stay untouched; new results use eval/model-quality/results/.
import { runQuality } from '../model-quality/run.mjs';
await runQuality({ defaultModel: 'grok-4.6', suites: ['gist'], liveEnv: 'GROK_QUALITY_LIVE', modelEnv: 'GROK_QUALITY_MODEL' });
