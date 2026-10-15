import { createRasterizer } from './raster.ts';
import type { RasterRequest } from './raster.ts';

let rasterize: ReturnType<typeof createRasterizer>;
self.onmessage = (event: MessageEvent<RasterRequest>) => {
  const request = event.data;
  if (request.type === 'init') {
    rasterize = createRasterizer(request.config, request.mask);
    return;
  }
  const result = rasterize(request.cells);
  self.postMessage({ ...result, id: request.id }, { transfer: [result.pixels.buffer] });
};
