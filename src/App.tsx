import { lazy, Suspense, useCallback, useEffect, useMemo, useState, useRef } from "react";
import {
  Layer,
  Map,
  NavigationControl,
  Source,
  Marker,
} from "react-map-gl/maplibre";
import type { FeatureCollection, Point } from "geojson";
import type { LngLatBoundsLike, Map as MapLibreMap } from "maplibre-gl";
import type { LayerProps } from "react-map-gl/maplibre";
import type {
  MapLayerMouseEvent,
  MapRef,
  ViewStateChangeEvent,
} from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import "./App.css";
import { useHeatmap } from "./heatmap/stream.ts";
import { useCrowdDrop } from "./heatmap/useCrowdDrop.ts";
import { useTimeControls } from './heatmap/useTimeControls.ts';
import { useDemandInspection } from './heatmap/useDemandInspection.ts';
import { ModelInfoPanel } from './heatmap/ModelInfoPanel.tsx';
import { HEATMAP_LAYER_ID, heatmapLayer } from "./heatmap/layer.ts";
import { useBuiltMass } from "./heatmap/mask.ts";
import { DEPLOY_STEPS, stopsToGeoJSON, linesToGeoJSON } from "./stops/data.ts";
import type { TransitStop, TransitLine } from "./stops/data.ts";
import {
  lineCasingLayer,
  lineRouteLayer,
  stopCircleLayer,
  stopDotLayer,
  stopLabelLayer,
  deployPulseRingLayer,
  deployGlowDotLayer,
} from "./stops/layers.ts";
import { Mascot } from "./Mascot.tsx";

const MapOverlays = lazy(() => import("./MapOverlays.tsx"));

const initialViewState = {
  longitude: -122.3337,
  latitude: 47.6074,
  zoom: 15.3,
  pitch: 55,
  bearing: -18,
};

type Bounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

type BuildingRegion = {
  id: string;
  label: string;
  url: string;
  bounds: Bounds;
};


const BUILDING_REGIONS: BuildingRegion[] = [
  {
    id: "downtown-core",
    label: "Downtown Core",
    url: "/seattle/seattle-buildings-downtown-core.geojson",
    bounds: {
      west: -122.37,
      south: 47.585,
      east: -122.308,
      north: 47.6325,
    },
  },
  {
    id: "east-neighborhoods",
    label: "East Neighborhoods",
    url: "/seattle/seattle-buildings-east-neighborhoods.geojson",
    bounds: {
      west: -122.326,
      south: 47.585,
      east: -122.255,
      north: 47.676,
    },
  },
  {
    id: "northwest-seattle",
    label: "Northwest Seattle",
    url: "/seattle/seattle-buildings-northwest-seattle.geojson",
    bounds: {
      west: -122.43,
      south: 47.6205,
      east: -122.338,
      north: 47.69,
    },
  },
  {
    id: "west-seattle",
    label: "West Seattle",
    url: "/seattle/seattle-buildings-west-seattle.geojson",
    bounds: {
      west: -122.432,
      south: 47.543,
      east: -122.33,
      north: 47.604,
    },
  },
  {
    id: "beacon-hill",
    label: "Beacon Hill",
    url: "/seattle/seattle-buildings-beacon-hill.geojson",
    bounds: {
      west: -122.32,
      south: 47.55,
      east: -122.284,
      north: 47.6015,
    },
  },
];

const CAMERA_BOUNDARY_PADDING_DEGREES = 0.01;

// ~150 m expressed as degrees of latitude; longitude is scaled by cos(lat)
// at the drop point so the scatter stays circular on the ground.


function mergeBoundsList(boundsList: Bounds[]) {
  const firstBounds = boundsList[0];
  if (!firstBounds) {
    throw new Error("Camera boundary requires at least one building region.");
  }

  return boundsList.slice(1).reduce<Bounds>(
    (merged, bounds) => ({
      west: Math.min(merged.west, bounds.west),
      south: Math.min(merged.south, bounds.south),
      east: Math.max(merged.east, bounds.east),
      north: Math.max(merged.north, bounds.north),
    }),
    firstBounds,
  );
}

function padBoundsByDegrees(bounds: Bounds, padding: number) {
  return {
    west: bounds.west - padding,
    south: bounds.south - padding,
    east: bounds.east + padding,
    north: bounds.north + padding,
  };
}

const cameraBoundary = padBoundsByDegrees(
  mergeBoundsList(BUILDING_REGIONS.map((region) => region.bounds)),
  CAMERA_BOUNDARY_PADDING_DEGREES,
);

const cameraMaxBounds = [
  cameraBoundary.west,
  cameraBoundary.south,
  cameraBoundary.east,
  cameraBoundary.north,
] satisfies LngLatBoundsLike;

