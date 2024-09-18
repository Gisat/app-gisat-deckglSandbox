import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // base: '/app-gisat-deckglSandbox/'
  base: process.env.NODE_ENV === 'production' ? '/app/' : '/', // Use '/app/' for production, '/' for development
})
