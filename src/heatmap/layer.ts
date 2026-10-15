import type { LayerProps } from "react-map-gl/maplibre";

export const HEATMAP_LAYER_ID = "foot-traffic-heatmap";

// `beforeId` is supplied by App.tsx, which inserts this layer directly beneath
// the water clip so the shoreline occludes it.
export const heatmapLayer: LayerProps = {
  id: HEATMAP_LAYER_ID,
  type: "circle",
  layout: {
    "circle-sort-key": ["get", "density"],
  },
  paint: {
    // Samples sit on a 125 m lattice (HEATMAP_SUBDIVISIONS = 2 over a ~250 m
    // grid), so the radius has to track ground distance or the field breaks
    // apart into polka dots as you zoom in. An exponential base-2 interpolation
    // does exactly that -- the radius doubles per zoom level, matching how many
    // pixels 125 m covers (2.4 px at z10, 155 px at z16 at Seattle's latitude).
    // The 1.2x multiple over the spacing is what makes neighbouring samples
    // overlap into a continuous field rather than a stipple.
    "circle-radius": ["interpolate", ["exponential", 2], ["zoom"], 10, 5, 16, 320],

    // Lie flat on the ground plane. The default (`viewport`) billboards every
    // disc toward the camera, which at the app's 55-degree pitch makes the heat
    // float above the city instead of being painted onto it.
    "circle-pitch-alignment": "map",

    // Nothing paints below 0.10: the backend already culls at 0.03 and the
    // frontend at 0.02, and letting the remaining tail render at low alpha is
    // what covered the whole viewport -- open water included -- in blue haze.
    "circle-color": [
      "interpolate",
      ["linear"],
      ["get", "density"],
      0,
      "rgba(0, 0, 0, 0)",
      0.1,
      "rgba(49, 54, 149, 0)",
      0.18,
      "rgba(69, 117, 180, 0.30)",
      0.28,
      "rgba(116, 173, 209, 0.45)",
      0.38,
      "rgba(171, 217, 233, 0.55)",
      0.48,
      "rgba(224, 243, 248, 0.62)",
      0.56,
      "rgba(255, 255, 191, 0.70)",
      0.64,
      "rgba(254, 224, 144, 0.74)",
      0.72,
      "rgba(253, 174, 97, 0.78)",
      0.8,
      "rgba(244, 109, 67, 0.80)",
      0.9,
      "rgba(215, 48, 39, 0.83)",
      1.0,
      "rgba(165, 0, 38, 0.86)",
    ],
    "circle-blur": 0.6,
    "circle-opacity": 0.82,
  },
};
