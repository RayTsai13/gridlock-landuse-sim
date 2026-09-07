/** @vitest-environment jsdom */
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import MapOverlays from './MapOverlays.tsx';
import { DEPLOY_STEPS } from './stops/data.ts';
import type { PlaybackState } from './heatmap/api.ts';

const { overlayRender } = vi.hoisted(() => ({ overlayRender: vi.fn() }));
vi.mock('./DeckGLOverlay.tsx', () => ({ DeckGLOverlay: ({layers}: {layers: unknown[]}) => { overlayRender(layers); return null; } }));
vi.mock('./SpaceNeedle.ts', () => ({createSpaceNeedleLayer: () => ({id: 'landmark'})}));

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('animates the overlay without rerendering its map/UI parent', () => {
  vi.useFakeTimers();
  let callback: FrameRequestCallback = () => {};
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { callback = cb; return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const parentRender = vi.fn();
  const playback: PlaybackState = {
    is_playing: true, current_tick: 0, sim_step_seconds: 1800,
    sim_minutes_per_second: 30, frame_interval_seconds: 1, time_bin_minutes: 30,
    sim_time: { day_of_week: 1, time_bin: 600, minute_of_week: 2040 },
  };
  function Parent() {
    parentRender();
    return <MapOverlays lines={[DEPLOY_STEPS[0].line]} playback={playback} showSpaceNeedle={false} />;
  }
  render(<Parent />);
  act(() => vi.runAllTimers());
  const before = overlayRender.mock.calls.length;
  act(() => { now = 1000; callback(now); });
  expect(overlayRender.mock.calls.length).toBeGreaterThan(before);
  expect(parentRender).toHaveBeenCalledTimes(1);
});

it('creates a fresh landmark layer after leaving and returning to its viewport', async () => {
  const {rerender} = render(<MapOverlays lines={[]} playback={null} showSpaceNeedle />);
  const landmark = () => overlayRender.mock.calls.at(-1)?.[0].find((layer: {id: string}) => layer.id === 'landmark');
  await waitFor(() => expect(landmark()).toBeDefined());
  const first = landmark();
  rerender(<MapOverlays lines={[]} playback={null} showSpaceNeedle={false} />);
  expect(landmark()).toBeUndefined();
  rerender(<MapOverlays lines={[]} playback={null} showSpaceNeedle />);
  await waitFor(() => expect(landmark()).toBeDefined());
  expect(landmark()).not.toBe(first);
});
