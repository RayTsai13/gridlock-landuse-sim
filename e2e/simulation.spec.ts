import { test, expect, type BrowserContext } from '@playwright/test';

async function stubBasemap(context: BrowserContext) {
  await context.route('https://basemaps.cartocdn.com/gl/positron-gl-style/style.json', (route) =>
    route.fulfill({ json: { version: 8,
      glyphs: 'https://basemap.test/fonts/{fontstack}/{range}.pbf',
      sources: { carto: { type: 'vector', tiles: ['https://basemap.test/{z}/{x}/{y}.pbf'] } },
      layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#dce9ef' } },
        { id: 'watername_ocean', type: 'background', paint: { 'background-opacity': 0 } }],
    } }));
  await context.route('https://basemap.test/**', (route) => route.fulfill({ body: Buffer.alloc(0), contentType: 'application/x-protobuf' }));
}

test.beforeEach(async ({ context }) => stubBasemap(context));

test('private sessions, shared tabs, refresh and modeled metrics', async ({ browser, baseURL }) => {
  const first = await browser.newContext({ baseURL });
  const second = await browser.newContext({ baseURL });
  await stubBasemap(first);
  await stubBasemap(second);
  const page = await first.newPage();
  await page.goto('/?debugHeatmap');
  await expect(page.locator('.map-shell')).toBeVisible();
  await first.request.post('/api/playback', { data: { is_playing: false } });
  await first.request.post('/api/scenario', { data: { scenario_id: 'line-1-2-ballard' } });
  await expect(page.locator('.heatmap-debug-panel')).toContainText('line-1-2-ballard');
  const tab = await first.newPage();
  await tab.goto('/?debugHeatmap');
  await expect(tab.locator('.heatmap-debug-panel')).toContainText('line-1-2-ballard');
  await page.reload();
  await expect(page.locator('.heatmap-debug-panel')).toContainText('line-1-2-ballard');
  const other = await second.newPage();
  await other.goto('/?debugHeatmap');
  await expect(other.locator('.heatmap-debug-panel')).toContainText('line-1');
  await expect(other.locator('.heatmap-debug-panel')).not.toContainText('line-1-2-ballard');
  await expect(page.locator('.heatmap-debug-panel')).toContainText('line-1-2-ballard');
  const response = await first.request.post('/api/scenario', { data: { scenario_id: 'line-1-2' } });
  const payload = await response.json();
  expect(payload.frame.totals.generated).toBeCloseTo(payload.frame.totals.served + payload.frame.totals.unmet, 5);
  await expect(tab.locator('.heatmap-debug-panel')).toContainText('line-1-2');
  await page.screenshot({ path: 'test-results/simulation.png' });
  await first.close();
  await second.close();
});

test('building tiles and service assets load without legacy region downloads', async ({ page }) => {
  const requests: string[] = [];
  const tileErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', (request) => requests.push(request.url()));
  page.on('response', (response) => {
    if (response.url().endsWith('.pbf') && response.status() >= 400) tileErrors.push(response.url());
  });
  await page.goto('/?debugHeatmap');
  await expect(page.locator('.map-shell.is-ready')).toBeVisible({ timeout: 45_000 });
  await expect.poll(() => requests.some((url) => /buildings\/.+\.pbf$/.test(url))).toBe(true);
  expect(requests.some((url) => /seattle-buildings.*\.geojson/.test(url))).toBe(false);
  expect(tileErrors).toEqual([]);
  await page.getByRole('button', { name: 'Show heatmap', exact: true }).click();
  await expect(page.locator('.heatmap-debug-panel')).toContainText('raster: 560 × 896');
  await page.mouse.move(640, 400);
  await expect(page.locator('.demand-tooltip')).toContainText('Modeled unmet trips/hour');
  await expect(page.locator('.demand-tooltip')).toContainText('~250 m cell');
  await page.screenshot({ path: 'test-results/demand.png' });
  await page.getByRole('button', { name: 'Hide heatmap', exact: true }).click();
  await expect(page.locator('.demand-tooltip')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show heatmap', exact: true }).click();
  await expect.poll(() => requests.filter(url => url.includes('raster.worker')).length).toBeGreaterThan(0);
  await expect(page.locator('[role=alert]')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('playback and crowd controls send confirmed mutations', async ({ page }) => {
  await page.goto('/?debugHeatmap');
  await expect(page.locator('.map-shell.is-ready')).toBeVisible({ timeout: 45_000 });
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  const seek = page.waitForResponse((response) => response.url().endsWith('/api/playback/seek') && response.ok());
  await page.getByRole('button', { name: 'Select day 3', exact: true }).click();
  const playback = await (await seek).json();
  expect(playback.sim_time.day_of_week).toBe(2);
  const crowd = await page.locator('.crowd-draggable-btn').boundingBox();
  expect(crowd).not.toBeNull();
  const placement = page.waitForResponse((response) => response.url().endsWith('/api/people/batch'));
  await page.mouse.move(crowd!.x + crowd!.width / 2, crowd!.y + crowd!.height / 2);
  await page.mouse.down();
  await page.mouse.move(640, 400, { steps: 12 });
  await page.mouse.up();
  const response = await placement;
  expect(response.status()).toBe(201);
  const payload = await response.json();
  expect(payload.people.reduce((total: number, person: { count: number }) => total + person.count, 0)).toBe(5000);
});
