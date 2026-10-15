import { useCallback, useEffect, useRef, useState } from 'react';
import { ensureSession } from './session.ts';
import type { GridConfig, Frame } from './grid.ts';
import {
  deleteAllPeople,
  deletePerson,
  postPlayback,
  postPeople,
  postPeopleBatch,
  postScenario,
  seekPlayback,
  type PeopleOptions,
  type PeopleDrop,
  type PlaybackState,
  type PlacedPerson,
  type ScenarioLine,
  type ScenarioStop,
} from './api.ts';

const STREAM_URL = '/api/heatmap/stream';

/** Consecutive SSE errors before we stop calling it a transient blip. */
const CONNECTION_FAILURE_THRESHOLD = 3;

function stateVersionNumber(stateVersion?: string): number | null {
  if (!stateVersion) return null;
  const match = /^state_v(\d+)$/.exec(stateVersion);
  return match ? Number.parseInt(match[1], 10) : null;
}

export type HeatmapApi = {
  frame: Frame | null;
  config: GridConfig | null;
  network: { stops: ScenarioStop[]; lines: ScenarioLine[] } | null;
  /** Last scenario_id confirmed by the server via a `scenario` event. */
  scenarioId: string | null;
  playback: PlaybackState | null;
  diagnostics: HeatmapDiagnostics;
  /** Force a fresh EventSource after the connection has been declared failed. */
  retryConnection: () => void;
  setScenario: (id: string, stops?: ScenarioStop[], lines?: ScenarioLine[]) => Promise<void>;
  setPlaying: (isPlaying: boolean) => Promise<void>;
  seekTo: (dayOfWeek: number, timeBin: number) => Promise<void>;
  addPeople: (
    lat: number,
    lon: number,
    count?: number,
    options?: PeopleOptions,
  ) => Promise<PlacedPerson>;
  removePeople: (id: string) => Promise<void>;
  addPeopleBatch: (people: PeopleDrop[]) => Promise<PlacedPerson[]>;
  clearPeople: () => Promise<void>;
};

export type HeatmapDiagnostics = {
  connection: 'connecting' | 'open' | 'error' | 'failed';
  pendingScenarioId: string | null;
  confirmedScenarioId: string | null;
  frameCount: number;
  lastFrameCellCount: number;
  lastFrameAt: number | null;
  config: Pick<GridConfig, 'rows' | 'cols'> | null;
  simTime: PlaybackState['sim_time'] | null;
  lastError: string | null;
};

