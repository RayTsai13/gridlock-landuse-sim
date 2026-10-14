import {
  synthesizeTrainInstances,
  configureTrainService,
  type TrainInstance,
  useInterpolatedMinuteOfWeek,
} from "./stops/trains.ts";
import { memo, useEffect, useMemo, useState } from 'react';
import type { Layer } from '@deck.gl/core';
import { AmbientLight, DirectionalLight, LightingEffect } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import { DeckGLOverlay } from './DeckGLOverlay.tsx';
import type { TransitLine } from './stops/data.ts';
import type { TrainServiceArtifact } from './stops/train_service.ts';
import type { PlaybackState } from './heatmap/api.ts';

// Only this subtree updates at animation cadence.
export default memo(function MapOverlays({ lines: activeLines, playback, showSpaceNeedle }: {
  lines: TransitLine[];
  playback: PlaybackState | null;
  showSpaceNeedle: boolean;
}) {
  const [serviceReady, setServiceReady] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/seattle/train-service.json', { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Train schedules unavailable');
        return response.json() as Promise<TrainServiceArtifact>;
      })
      .then((artifact) => { configureTrainService(artifact); setServiceReady(true); })
      .catch((error: unknown) => { if (!controller.signal.aborted) console.warn('[service]', error); });
    return () => controller.abort();
  }, []);
  const interpolatedMinuteOfWeek = useInterpolatedMinuteOfWeek(activeLines.length ? playback : null);
  const deckEffects = useMemo(() => [new LightingEffect({
    ambientLight: new AmbientLight({color: [255, 255, 255], intensity: 10}),
    blueLight: new DirectionalLight({color: [255, 255, 255], intensity: 5, direction: [-1, -3, -1]}),
  })], []);
  const [createLandmark, setCreateLandmark] = useState<(() => Layer) | null>(null);
  useEffect(() => {
    if (!showSpaceNeedle || createLandmark) return;
    let cancelled = false;
    void import('./SpaceNeedle.ts').then(({ createSpaceNeedleLayer }) => {
      if (!cancelled) setCreateLandmark(() => createSpaceNeedleLayer);
    }).catch((error: unknown) => console.warn('[landmark]', error));
    return () => { cancelled = true; };
  }, [showSpaceNeedle, createLandmark]);
  // A removed deck.gl layer is finalized and cannot be re-added. Retain the
  // factory/code, but allocate a fresh layer when the landmark re-enters view.
  const spaceNeedleLayer = useMemo(
    () => showSpaceNeedle && createLandmark ? createLandmark() : null,
    [showSpaceNeedle, createLandmark],
  );
  const trainInstances = useMemo(
    () => serviceReady ? synthesizeTrainInstances(activeLines, interpolatedMinuteOfWeek) : [],
    [activeLines, interpolatedMinuteOfWeek, serviceReady],
  );
  const deckLayers = useMemo(
    () => [
      ...(showSpaceNeedle && spaceNeedleLayer ? [spaceNeedleLayer] : []),
      new ScatterplotLayer({
        id: "train-glow-layer",
        beforeId: "transit-stops-labels",
        data: trainInstances,
        pickable: false,
        radiusUnits: "pixels",
        radiusMinPixels: 10,
        radiusMaxPixels: 10,
        stroked: false,
        filled: true,
        getPosition: (train: TrainInstance) => train.coordinates,
        getFillColor: (train: TrainInstance) =>
          [train.color[0], train.color[1], train.color[2], 70] as [
            number,
            number,
            number,
            number,
          ],
        parameters: {
          depthTest: false,
        },
      }),
      new ScatterplotLayer({
        id: "train-head-layer",
        beforeId: "transit-stops-labels",
        data: trainInstances,
        pickable: false,
        radiusUnits: "pixels",
        radiusMinPixels: 5,
        radiusMaxPixels: 5,
        stroked: true,
        lineWidthUnits: "pixels",
        lineWidthMinPixels: 2,
        filled: true,
        getPosition: (train: TrainInstance) => train.coordinates,
        getFillColor: (train: TrainInstance) => train.color,
        getLineColor: [245, 250, 255, 220],
        parameters: {
          depthTest: false,
        },
      }),
    ],
    [trainInstances, showSpaceNeedle, spaceNeedleLayer],
  );


  return <DeckGLOverlay interleaved effects={deckEffects} layers={deckLayers} />;
});
