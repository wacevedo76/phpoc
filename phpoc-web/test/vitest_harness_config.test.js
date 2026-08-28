import { describe, it, expect } from 'vitest';
import viteConfig from '../vite.config.js';

describe('vitest harness config', () => {
  it('A1: test.include is a single glob', () => {
    expect(viteConfig.test.include).toHaveLength(1);
  });

  it('A2: no glob matches node *_test suites', () => {
    expect(viteConfig.test.include.some((g) => g.includes('_test'))).toBe(false);
  });
});
