import { defineConfig, type Plugin } from 'vitest/config';

/**
 * Plotly's registry has a runtime-conditional require of the maplibre CSS that
 * is only used by map traces. Bundlers include it unconditionally, so replace
 * it with an empty module (map traces are not part of this build).
 */
function dropUnusedMaplibreCss(): Plugin {
  const id = '\0empty-maplibre-css';
  return {
    name: 'drop-unused-maplibre-css',
    enforce: 'pre',
    resolveId(source) {
      return source === 'maplibre-gl/dist/maplibre-gl.css' ? id : null;
    },
    load(loadId) {
      return loadId === id ? '' : null;
    },
  };
}

export default defineConfig({
  // GitHub Pages serves the site from https://<user>.github.io/beamLab/
  base: '/beamLab/',
  plugins: [dropUnusedMaplibreCss()],
  // Some of Plotly's CommonJS dependencies reference Node's `global`.
  define: { global: 'globalThis' },
  build: {
    // Plotly (core + contour + heatmap) is ~1.1 MB minified; this is expected.
    chunkSizeWarningLimit: 1500,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
