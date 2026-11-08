import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Offline tests run with a throwaway HOME, so a test that spills without naming a
 * directory cannot write into the real ~/.omp/jev-spill. Live tests (JEV_LIVE=1) keep
 * the real HOME, which they need for the omp provider settings.
 */
export const TEST_HOME = join(tmpdir(), `omp-jev-compaction-test-home-${process.pid}`);
/** Same predicate as tests/live.test.ts: only JEV_LIVE=1 runs live tests. */
const live = process.env.JEV_LIVE === '1';

export default defineConfig({
  test: {
    env: live ? {} : { HOME: TEST_HOME },
    globalSetup: live ? [] : ['./tests/global-setup.ts'],
  },
});
