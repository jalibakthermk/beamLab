import { defineConfig } from 'vitest/config';

export default defineConfig({
  // GitHub Pages serves the site from https://<user>.github.io/beamLab/
  base: '/beamLab/',
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
