import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // Relative asset URLs, so the same build works at its GitHub Pages address and at
  // raymondz.dev/tools/stability-analyzer/, where the portfolio's Cloudflare Worker serves it.
  base: './',
  plugins: [react()],
})
