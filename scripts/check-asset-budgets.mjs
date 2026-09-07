import { readdir, stat } from 'node:fs/promises';
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
