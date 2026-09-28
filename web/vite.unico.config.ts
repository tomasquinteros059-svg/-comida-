import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// La demo en UN solo archivo: sin trozos aparte, para poder abrirla sin
// servidor. `inlineDynamicImports` junta el import() del backend de mentira
// adentro del mismo bundle.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist-unico',
    sourcemap: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
