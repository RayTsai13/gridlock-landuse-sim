import type { RasterLayerSpecification } from 'maplibre-gl';

export const HEATMAP_LAYER_ID = 'foot-traffic-heatmap';

export const heatmapLayer: Omit<RasterLayerSpecification, 'source'> = {
  id: HEATMAP_LAYER_ID,
  type: 'raster',
  paint: {
    'raster-opacity': 0.82,
    'raster-resampling': 'linear',
    'raster-fade-duration': 0,
  },
};
