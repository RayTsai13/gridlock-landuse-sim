import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readdirSync, readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { resolve } from 'node:path'

let buildingProduction = false

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
    config: (_, { command }) => command === 'build' ? ({ publicDir: false }) : {},
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split('?')[0];
        if (!path || !/^\/seattle\/buildings\/[a-f0-9]{16}\/\d+\/\d+\/\d+\.pbf$/.test(path)) return next();
        try {
          response.setHeader('Content-Type', 'application/vnd.mapbox-vector-tile');
          response.end(gunzipSync(readFileSync(resolve('public', '.' + path))));
        } catch { response.statusCode = 404; response.end(); }
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split('?')[0];
        if (!path || !/^\/seattle\/buildings\/[a-f0-9]{16}\/\d+\/\d+\/\d+\.pbf$/.test(path)) return next();
        try {
          response.setHeader('Content-Type', 'application/vnd.mapbox-vector-tile');
          response.end(gunzipSync(readFileSync(resolve('dist', '.' + path))));
        } catch { response.statusCode = 404; response.end(); }
      });
    },
    configResolved(config) { buildingProduction = config.command === 'build' },
    buildStart() {
      if (!buildingProduction) return
      for (const file of readdirSync('public', { recursive: true, withFileTypes: true })) {
        if (!file.isFile()) continue
        const fullPath = resolve(file.parentPath, file.name)
        const relativePath = fullPath.slice(resolve('public').length + 1).replaceAll('\\', '/')
        if (!excludedAssets.has(relativePath) && !/^seattle\/seattle-buildings.*\.geojson$/.test(relativePath)) {
          this.emitFile({ type: 'asset', fileName: relativePath, source: readFileSync(fullPath) })
        }
      }
    },
  }],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: false,
      },
    },
  },
})
