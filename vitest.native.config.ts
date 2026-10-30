import { defineConfig } from 'vitest/config';
import base from './vitest.config';

export default defineConfig({
  ...base,
  test: { ...base.test, include: ['tests/native/**/*.integration.test.ts'], fileParallelism: false },
});
