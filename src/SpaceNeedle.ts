import { ScenegraphLayer } from '@deck.gl/mesh-layers';

const SPACE_NEEDLE_DATA = [{ position: [-122.3493, 47.6205] as [number, number] }];
export const createSpaceNeedleLayer = () => new ScenegraphLayer({
  id: "space-needle-3d-v5",
  data: SPACE_NEEDLE_DATA,
  scenegraph: "/seattle/space-needle.optimized.glb",
  getPosition: (d: { position: [number, number] }) => d.position,
  getOrientation: [0, 0, 90],
  getScale: [1, 1, 1],
  sizeScale: 1.2,
  opacity: 0.6,
  _lighting: "pbr",
  parameters: {
    depthTest: true,
  },
});

