import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
  base: process.env.NODE_ENV === 'production' ? '/app-gisat-deckglSandbox/' : '/', // Use '/app/' for production, '/' for development
})
