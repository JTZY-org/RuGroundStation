import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react()],
  plugins: [react(), viteSingleFile()],
  clearScreen: false,
  server: {
    host: '0.0.0.0',
    port: 5173,
    open: true
  }
})


