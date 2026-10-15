import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { expect, test } from 'vitest';

// Check the shipped tiles, not just the export bounds: the former gap between
// northwest and east Seattle omitted central Wallingford's actual footprints.
test.each([14, 15])('Wallingford buildings are present at zoom %i', (zoom) => {
  const manifest = JSON.parse(readFileSync('public/seattle/buildings/tilejson.json', 'utf8'));
  const scale = 2 ** zoom;
  const x = Math.floor((-122.332 + 180) / 360 * scale);
  const y = Math.floor((1 - Math.asinh(Math.tan(47.66 * Math.PI / 180)) / Math.PI) / 2 * scale);
  const path = manifest.tiles[0].replace('{z}', zoom).replace('{x}', x).replace('{y}', y);
  const layer = new VectorTile(new Pbf(gunzipSync(readFileSync(`public${path}`)))).layers.buildings;
  let buildingsInGap = 0;
  for (let i = 0; i < (layer?.length ?? 0); i++) {
    const feature = layer.feature(i).toGeoJSON(x, y, zoom);
    if (feature.geometry.type !== 'Polygon') continue;
    const [lon, lat] = feature.geometry.coordinates[0][0];
    if (lon > -122.336 && lon < -122.328 && lat > 47.655 && lat < 47.665
      && Number(feature.properties?.height_m) > 0) buildingsInGap++;
  }
  expect(buildingsInGap).toBeGreaterThan(100);
});
