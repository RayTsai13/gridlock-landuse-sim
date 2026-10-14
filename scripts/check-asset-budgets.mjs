import { readdir, stat, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const landmark = await stat('dist/seattle/space-needle.optimized.glb');
assert(landmark.size < 8_000_000, 'Landmark exceeds 8 MB budget; run npm run optimize:landmark');
const excluded = ['SPACE NEEDLE.glb', 'seattle-building-heights.json',
  'seattle-buildings-central-east.geojson', 'seattle-buildings.geojson'];
const publicFiles = await readdir('dist/seattle');
for (const name of excluded) assert(!publicFiles.includes(name), `Unused asset shipped: ${name}`);
const assets = await readdir('dist/assets');
const entry = assets.find((name) => /^index-.*\.js$/.test(name));
assert(entry, 'Missing JavaScript entry');
assert((await stat(`dist/assets/${entry}`)).size < 600_000, 'Entry JavaScript exceeds 600 kB budget');
console.log('Asset budgets passed');

const report = JSON.parse(await readFile('dist/seattle/buildings/build-report.json', 'utf8'));
assert(report.maxTileBytes <= 500_000, 'Building tile exceeds 500 kB');
assert(report.startupBytes <= 5_000_000, 'Startup buildings exceed 5 MB');
assert(!publicFiles.some((name) => /^seattle-buildings.*\.geojson$/.test(name)), 'Legacy building regions shipped');
const tiles = await readdir('dist/seattle/buildings', { recursive: true });
for (const tile of tiles.filter((name) => name.endsWith('.pbf'))) {
  assert((await stat('dist/seattle/buildings/' + tile)).size <= 500_000, 'Oversized building tile: ' + tile);
}

const manifest = JSON.parse(await readFile('dist/seattle/buildings/tilejson.json', 'utf8'));
const revision = manifest.tiles[0].split('/')[3];
const tileCoordinate = (lon, lat) => [Math.floor((lon + 180) / 360 * 16384),
  Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 16384)];
const [west, north] = tileCoordinate(-122.37, 47.63);
const [east, south] = tileCoordinate(-122.30, 47.59);
let startupBytes = 0;
for (let column = west; column <= east; column++) {
  for (let row = north; row <= south; row++) {
    startupBytes += (await stat(`dist/seattle/buildings/${revision}/14/${column}/${row}.pbf`)).size;
  }
}
assert(startupBytes <= 5_000_000, 'Actual startup tile transfer exceeds 5 MB');
