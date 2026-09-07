import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const excludedAssets = new Set([
  'seattle/SPACE NEEDLE.glb',
  'seattle/seattle-building-heights.json',
  'seattle/seattle-buildings-central-east.geojson',
  'seattle/seattle-buildings.geojson',
])

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), {
    name: 'runtime-public-assets',
    apply: 'build',
    config: () => ({ publicDir: false }),
    buildStart() {
      for (const file of readdirSync('public', { recursive: true, withFileTypes: true })) {
        if (!file.isFile()) continue
        const fullPath = resolve(file.parentPath, file.name)
        const relativePath = fullPath.slice(resolve('public').length + 1).replaceAll('\\', '/')
        if (!excludedAssets.has(relativePath)) {
          this.emitFile({ type: 'asset', fileName: relativePath, source: readFileSync(fullPath) })
        }
      }
    },
  }],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
