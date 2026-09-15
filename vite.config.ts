import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The version the about sheet reports. Read from the manifest rather than kept
// as a second copy, which is the copy that would be wrong after a release.
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2023',
    // libheif is a ~2MB wasm bundle, pulled in only when a HEIF file is opened.
    chunkSizeWarningLimit: 2600,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
