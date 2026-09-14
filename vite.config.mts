// Extension `.mts`, et non `.ts` : ce `package.json` n'a pas `"type": "module"`
// — le processus principal Electron est compilé en CommonJS — donc un
// `vite.config.ts` est chargé comme du CJS alors qu'il est écrit en ESM. Vite 8
// le signale, et son `configLoader: 'native'`, annoncé comme futur défaut,
// refusera le fichier. `.mts` le déclare ESM sans toucher au reste du dépôt.
//
// `import.meta.dirname` remplace donc `__dirname`, absent d'un module ESM.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@shared': path.resolve(import.meta.dirname, 'shared'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'shared/**/*.test.ts', 'electron/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules', 'dist', 'dist-electron'],
  },
});
