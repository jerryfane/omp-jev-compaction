import { mkdirSync, rmSync } from 'node:fs';
import { TEST_HOME } from '../vitest.config.js';

/** Creates the throwaway HOME for offline tests and removes it when the run ends. */
export default function setup(): () => void {
  mkdirSync(TEST_HOME, { recursive: true });
  return () => rmSync(TEST_HOME, { recursive: true, force: true });
}
