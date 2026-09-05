// Standard quality entrypoint: shared source fixtures and runtime-resolved model profile.
// Historical receipts stay untouched; new results use eval/model-quality/results/.
import { runQuality } from '../model-quality/run.mjs';
await runQuality({ defaultModel: 'workers-ai/@cf/qwen/qwen3.8-27b', suites: ['arithmetic'], liveEnv: 'LIVE' });