const buildingFillLayer: LayerProps = {
  id: "official-seattle-buildings-fill",
  type: "fill-extrusion",
  paint: {
    "fill-extrusion-color": [
      "interpolate",
      ["linear"],
      ["get", "height_m"],
      3,
      "#cfe6ff",
      15,
      "#b7d8fb",
      40,
      "#97c5f6",
      120,
      "#79afe6",
    ],
    "fill-extrusion-height": ["coalesce", ["get", "height_m"], 0],
    "fill-extrusion-base": 0,
    "fill-extrusion-opacity": 0.85,
    "fill-extrusion-vertical-gradient": true,
  },
};

const BASEMAP_WATER_COLOR = "#a9d8f3";
// Carto Positron serves its vector tiles from a source named "carto"; water
// lives on the "water" source-layer.
const HEATMAP_WATER_CLIP_LAYER_ID = "heatmap-water-clip";

// Upper bound on how long the loading screen waits for MapLibre's first idle
// render pass. A map that keeps repainting (or never reports idle) still gets
// revealed instead of stranding the user behind the loading screen.
const FIRST_PAINT_TIMEOUT_MS = 4000;
const BASEMAP_WATER_SHADOW_COLOR = "#8fc5e4";
const BASEMAP_WATERWAY_COLOR = "#87c7ea";
const BASEMAP_GREENERY_COLOR = "#cfe7bf";

type BasemapLayer = {
  id: string;
  type: string;
  "source-layer"?: string;
};

function applyBasemapPalette(map: MapLibreMap) {
  const style = map.getStyle();
  const layers = (style?.layers ?? []) as BasemapLayer[];

  for (const layer of layers) {
    if (layer.type === "fill") {
      if (layer.id === "water") {
        map.setPaintProperty(layer.id, "fill-color", BASEMAP_WATER_COLOR);
        continue;
      }

      if (layer.id === "water_shadow") {
        map.setPaintProperty(
          layer.id,
          "fill-color",
          BASEMAP_WATER_SHADOW_COLOR,
        );
        continue;
      }

      if (layer.id === "landcover" || layer["source-layer"] === "park") {
        map.setPaintProperty(layer.id, "fill-color", BASEMAP_GREENERY_COLOR);
      }

      continue;
    }

    if (layer.type === "line" && layer["source-layer"] === "waterway") {
      map.setPaintProperty(layer.id, "line-color", BASEMAP_WATERWAY_COLOR);
    }
  }
}

function expandBounds(bounds: Bounds) {
  const lonPad = (bounds.east - bounds.west) * 0.2;
  const latPad = (bounds.north - bounds.south) * 0.2;

  return {
    west: bounds.west - lonPad,
    south: bounds.south - latPad,
    east: bounds.east + lonPad,
    north: bounds.north + latPad,
  };
}

