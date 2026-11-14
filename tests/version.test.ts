import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '../core/model/version';
import pkg from '../package.json';

describe('APP_VERSION', () => {
  it('is a semver string matching package.json', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
    expect(APP_VERSION).toBe(pkg.version);
  });
});
