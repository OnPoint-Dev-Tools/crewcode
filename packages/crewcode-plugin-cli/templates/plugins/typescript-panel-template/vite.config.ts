import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'compiled',
    emptyOutDir: true,
    rollupOptions: {
      input: { panel: 'src/panel.html' },
    },
  },
})
