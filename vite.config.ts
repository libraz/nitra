import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
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
