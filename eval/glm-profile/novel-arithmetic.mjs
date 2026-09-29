// Standard quality entrypoint: shared source fixtures and runtime-resolved model profile.
// Historical receipts stay untouched; new results use eval/model-quality/results/.
import { runQuality } from '../model-quality/run.mjs';
await runQuality({ defaultModel: '@cf/zai-org/glm-5.3-flash', suites: ['arithmetic'], liveEnv: 'LIVE' });
