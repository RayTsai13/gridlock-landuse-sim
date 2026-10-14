import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [root = '.', backendPort = '8000', frontendPort = '5181', label = 'current'] = process.argv.slice(2);
const output = resolve('test-results', `profile-${label}`);
await mkdir(output, { recursive: true });
const python = process.env.PYTHON ?? resolve('.venv/bin/python');
const backend = spawn(python, ['-m', 'uvicorn', 'backend.server:app', '--host', '127.0.0.1', '--port', backendPort], { cwd: root, stdio: 'ignore' });
const frontend = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', frontendPort, '--strictPort'], { cwd: root, stdio: 'ignore' });
const base = `http://127.0.0.1:${frontendPort}`;
let browser;
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch(base);
      await fetch(`http://127.0.0.1:${backendPort}/healthz`);
      break;
    } catch { await new Promise((done) => setTimeout(done, 100)); }
  }
  browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route('https://basemaps.cartocdn.com/gl/positron-gl-style/style.json', (route) => route.fulfill({ json: {
    version: 8, glyphs: 'https://basemap.test/fonts/{fontstack}/{range}.pbf',
    sources: { carto: { type: 'vector', tiles: ['https://basemap.test/{z}/{x}/{y}.pbf'] } },
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#dce9ef' } },
      { id: 'watername_ocean', type: 'background', paint: { 'background-opacity': 0 } }],
  } }));
  await context.route('https://basemap.test/**', (route) => route.fulfill({ body: Buffer.alloc(0), contentType: 'application/x-protobuf' }));
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 30, downloadThroughput: 2_500_000, uploadThroughput: 1_000_000 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 2 });
  let buildingBytes = 0;
  const pendingSizes = [];
  context.on('response', (response) => {
    if (/seattle-buildings.*geojson|\/buildings\/.*pbf/.test(response.url())) {
      pendingSizes.push(response.body().then((body) => { buildingBytes += body.length; }).catch(() => {}));
    }
  });
  const started = Date.now();
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('.map-shell.is-ready').waitFor({ timeout: 120_000 });
  const readyMs = Date.now() - started;
  const samples = [];
  async function sample(stage) {
    await page.waitForTimeout(2500);
    await Promise.allSettled(pendingSizes);
    await cdp.send('HeapProfiler.collectGarbage');
    const metrics = await cdp.send('Performance.getMetrics');
    samples.push({ stage, buildingBytes, metrics: Object.fromEntries(metrics.metrics.filter(({ name }) => ['JSHeapUsedSize', 'TaskDuration', 'LayoutDuration', 'RecalcStyleDuration'].includes(name)).map(({ name, value }) => [name, value])) });
    await page.screenshot({ path: `${output}/${stage}.png` });
  }
  await sample('startup');
  await page.mouse.move(640, 400);
  await page.mouse.down(); await page.mouse.move(1000, 180, { steps: 30 }); await page.mouse.up();
  await sample('pan-west');
  await page.mouse.wheel(0, 1600);
  await sample('citywide');
  await page.mouse.wheel(0, -1600);
  await page.mouse.move(1000, 180);
  await page.mouse.down(); await page.mouse.move(640, 400, { steps: 30 }); await page.mouse.up();
  await sample('return');
  const report = { label, browser: browser.version(), viewport: '1280x800', cpuThrottle: 2, downloadBytesPerSecond: 2_500_000,
    buildingBytesMeaning: 'decoded response bytes in development; not compressed wire bytes', basemap: 'deterministic empty fixture', build: 'development', readyMs, samples };
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await context.tracing.stop({ path: `${output}/trace.zip` });
  console.log(JSON.stringify(report));
} finally {
  if (browser) await browser.close();
  backend.kill('SIGTERM');
  frontend.kill('SIGTERM');
}
