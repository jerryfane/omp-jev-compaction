import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Offline tests run with a throwaway HOME, so a test that spills without naming a
 * directory cannot write into the real ~/.omp/jev-spill. Live tests (JEV_LIVE=1) keep
 * the real HOME, which they need for the omp provider settings.
 */
export const TEST_HOME = join(tmpdir(), `omp-jev-compaction-test-home-${process.pid}`);

export default defineConfig({
  test: {
    env: process.env.JEV_LIVE ? {} : { HOME: TEST_HOME },
    globalSetup: process.env.JEV_LIVE ? [] : ['./tests/global-setup.ts'],
  },
});
