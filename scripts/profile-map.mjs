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
  if (!process.env.PROFILE_REAL_BASEMAP) {
  await context.route('https://basemaps.cartocdn.com/gl/positron-gl-style/style.json', (route) => route.fulfill({ json: {
    version: 8, glyphs: 'https://basemap.test/fonts/{fontstack}/{range}.pbf',
    sources: { carto: { type: 'vector', tiles: ['https://basemap.test/{z}/{x}/{y}.pbf'] } },
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#dce9ef' } },
      { id: 'watername_ocean', type: 'background', paint: { 'background-opacity': 0 } }],
  } }));
  await context.route('https://basemap.test/**', (route) => route.fulfill({ body: Buffer.alloc(0), contentType: 'application/x-protobuf' }));
  }
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
  await page.getByRole('button', { name: 'Show heatmap', exact: true }).click();
  await page.evaluate(async () => {
    await fetch('/api/playback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_playing: false }) });
    await fetch('/api/playback/seek', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ day_of_week: 0, time_bin: 720 }) });
  });
  await page.waitForTimeout(2500);
  const processing = await page.evaluate(async (renderer) => {
    const worker = renderer === 'raster' ? new (await import('/src/heatmap/raster.worker.ts?worker')).default() : null;
    const frameToGeoJSON = worker ? null : (await import('/src/heatmap/grid.ts')).frameToGeoJSON;
    const mask = await (await fetch('/seattle/seattle-built-mass.json')).json();
    mask.weights = Float32Array.from(mask.weights);
    const response = await fetch('/api/scenario', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario_id: 'line-1' }) });
    const { frame } = await response.json();
    const durations = [];
    const roundTrips = [];
    const longTasks = [];
    const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => entry.duration)));
    observer.observe({ type: 'longtask' });
    if (worker) worker.postMessage({ type: 'init', config: mask, mask });
    let points = 0;
    let dimensions = null;
    for (let iteration = 0; iteration < 60; iteration++) {
      const started = performance.now();
      if (worker) {
        const result = await new Promise(resolve => {
          worker.onmessage = event => resolve(event.data);
          worker.postMessage({ type: 'render', id: iteration, cells: frame.cells });
        });
        dimensions = [result.width, result.height];
        if (iteration >= 10) {
          durations.push(result.generationMs);
          roundTrips.push(performance.now() - started);
        }
      } else {
        points = frameToGeoJSON(frame.cells, mask, mask).features.length;
        if (iteration >= 10) durations.push(performance.now() - started);
      }
    }
    durations.sort((left, right) => left - right);
    roundTrips.sort((left, right) => left - right);
    worker?.terminate();
    observer.disconnect();
    return { renderer, medianMs: durations[25], p95Ms: durations[47], roundTripP95Ms: roundTrips[47], points, dimensions, mainThreadLongTasks: longTasks };
  }, process.env.PROFILE_RENDERER ?? 'raster');
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    window.hoverSamples = [];
    let started = null;
    document.addEventListener('mousemove', () => { started = performance.now(); }, true);
    new MutationObserver(records => {
      if (started !== null && records.some(record => record.target instanceof Element && record.target.closest('.demand-tooltip'))) {
        window.hoverSamples.push(performance.now() - started);
        started = null;
      }
    }).observe(document.body, { subtree: true, attributes: true, childList: true });
  });
  for (let iteration = 0; iteration < 100; iteration++) {
    await page.mouse.move(600 + (iteration % 30) * 2, 400);
    await page.locator('.demand-tooltip').waitFor();
    await page.waitForTimeout(30);
  }
  const hoverTimes = await page.evaluate(() => window.hoverSamples);
  hoverTimes.sort((left, right) => left - right);
  await sample('startup');
  await page.mouse.move(640, 400);
  await page.evaluate(() => {
    window.panIntervals = [];
    window.panProfiling = true;
    let previous;
    function tick(now) {
      if (previous !== undefined) window.panIntervals.push(now - previous);
      previous = now;
      if (window.panProfiling) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
  await page.mouse.down(); await page.mouse.move(1000, 180, { steps: 30 }); await page.mouse.up();
  const panIntervals = await page.evaluate(() => { window.panProfiling = false; return window.panIntervals; });
  panIntervals.sort((left, right) => left - right);
  await sample('pan-west');
  await page.mouse.wheel(0, 1600);
  await sample('citywide');
  await page.mouse.wheel(0, -1600);
  await page.mouse.move(1000, 180);
  await page.mouse.down(); await page.mouse.move(640, 400, { steps: 30 }); await page.mouse.up();
  await sample('return');
  const topDown = page.getByTitle('Switch to Top-Down View');
  if (await topDown.count()) await topDown.click();
  await sample('top-down');
  if (process.env.PROFILE_VISUAL_SWEEP) {
    for (let count = 0; count < 4; count++) await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
    await sample('regional');
    for (let count = 0; count < 2; count++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await page.waitForTimeout(1000);
    await page.mouse.move(640, 300);
    await page.mouse.down(); await page.mouse.move(250, 700, { steps: 30 }); await page.mouse.up();
    await sample('residential');
    const crowd = await page.locator('.crowd-draggable-btn').boundingBox();
    const placement = page.waitForResponse(response => response.url().endsWith('/api/people/batch') && response.status() === 201);
    await page.mouse.move(crowd.x + crowd.width / 2, crowd.y + crowd.height / 2);
    await page.mouse.down(); await page.mouse.move(640, 400, { steps: 15 }); await page.mouse.up();
    await placement;
    await sample('crowd-drop');
  }
  const report = { label, browser: browser.version(), viewport: '1280x800', cpuThrottle: 2, downloadBytesPerSecond: 2_500_000,
    processing, panFrameP95Ms: panIntervals[Math.floor(panIntervals.length * 0.95)], hoverP95Ms: hoverTimes[Math.floor(hoverTimes.length * 0.95)], buildingBytesMeaning: 'decoded response bytes in development; not compressed wire bytes', basemap: process.env.PROFILE_REAL_BASEMAP ? 'Carto Positron' : 'deterministic empty fixture', build: 'development', readyMs, samples };
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await context.tracing.stop({ path: `${output}/trace.zip` });
  console.log(JSON.stringify(report));
} finally {
  if (browser) await browser.close();
  backend.kill('SIGTERM');
  frontend.kill('SIGTERM');
}