export function useHeatmap(): HeatmapApi {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [network, setNetwork] = useState<{ stops: ScenarioStop[]; lines: ScenarioLine[] } | null>(null);
  const [scenarioId, setScenarioId] = useState<string | null>(null);
  const [playback, setPlaybackState] = useState<PlaybackState | null>(null);
  const [diagnostics, setDiagnostics] = useState<HeatmapDiagnostics>({
    connection: 'connecting',
    pendingScenarioId: null,
    confirmedScenarioId: null,
    frameCount: 0,
    lastFrameCellCount: 0,
    lastFrameAt: null,
    config: null,
    simTime: null,
    lastError: null,
  });
  const configRef = useRef<GridConfig | null>(null);
  const minimumFrameStateVersionRef = useRef<number | null>(null);
  // Set when a scenario switch is in flight; frames are dropped until the
  // server's `scenario` event confirms the switch by matching this value.
  const pendingScenarioRef = useRef<string | null>(null);
  const consecutiveErrorsRef = useRef(0);
  const scenarioRequestRef = useRef(0);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    const source = new EventSource(STREAM_URL);
    let cancelled = false;
    let recovering = false;
    const recover = () => {
      if (recovering) return;
      recovering = true;
      void ensureSession().then((session) => {
        if (cancelled) return;
        if (session.reset) window.dispatchEvent(new Event('simulation-reset'));
        source.close();
        setRetryToken((value) => value + 1);
      }).catch(() => { recovering = false; });
    };
    const onReset = () => {
      scenarioRequestRef.current++;
      configRef.current = null;
      minimumFrameStateVersionRef.current = null;
      pendingScenarioRef.current = null;
      setFrame(null);
      source.close();
      setRetryToken((value) => value + 1);
    };
    window.addEventListener('simulation-reset', onReset);

    /** Parse an SSE payload without letting a bad frame kill the listener. */
    const parse = <T,>(event: MessageEvent, label: string): T | null => {
      try {
        return JSON.parse(event.data as string) as T;
      } catch (err) {
        console.warn(`[heatmap] discarded a malformed \`${label}\` event`, err);
        setDiagnostics((current) => ({
          ...current,
          lastError: `Malformed \`${label}\` event from the server.`,
        }));
        return null;
      }
    };

    source.addEventListener('open', () => {
      consecutiveErrorsRef.current = 0;
      setDiagnostics((current) => ({
        ...current,
        connection: 'open',
        lastError: null,
      }));
    });

    source.addEventListener('config', (e: MessageEvent) => {
      const config = parse<GridConfig>(e, 'config');
      if (!config) return;
      scenarioRequestRef.current++;
      configRef.current = config;
      setFrame(null);
      // `config` is re-emitted on every (re)connection, which makes it the one
      // reliable signal that the server may be a *different* process than the
      // one these gates were calibrated against. A restarted backend counts
      // state_version from zero again, so without this reset every subsequent
      // frame sits below the floor and is dropped forever -- the map freezes
      // while the connection still reports itself as open.
      minimumFrameStateVersionRef.current = null;
      pendingScenarioRef.current = null;
      consecutiveErrorsRef.current = 0;
      setDiagnostics((current) => ({
        ...current,
        config: { rows: config.rows, cols: config.cols },
        pendingScenarioId: null,
      }));
    });

    source.addEventListener('scenario', (e: MessageEvent) => {
      const payload = parse<{ scenario_id: string; stops?: ScenarioStop[]; lines?: ScenarioLine[] }>(e, 'scenario');
      if (!payload) return;
      setFrame(null);
      setScenarioId(payload.scenario_id);
      if (payload.stops && payload.lines) setNetwork({ stops: payload.stops, lines: payload.lines });
      if (pendingScenarioRef.current === payload.scenario_id) {
        pendingScenarioRef.current = null;
      }
      setDiagnostics((current) => ({
        ...current,
        confirmedScenarioId: payload.scenario_id,
        pendingScenarioId: pendingScenarioRef.current,
      }));
    });

    source.addEventListener('playback', (e: MessageEvent) => {
      const nextPlayback = parse<PlaybackState>(e, 'playback');
      if (!nextPlayback) return;
      setPlaybackState(nextPlayback);
      setDiagnostics((current) => ({
        ...current,
        simTime: nextPlayback.sim_time,
      }));
    });

    source.addEventListener('frame', (e: MessageEvent) => {
      if (!configRef.current) return;
      if (pendingScenarioRef.current !== null) return;
      const frame = parse<Frame>(e, 'frame');
      if (!frame) return;
      const frameVersion = stateVersionNumber(frame.state_version);
      const minimumFrameStateVersion = minimumFrameStateVersionRef.current;
      if (
        frameVersion !== null &&
        minimumFrameStateVersion !== null &&
        frameVersion < minimumFrameStateVersion
      ) {
        return;
      }
      setFrame(frame);

      setDiagnostics((current) => ({
        ...current,
        frameCount: current.frameCount + 1,
        lastFrameCellCount: frame.cells.length,
        lastFrameAt: Date.now(),
        simTime: frame.sim_time ?? current.simTime,
      }));
    });

    source.addEventListener('clear', () => {
      setFrame(null);
      setDiagnostics((current) => ({
        ...current,
        lastFrameCellCount: 0,
      }));
    });

    source.addEventListener('error', () => {
      consecutiveErrorsRef.current += 1;
      const failed = consecutiveErrorsRef.current >= CONNECTION_FAILURE_THRESHOLD;
      if (failed) {
        console.warn('[heatmap] SSE connection is not recovering');
        recover();
      }
      setDiagnostics((current) => ({
        ...current,
        connection: failed ? 'failed' : 'error',
        lastError: failed
          ? 'Cannot reach the simulation server.'
          : 'SSE connection error; browser will retry automatically.',
      }));
    });

    return () => {
      cancelled = true;
      window.removeEventListener('simulation-reset', onReset);
      source.close();
    };
  }, [retryToken]);

  const retryConnection = useCallback(() => {
    consecutiveErrorsRef.current = 0;
    setDiagnostics((current) => ({
      ...current,
      connection: 'connecting',
      lastError: null,
    }));
    setRetryToken((token) => token + 1);
  }, []);

  const setScenario = useCallback(async (
    id: string,
    stops: ScenarioStop[] = [],
    lines: ScenarioLine[] = [],
  ) => {
    const requestId = ++scenarioRequestRef.current;
    pendingScenarioRef.current = id;
    setFrame(null);
    setDiagnostics((current) => ({
      ...current,
      pendingScenarioId: id,
      lastError: null,
    }));
    try {
      const response = await postScenario(id, stops, lines);
      if (requestId !== scenarioRequestRef.current) return;
      setScenarioId(response.scenario_id);
      if (response.stops && response.lines) setNetwork({ stops: response.stops, lines: response.lines });
      if (response.frame && configRef.current) {
        const frameVersion = stateVersionNumber(response.frame.state_version);
        if (frameVersion !== null) {
          minimumFrameStateVersionRef.current = Math.max(
            minimumFrameStateVersionRef.current ?? frameVersion,
            frameVersion,
          );
        }
        setFrame(response.frame);
        setDiagnostics((current) => ({
          ...current,
          confirmedScenarioId: response.scenario_id,
          frameCount: current.frameCount + 1,
          lastFrameCellCount: response.frame?.cells.length ?? 0,
          lastFrameAt: Date.now(),
          simTime: response.frame?.sim_time ?? current.simTime,
        }));
      }
    } catch (err) {
      if (requestId !== scenarioRequestRef.current) return;
      setDiagnostics((current) => ({
        ...current,
        lastError: err instanceof Error ? err.message : 'Failed to post scenario.',
      }));
      throw err;
    } finally {
      // Always lift the gate. Leaving it raised -- which happened whenever the
      // response carried no frame, or config had not arrived yet -- drops every
      // subsequent frame and freezes the map.
      if (requestId === scenarioRequestRef.current) {
        pendingScenarioRef.current = null;
        setDiagnostics((current) => ({ ...current, pendingScenarioId: null }));
      }
    }
  }, []);

  const setPlaying = useCallback(async (isPlaying: boolean) => {
    const nextPlayback = await postPlayback({ is_playing: isPlaying });
    setPlaybackState(nextPlayback);
  }, []);

  const seekTo = useCallback(async (dayOfWeek: number, timeBin: number) => {
    const nextPlayback = await seekPlayback(dayOfWeek, timeBin);
    setPlaybackState(nextPlayback);
    setDiagnostics((current) => ({
      ...current,
      simTime: nextPlayback.sim_time,
    }));
  }, []);

  const addPeople = useCallback(
    (lat: number, lon: number, count = 1, options: PeopleOptions = {}) =>
      postPeople(lat, lon, count, options),
    [],
  );
  const removePeople = useCallback((id: string) => deletePerson(id), []);
  const addPeopleBatch = useCallback((people: PeopleDrop[]) => postPeopleBatch(people), []);
  const clearPeople = useCallback(() => deleteAllPeople(), []);

  return {
    frame,
    config: configRef.current,
    network,
    scenarioId,
    playback,
    diagnostics,
    retryConnection,
    setScenario,
    setPlaying,
    seekTo,
    addPeople,
    addPeopleBatch,
    removePeople,
    clearPeople,
  };
}