function boundsFromMap(map: MapRef) {
  const bounds = map.getBounds();
  return expandBounds({
    west: bounds.getWest(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    north: bounds.getNorth(),
  });
}

function containsBounds(outer: Bounds, inner: Bounds) {
  return (
    inner.west >= outer.west &&
    inner.south >= outer.south &&
    inner.east <= outer.east &&
    inner.north <= outer.north
  );
}

const initialBounds = {
  west: -122.3525,
  south: 47.6015,
  east: -122.3245,
  north: 47.6195,
};

function formatDemandNumber(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function App() {
  const [isHeatmapVisible, setIsHeatmapVisible] = useState(false);
  const builtMass = useBuiltMass();
  const {
    geojson: heatmapData,
    frame,
    config,
    scenarioId,
    network,
    setScenario,
    playback,
    setPlaying,
    seekTo,
    addPeopleBatch,
    diagnostics: heatmapDiagnostics,
    retryConnection,
  } = useHeatmap({ renderGeometry: isHeatmapVisible, builtMass });
  const showHeatmapDebug = useMemo(
    () => new URLSearchParams(window.location.search).has("debugHeatmap"),
    [],
  );

  // Deploy state: index of the highest deployed step (0 = Line 1 only)
  const deployedIndex = Math.max(0, DEPLOY_STEPS.findIndex((step) => step.id === scenarioId));
  const [actionError, setActionError] = useState<string | null>(null);
  const { demandTooltip, setDemandTooltip, inspectDemand } = useDemandInspection(frame, config);

  const [queryBounds, setQueryBounds] = useState(initialBounds);
  const [initialBuildingRegionLoaded, setInitialBuildingRegionLoaded] = useState(false);
  // URLs let MapLibre fetch/parse on its worker; offscreen sources are released.

  const showSpaceNeedle = containsBounds(queryBounds, {
    west: -122.3493, east: -122.3493, south: 47.6205, north: 47.6205,
  });

  const mapRef = useRef<MapRef | null>(null);
  const { crowdSize, setCrowdSize, isDraggingCrowd, setIsDraggingCrowd, crowdDragPos, setCrowdDragPos } = useCrowdDrop(mapRef, addPeopleBatch, setActionError);
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [offscreenArrow, setOffscreenArrow] = useState<{
    x: number;
    y: number;
    angle: number;
  } | null>(null);

  // View mode controls
  const [viewMode, setViewMode] = useState<"top-down" | "angled">("angled");
  const [isPitchLocked, setIsPitchLocked] = useState(false);
  const isAnimatingView = useRef(false);
  const viewAnimationTimersRef = useRef<number[]>([]);
  const clearViewAnimationTimers = useCallback(() => {
    for (const handle of viewAnimationTimersRef.current) {
      window.clearTimeout(handle);
    }
    viewAnimationTimersRef.current = [];
  }, []);

  // One place to drop every pending timer when the component goes away.
  useEffect(
    () => () => {
      for (const handle of viewAnimationTimersRef.current) {
        window.clearTimeout(handle);
      }
      viewAnimationTimersRef.current = [];
    },
    [],
  );

  const backendIsPlaying = playback?.is_playing ?? false;
  const { timeOfDay, dayOfWeek, setDayOfWeek, hoveredDay, setHoveredDay, hoverTimeoutRef, dialRef, selectedTimeRef, selectedDayRef, setIsDraggingDial, updateTimeFromPointer } = useTimeControls(playback, seekTo);

  // ── Compute active stops/lines from deployed steps ──
  const { activeStops, activeLines } = useMemo(() => {
    const stops: TransitStop[] = [];
    const lines: TransitLine[] = [];
    const seenStopIds = new Set<string>();

    for (let i = 0; i <= deployedIndex; i++) {
      const step = DEPLOY_STEPS[i];
      lines.push(step.line);
      for (const stop of step.newStops) {
        if (!seenStopIds.has(stop.id)) {
          seenStopIds.add(stop.id);
          stops.push(stop);
        }
      }
    }
    if (network) {
      return {
        activeStops: network.stops,
        activeLines: network.lines.map((line) => {
          const style = DEPLOY_STEPS.find((step) => step.line.id === line.id)?.line;
          return { ...line, color: style?.color ?? '#777777', offset: style?.offset ?? 0 };
        }),
      };
    }
    return { activeStops: stops, activeLines: lines };
  }, [deployedIndex, network]);



  const stopsGeoJSON = useMemo(
    () => stopsToGeoJSON(activeStops, activeLines),
    [activeStops, activeLines],
  );
  const linesGeoJSON = useMemo(
    () => linesToGeoJSON(activeLines, activeStops),
    [activeLines, activeStops],
  );
  function updateBuildingsForViewport(map: MapRef) {
    const nextBounds = boundsFromMap(map);
    setQueryBounds((currentBounds) =>
      currentBounds.west === nextBounds.west && currentBounds.east === nextBounds.east &&
      currentBounds.south === nextBounds.south && currentBounds.north === nextBounds.north
        ? currentBounds : nextBounds,
    );
  }

  const nextStep =
    deployedIndex < DEPLOY_STEPS.length - 1
      ? DEPLOY_STEPS[deployedIndex + 1]
      : null;

  // Resolve trigger coordinates: use custom coords if provided, else fall back to station
  const triggerCoords = useMemo<[number, number] | null>(() => {
    if (!nextStep) return null;
    if (nextStep.triggerCoordinates) return nextStep.triggerCoordinates;
    if (nextStep.triggerStopId) {
      const stop = activeStops.find((s) => s.id === nextStep.triggerStopId);
      return stop?.coordinates ?? null;
    }
    return null;
  }, [nextStep, activeStops]);

  // Trigger GeoJSON for the pulsing indicator
  const triggerGeoJSON = useMemo<FeatureCollection<Point>>(() => {
    if (!triggerCoords) return { type: "FeatureCollection", features: [] };
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: triggerCoords },
          properties: {
            id: nextStep?.triggerStopId ?? "deploy",
            name: nextStep?.label ?? "",
          },
        },
      ],
    };
  }, [triggerCoords, nextStep]);

  // ── Off-screen arrow: track whether the deploy node is visible ──
  const updateOffscreenArrow = useCallback(() => {
    if (!mapRef.current || !triggerCoords) {
      setOffscreenArrow(null);
      return;
    }
    const map = mapRef.current;
    const projected = map.project(triggerCoords as [number, number]);
    const container = map.getContainer();
    const w = container.clientWidth;
    const h = container.clientHeight;
    const MARGIN = 60;

    const isWithinBounds = map
      .getBounds()
      .contains(triggerCoords as [number, number]);

    // If on screen mathematically and geographically, no arrow needed
    if (
      isWithinBounds &&
      projected.x >= MARGIN &&
      projected.x <= w - MARGIN &&
      projected.y >= MARGIN &&
      projected.y <= h - MARGIN
    ) {
      setOffscreenArrow(null);
      return;
    }

    const cx = w / 2;
    const cy = h / 2;

    // Calculate geographic bearing to prevent projection inversion behind camera
    const center = map.getCenter();
    const dLon = triggerCoords[0] - center.lng;
    const dLat = triggerCoords[1] - center.lat;
    const dxGeo = dLon * Math.cos((center.lat * Math.PI) / 180);
    const dyGeo = dLat;

    // Geographical angle where North is 0, East is 90
    const geoBearing = (Math.atan2(dxGeo, dyGeo) * 180) / Math.PI;

    // Screen angle: map bearing offsets geographical bearing.
    // Screen X/Y: 0 degrees is right, 90 is down.
    const screenAngleDeg = geoBearing - map.getBearing() - 90;
    const angle = (screenAngleDeg * Math.PI) / 180;

    const PAD = 48;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    // Intersect ray from center with padded screen edges
    const tRight = cos > 0 ? (w / 2 - PAD) / cos : Infinity;
    const tLeft = cos < 0 ? -(w / 2 - PAD) / cos : Infinity;
    const tBottom = sin > 0 ? (h / 2 - PAD) / sin : Infinity;
    const tTop = sin < 0 ? -(h / 2 - PAD) / sin : Infinity;

    const t = Math.min(tRight, tLeft, tBottom, tTop);

    const edgeX = cx + t * cos;
    const edgeY = cy + t * sin;

    setOffscreenArrow((current) =>
      current &&
      Math.abs(current.x - edgeX) < 0.5 &&
      Math.abs(current.y - edgeY) < 0.5 &&
      Math.abs(current.angle - screenAngleDeg) < 0.5
        ? current
        : { x: edgeX, y: edgeY, angle: screenAngleDeg },
    );
  }, [triggerCoords]);

  useEffect(() => {
    updateOffscreenArrow();
  }, [updateOffscreenArrow]);

  const handleMapMove = useCallback(
    (e: ViewStateChangeEvent) => {
      updateOffscreenArrow();
      const p = e.viewState.pitch;

      if (viewMode === "angled" && p < 5 && !isAnimatingView.current) {
        setViewMode("top-down");
        mapRef.current?.easeTo({ pitch: 0, duration: 800 });
      } else if (viewMode === "top-down" && p < 0.5 && !isPitchLocked) {
        setIsPitchLocked(true);
      }
    },
    [updateOffscreenArrow, viewMode, isPitchLocked],
  );

  const handleToggleView = () => {
    if (viewMode === "angled") {
      setViewMode("top-down");
      mapRef.current?.easeTo({ pitch: 0, duration: 1000 });
    } else {
      setIsPitchLocked(false);
      setViewMode("angled");
      isAnimatingView.current = true;
      // Tracked so a rapid double-toggle cannot leave an earlier timer to
      // clear `isAnimatingView` while the newer ease is still running, and so
      // neither timer survives unmount.
      clearViewAnimationTimers();
      viewAnimationTimersRef.current.push(
        window.setTimeout(() => {
          mapRef.current?.easeTo({ pitch: 55, duration: 1000 });
          viewAnimationTimersRef.current.push(
            window.setTimeout(() => {
              isAnimatingView.current = false;
            }, 1100),
          );
        }, 50),
      );
    }
  };

  const deployNextStep = useCallback(() => {
    if (!nextStep || heatmapDiagnostics.pendingScenarioId) return;
    const selected = DEPLOY_STEPS.slice(0, deployedIndex + 2);
    const stops = [...new globalThis.Map(selected.flatMap((step) => step.newStops).map((stop) => [stop.id, stop])).values()];
    setActionError(null);
    void setScenario(nextStep.id, stops, selected.map((step) => step.line))
      .catch((error: Error) => setActionError(error.message));
  }, [nextStep, heatmapDiagnostics.pendingScenarioId, deployedIndex, setScenario]);

  // ── Map click handler — deploy on trigger click ──
  const handleMapClick = useCallback(
    (e: MapLayerMouseEvent) => {
      if (!nextStep) return;
      const clickedDeployTarget = e.features?.some((feature) =>
        feature.layer.id === "deploy-pulse-ring" ||
        feature.layer.id === "deploy-glow-dot",
      );
      if (clickedDeployTarget) {
        deployNextStep();
      }
    },
    [deployNextStep, nextStep],
  );

  const handleMapMouseMove = useCallback(
    (e: MapLayerMouseEvent) => {
      if (!isHeatmapVisible) {
        setDemandTooltip(null);
        return;
      }

      inspectDemand(e.lngLat.lng, e.lngLat.lat, e.point.x, e.point.y);
    },
    [isHeatmapVisible, inspectDemand, setDemandTooltip],
  );

  const backendIsPlayingRef = useRef(backendIsPlaying);
  useEffect(() => {
    backendIsPlayingRef.current = backendIsPlaying;
  }, [backendIsPlaying]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      // Space is the native activation key for buttons and range inputs.
      const target = e.target as HTMLElement | null;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName))
      ) {
        return;
      }
      e.preventDefault();
      setPlaying(!backendIsPlayingRef.current).catch((err) => {
        console.warn("[heatmap] failed to update playback", err);
      });
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setPlaying]);

  const formatTime = (minutes: number) => {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    const period = hours >= 12 ? "PM" : "AM";
    const displayHours = hours % 12 || 12;
    return `${displayHours}:${mins.toString().padStart(2, "0")} ${period}`;
  };

  const dialRadius = 60;
  const thumbAngle = (timeOfDay / 1440) * 2 * Math.PI - Math.PI / 2;
  const thumbX = dialRadius * Math.cos(thumbAngle);
  const thumbY = dialRadius * Math.sin(thumbAngle);

  // Dynamic angle calculation for weekday orbit nodes
  const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
  const focusIndex = hoveredDay !== null ? hoveredDay : dayOfWeek;
  const ACTIVE_WIDTH = 4.5;
  const INACTIVE_WIDTH = 1;
  const TOTAL_SPAN = 130;
  const START_ANGLE = 160;

  const nodeWidths = WEEKDAYS.map((_, i) =>
    i === focusIndex ? ACTIVE_WIDTH : INACTIVE_WIDTH,
  );
  const gaps = [];
  for (let i = 0; i < 6; i++) {
    gaps.push((nodeWidths[i] + nodeWidths[i + 1]) / 2);
  }
  const totalGap = gaps.reduce((a, b) => a + b, 0);

  const nodeAngles = [START_ANGLE];
  let currentGapSum = 0;
  for (let i = 0; i < 6; i++) {
    currentGapSum += gaps[i];
    nodeAngles.push(START_ANGLE + (currentGapSum / totalGap) * TOTAL_SPAN);
  }

  // Interactive layer IDs for click detection
  const interactiveLayerIds = useMemo(
    () => [
      ...(isHeatmapVisible ? [HEATMAP_LAYER_ID] : []),
      "transit-stops-circle",
      "transit-stops-dot",
      "deploy-pulse-ring",
      "deploy-glow-dot",
    ],
    [isHeatmapVisible],
  );

  const handleMapLoad = useCallback(
    (event: { target: MapLibreMap }) => {
      applyBasemapPalette(event.target);
      setIsMapLoaded(true);

      if (mapRef.current) {
        updateBuildingsForViewport(mapRef.current);
      }
    },
    [],
  );

  const [isFirstPaintSettled, setIsFirstPaintSettled] = useState(false);

  const initialHeatmapStreamLoaded = Boolean(
    heatmapDiagnostics.config &&
      heatmapDiagnostics.confirmedScenarioId &&
      heatmapDiagnostics.lastFrameAt &&
      playback,
  );
  const contentReady =
    isMapLoaded && initialBuildingRegionLoaded && initialHeatmapStreamLoaded;
  // A source being *loaded* is not the same as its layers being *painted*.
  // Revealing on `contentReady` alone let the buildings, the heatmap and the
  // deck.gl train overlay pop in one frame at a time just as the loading screen
  // faded. Hold the screen until MapLibre reports an idle render pass (style,
  // tiles and every GeoJSON source drawn) plus two frames for the interleaved
  // deck.gl pass, with a timeout so a map that never goes idle cannot wedge it.
  const isAppReady = contentReady && isFirstPaintSettled;

  useEffect(() => {
    if (!contentReady || isFirstPaintSettled) {
      return undefined;
    }
    const map = mapRef.current?.getMap();
    if (!map) {
      return undefined;
    }

    // Polled rather than driven by the `idle` event: the train overlay moves
    // every animation frame, so the interleaved deck.gl pass keeps the map
    // repainting and `idle` may never fire. `loaded()` is the same predicate
    // without the quiescence requirement — style parsed, no dirty sources, all
    // tiles in. Two consecutive true readings means one full frame was painted
    // with everything on it.
    let frameHandle = 0;
    let cleanFrames = 0;
    const startedAt = performance.now();
    const poll = () => {
      if (map.loaded()) {
        cleanFrames += 1;
      } else {
        cleanFrames = 0;
      }
      if (
        cleanFrames >= 2 ||
        performance.now() - startedAt >= FIRST_PAINT_TIMEOUT_MS
      ) {
        setIsFirstPaintSettled(true);
        return;
      }
      frameHandle = requestAnimationFrame(poll);
    };

    frameHandle = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(frameHandle);
  }, [contentReady, isFirstPaintSettled]);
  // The stream retries forever on its own, so without an explicit failure state
  // an unreachable backend leaves a fully-loaded map hidden behind a spinner.
  const streamUnreachable =
    heatmapDiagnostics.connection === "failed" && !initialHeatmapStreamLoaded;
  const loadingStatus = streamUnreachable
    ? "Can't reach the simulation server"
    : !isMapLoaded
      ? "Loading map"
      : !initialBuildingRegionLoaded
        ? "Loading city model"
        : !initialHeatmapStreamLoaded
          ? "Syncing simulator"
          : !isFirstPaintSettled
            ? "Rendering city"
            : "Ready";

  return (
    <div className={`map-shell ${isAppReady ? "is-ready" : "is-loading"}`}>
      <ModelInfoPanel model={frame?.model} error={actionError ?? heatmapDiagnostics.lastError} />
      <Map
        ref={mapRef}
        initialViewState={initialViewState}
        transformRequest={(url) => ({ url: new URL(url, window.location.origin).href })}
        mapStyle="https://basemaps.cartocdn.com/gl/positron-gl-style/style.json"
        style={{ width: "100vw", height: "100vh" }}
        onClick={handleMapClick}
        onMove={handleMapMove}
        onMouseMove={handleMapMouseMove}
        onMouseLeave={() => setDemandTooltip(null)}
        onLoad={handleMapLoad}
        onSourceData={(event) => {
          if (event.sourceId === 'seattle-buildings' && event.isSourceLoaded) {
            setInitialBuildingRegionLoaded(true);
          }
        }}
        onError={(event) => {
          console.warn('[map]', event.error);
          // A failed source must not leave an otherwise usable map behind the loader.
          if ('sourceId' in event && event.sourceId === 'seattle-buildings') {
            setInitialBuildingRegionLoaded(true);
          }
        }}
        onMoveStart={() => setDemandTooltip(null)}
        onMoveEnd={(event) =>
          updateBuildingsForViewport(event.target as unknown as MapRef)
        }
        interactiveLayerIds={interactiveLayerIds}
        cursor={demandTooltip || nextStep ? "pointer" : undefined}
        maxBounds={cameraMaxBounds}
        maxPitch={isPitchLocked ? 0 : 85}
        renderWorldCopies={false}
      >
        <NavigationControl position="top-right" />

        <button
          className="view-mode-button"
          onClick={handleToggleView}
          title={
            viewMode === "angled"
              ? "Switch to Top-Down View"
              : "Switch to Angled View"
          }
        >
          {viewMode === "angled" ? "2D" : "3D"}
        </button>

        <button
          className={`heatmap-toggle-button ${isHeatmapVisible ? "is-active" : ""}`}
          onClick={() => {
            if (isHeatmapVisible) {
              setDemandTooltip(null);
            }
            setIsHeatmapVisible((current) => !current);
          }}
          type="button"
          aria-label={isHeatmapVisible ? "Hide heatmap" : "Show heatmap"}
          aria-pressed={isHeatmapVisible}
          title={isHeatmapVisible ? "Hide heatmap" : "Show heatmap"}
        >
          <span className="heatmap-toggle-icon" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </button>

        <div className="crowd-drop-control">
          <button
            className="crowd-draggable-btn"
            onPointerDown={(e) => {
              setIsDraggingCrowd(true);
              setCrowdDragPos({ x: e.clientX, y: e.clientY });
            }}
            title="Drag to spawn crowd"
          >
            <Mascot isDragging={isDraggingCrowd} className="crowd-icon" />
          </button>
          <div className="crowd-slider-container">
            <input
              type="range"
              min="1000"
              max="30000"
              step="1000"
              value={crowdSize}
              onChange={(e) => setCrowdSize(parseInt(e.target.value))}
              className="crowd-slider"
            />
            <span className="crowd-size-label">{crowdSize / 1000}k</span>
          </div>
        </div>

        <Source id="seattle-buildings" type="vector" url="/seattle/buildings/tilejson.json">
          <Layer beforeId="watername_ocean" {...buildingFillLayer} source-layer="buildings" />
        </Source>

        {isMapLoaded && (
          <Suspense fallback={null}>
            <MapOverlays lines={activeLines} playback={playback} showSpaceNeedle={showSpaceNeedle} />
          </Suspense>
        )}

        {isHeatmapVisible && (
          <>
            {/* The basemap's own water polygons, redrawn above the heatmap so
                the shoreline clips it at full tile resolution. Painted the same
                colour applyBasemapPalette gives the real water layer, so it is
                invisible except where it erases heat that has drifted onto
                Elliott Bay, Lake Union, or the Ship Canal. The heatmap targets
                this layer by id, so the result does not depend on mount order. */}
            <Layer
              id={HEATMAP_WATER_CLIP_LAYER_ID}
              type="fill"
              source="carto"
              source-layer="water"
              beforeId="transit-line-casing"
              paint={{ "fill-color": BASEMAP_WATER_COLOR }}
            />
            <Source id="heatmap-source" type="geojson" data={heatmapData}>
              <Layer {...heatmapLayer} beforeId={HEATMAP_WATER_CLIP_LAYER_ID} />
            </Source>
          </>
        )}

        <Source id="transit-lines" type="geojson" data={linesGeoJSON}>
          <Layer {...lineCasingLayer} />
          <Layer {...lineRouteLayer} />
        </Source>

        <Source id="transit-stops" type="geojson" data={stopsGeoJSON}>
          <Layer {...stopCircleLayer} />
          <Layer {...stopDotLayer} />
          <Layer {...stopLabelLayer} />
        </Source>

        {/* Deploy indicator — pulsing ring on the next trigger station */}
        <Source id="deploy-trigger" type="geojson" data={triggerGeoJSON}>
          <Layer {...deployPulseRingLayer} />
          <Layer {...deployGlowDotLayer} />
        </Source>

        {/* Tooltip marker above the trigger node */}
        {triggerCoords && nextStep?.label && (
          <Marker
            longitude={triggerCoords[0]}
            latitude={triggerCoords[1]}
            anchor="bottom"
            offset={[0, -30]}
          >
            <button
              className="deploy-tooltip"
              onClick={(event) => {
                event.stopPropagation();
                deployNextStep();
              }}
              type="button"
            >
              <span className="deploy-tooltip-icon">⚡</span>
              <span>{nextStep.label}</span>
            </button>
          </Marker>
        )}
      </Map>

      {/* Vignette overlay to soften edges at camera boundary */}
      <div className="map-vignette" />

      {demandTooltip && (
        <div
          className="demand-tooltip"
          style={{
            left: `${demandTooltip.x}px`,
            top: `${demandTooltip.y}px`,
          }}
        >
          <div className="demand-tooltip-header">
            <span>Transit Demand</span>
            <strong>{demandTooltip.pressureLabel}</strong>
          </div>
          <div className="demand-index-row">
            <span>Index</span>
            <strong>{demandTooltip.demandIndex}</strong>
          </div>
          <div className="demand-meter" aria-hidden="true">
            <span style={{ width: `${demandTooltip.demandIndex}%` }} />
          </div>
          <div className="demand-tooltip-grid">
            <span>Modeled unmet trips/hour</span>
            <strong>
              {formatDemandNumber(demandTooltip.unmet)}
            </strong>
            <span>Generated / served</span>
            <strong>{formatDemandNumber(demandTooltip.generated)} / {formatDemandNumber(demandTooltip.served)}</strong>
            <span>Cell totals · pressure index</span>
          </div>
        </div>
      )}

      {/* Off-screen arrow pointing toward the deploy node */}
      {offscreenArrow && nextStep?.label && (
        <button
          className="offscreen-arrow"
          onClick={deployNextStep}
          style={{
            left: `${offscreenArrow.x}px`,
            top: `${offscreenArrow.y}px`,
            transform: `translate(-50%, -50%) rotate(${offscreenArrow.angle}deg)`,
          }}
          type="button"
        >
          <span className="offscreen-arrow-label">{nextStep.label}</span>
          <span className="offscreen-arrow-chevron">›</span>
        </button>
      )}

      {/* Dragging Reticle */}
      {isDraggingCrowd && crowdDragPos && (
        <div
          className="crowd-drop-reticle"
          style={{
            left: `${crowdDragPos.x}px`,
            top: `${crowdDragPos.y}px`,
          }}
        >
          <div
            style={{
              width: 80,
              height: 80,
              marginBottom: 8,
              pointerEvents: "none",
            }}
          >
            <Mascot isDragging={true} />
          </div>
          <div className="reticle-label">Drop {crowdSize / 1000}k</div>
        </div>
      )}

      {showHeatmapDebug && (
        <div className="heatmap-debug-panel">
          <strong>Heatmap Debug</strong>
          <span>connection: {heatmapDiagnostics.connection}</span>
          <span>pending: {heatmapDiagnostics.pendingScenarioId ?? "none"}</span>
          <span>
            confirmed: {heatmapDiagnostics.confirmedScenarioId ?? "none"}
          </span>
          <span>frames: {heatmapDiagnostics.frameCount}</span>
          <span>playing: {backendIsPlaying ? "yes" : "no"}</span>
          <span>
            sim:{" "}
            {heatmapDiagnostics.simTime
              ? `d${heatmapDiagnostics.simTime.day_of_week} ${formatTime(heatmapDiagnostics.simTime.time_bin)}`
              : "none"}
          </span>
          <span>features: {heatmapDiagnostics.featureCount}</span>
          <span>cells: {heatmapDiagnostics.lastFrameCellCount}</span>
          <span>
            grid:{" "}
            {heatmapDiagnostics.config
              ? `${heatmapDiagnostics.config.rows}x${heatmapDiagnostics.config.cols}`
              : "none"}
          </span>
          {heatmapDiagnostics.lastError && (
            <span>{heatmapDiagnostics.lastError}</span>
          )}
        </div>
      )}

      <div className="time-controls-wrapper">
        {WEEKDAYS.map((dayLabel, index) => {
          const angleDeg = nodeAngles[index];
          const angleRad = (angleDeg * Math.PI) / 180;
          const isFocused = focusIndex === index;
          const R = isFocused ? 122 : 110;
          const x = Math.cos(angleRad) * R;
          const y = Math.sin(angleRad) * R;

          return (
            <button
              key={index}
              className={`orbit-node ${dayOfWeek === index ? "is-selected" : ""} ${focusIndex === index ? "is-focused" : ""}`}
              style={
                { "--x": `${x}px`, "--y": `${y}px` } as React.CSSProperties
              }
              onClick={() => {
                selectedDayRef.current = index;
                setDayOfWeek(index);
                seekTo(index, selectedTimeRef.current).catch((err) => {
                  console.warn("[heatmap] failed to seek playback day", err);
                });
              }}
              onMouseEnter={() => {
                if (hoverTimeoutRef.current)
                  clearTimeout(hoverTimeoutRef.current);
                setHoveredDay(index);
              }}
              onMouseLeave={() => {
                hoverTimeoutRef.current = setTimeout(() => {
                  setHoveredDay(null);
                }, 150);
              }}
              aria-label={`Select day ${index + 1}`}
            >
              {dayLabel}
            </button>
          );
        })}

        <div className="radial-dial-container">
          <div
            className="radial-dial"
            ref={dialRef}
            onPointerDown={(e) => {
              setIsDraggingDial(true);
              updateTimeFromPointer(e.clientX, e.clientY);
            }}
            style={{ touchAction: "none" }}
          >
            <svg viewBox="-75 -75 150 150" className="radial-dial-svg">
              <circle cx="0" cy="0" r={dialRadius} className="dial-track" />
              <line
                x1="0"
                y1={-dialRadius - 6}
                x2="0"
                y2={-dialRadius + 6}
                stroke="rgba(43, 77, 112, 0.4)"
                strokeWidth="2"
              />
              <line
                x1="0"
                y1={dialRadius - 6}
                x2="0"
                y2={dialRadius + 6}
                stroke="rgba(43, 77, 112, 0.4)"
                strokeWidth="2"
              />
              <line
                x1={-dialRadius - 6}
                y1="0"
                x2={-dialRadius + 6}
                y2="0"
                stroke="rgba(43, 77, 112, 0.4)"
                strokeWidth="2"
              />
              <line
                x1={dialRadius - 6}
                y1="0"
                x2={dialRadius + 6}
                y2="0"
                stroke="rgba(43, 77, 112, 0.4)"
                strokeWidth="2"
              />

              <circle cx={thumbX} cy={thumbY} r="8" className="dial-thumb" />
            </svg>
            <div className="dial-center-content">
              <span className="dial-time">{formatTime(timeOfDay)}</span>
              <button
                className="dial-play-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setPlaying(!backendIsPlaying).catch((err) => {
                    console.warn("[heatmap] failed to update playback", err);
                  });
                }}
                aria-label={backendIsPlaying ? "Pause" : "Play"}
              >
                {backendIsPlaying ? "PAUSE" : "PLAY"}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div
        className={`app-loading-screen ${isAppReady ? "is-complete" : ""} ${
          streamUnreachable ? "has-error" : ""
        }`}
        aria-hidden={isAppReady}
      >
        <div className="app-loading-panel">
          <div className="loading-kicker">Gridlock</div>
          <div className="loading-title">Seattle Transit Sim</div>
          <div className="loading-award">
            <span className="loading-award-icon" aria-hidden="true">
              &#127942;
            </span>
            Finalist Prize &middot; UWBHacks 2026
          </div>
          <div className="loading-status">{loadingStatus}</div>
          {streamUnreachable ? (
            <>
              <p className="loading-detail">
                {heatmapDiagnostics.lastError ??
                  "The simulation backend is not responding."}
              </p>
              <button
                type="button"
                className="loading-retry"
                onClick={retryConnection}
              >
                Retry connection
              </button>
            </>
          ) : (
            <>
              <div className="loading-track" aria-hidden="true" />
              <div className="loading-steps" aria-hidden="true">
                <span className={isMapLoaded ? "is-done" : ""} />
                <span className={initialBuildingRegionLoaded ? "is-done" : ""} />
                <span className={initialHeatmapStreamLoaded ? "is-done" : ""} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
