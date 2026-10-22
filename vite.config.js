import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// LiteRT 的 wasm 从依赖里拷到 public，开发服务器和打包都能直接访问。
function copyLitertWasm() {
  const src = path.join(__dirname, 'node_modules', '@litertjs', 'core', 'wasm')
  const dest = path.join(__dirname, 'public', 'litert')
  if (!fs.existsSync(src)) return
  fs.mkdirSync(dest, { recursive: true })
  for (const name of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, name), path.join(dest, name))
  }
}
copyLitertWasm()

function copyTfliteWasm() {
  const src = path.join(__dirname, 'node_modules', '@tensorflow', 'tfjs-tflite', 'wasm')
  const dest = path.join(__dirname, 'public', 'tflite')
  if (!fs.existsSync(src)) return
  fs.mkdirSync(dest, { recursive: true })
  for (const name of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, name), path.join(dest, name))
  }
}
copyTfliteWasm()
const LINSHI_DIR = path.join(__dirname, 'linshi')
const LINSHI_NDJSON = path.join(LINSHI_DIR, 'button-actions.ndjson')
const LINSHI_TXT = path.join(LINSHI_DIR, 'button-actions.log')

function ensureLinshiDir() {
  if (!fs.existsSync(LINSHI_DIR)) {
    fs.mkdirSync(LINSHI_DIR, { recursive: true })
  }
}

function linshiLogPlugin() {
  return {
    name: 'linshi-button-log',
    configureServer(server) {
      ensureLinshiDir()
      server.middlewares.use('/__linshi_log', (req, res, next) => {
        if (req.method !== 'POST') return next()

        const chunks = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => {
          try {
            ensureLinshiDir()
            const raw = Buffer.concat(chunks).toString('utf8')
            let entry
            try {
              entry = JSON.parse(raw)
            } catch {
              entry = { message: raw, timestamp: Date.now() }
            }
            const line = JSON.stringify(entry)
            fs.appendFileSync(LINSHI_NDJSON, line + '\n', 'utf8')

            const ts = entry.timestampUi || new Date(entry.timestamp || Date.now()).toISOString()
            const human = `[${ts}] ${entry.message || ''} ${JSON.stringify(entry.data || entry)}\n`
            fs.appendFileSync(LINSHI_TXT, human, 'utf8')

            res.statusCode = 204
            res.end()
          } catch (err) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: String(err?.message || err) }))
          }
        })
      })
    }
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react(), viteSingleFile(), linshiLogPlugin()],
  clearScreen: false,
  server: {
    host: '0.0.0.0',
    port: 5173,
    open: true
  }
})
