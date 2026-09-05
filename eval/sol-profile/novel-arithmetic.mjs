// Standard quality entrypoint: shared source fixtures and runtime-resolved model profile.
// Historical receipts stay untouched; new results use eval/model-quality/results/.
import { runQuality } from '../model-quality/run.mjs';
await runQuality({ defaultModel: 'gpt-5.6-sol', suites: ['arithmetic'], liveEnv: 'SOL_QUALITY_LIVE', modelEnv: 'SOL_QUALITY_MODEL' });
