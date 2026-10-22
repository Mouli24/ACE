import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Workspace packages resolve to their sources so `pnpm dev` and `pnpm test` need no prior build
 * and edits to the contract hot-reload. The published `dist` is what the engine side consumes.
 */
export const aliases = {
  '@ace/contracts': here('../../packages/contracts/src/index.ts'),
  '@ace/sdk': here('../../packages/sdk/src/index.ts'),
  '@ace/ui/theme.css': here('../../packages/ui/src/theme.css'),
  '@ace/ui': here('../../packages/ui/src/index.ts'),
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: aliases },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173 },
  build: { sourcemap: false },
});
