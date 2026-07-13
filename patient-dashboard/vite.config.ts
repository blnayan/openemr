import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Base URL for all assets in the built output.
  // The PHP entry point serves assets from this path.
  base: '/public/assets/patient-dashboard/',
  build: {
    // Emit bundle into OpenEMR's static asset directory so the existing
    // Docker image serves it without any additional configuration.
    outDir: path.resolve(__dirname, '../public/assets/patient-dashboard'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Predictable (no-hash) filenames so the PHP entry-point can
        // hardcode the script src without needing to read a manifest.
        entryFileNames: 'index.js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
