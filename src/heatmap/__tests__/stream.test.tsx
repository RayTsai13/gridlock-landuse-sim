/**
 * @vitest-environment jsdom
 */
import { useEffect } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHeatmap } from '../stream.ts';
import type { GridConfig } from '../grid.ts';

const config: GridConfig = {
  bounds: { west: -122.5, south: 47.5, east: -122.4, north: 47.6 },
  rows: 10,
  cols: 10,
};

/** Minimal stand-in for EventSource that lets a test emit named events. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, Set<(e: MessageEvent) => void>>();
  closed = false;

  url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (e: MessageEvent) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, handler: (e: MessageEvent) => void) {
    this.listeners.get(type)?.delete(handler);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data?: unknown) {
    const event = { data: typeof data === 'string' ? data : JSON.stringify(data) };
    act(() => {
      for (const handler of this.listeners.get(type) ?? []) {
        handler(event as MessageEvent);
      }
    });
  }
}

// A test probe deliberately captures what the hook returned. Publishing it
// through an effect keeps the render itself side-effect free.
const captured: { api: ReturnType<typeof useHeatmap> | null } = { api: null };

function Probe() {
  const api = useHeatmap();
  useEffect(() => {
    captured.api = api;
  });
  return null;
}

function hook(): ReturnType<typeof useHeatmap> {
  if (!captured.api) throw new Error('Probe has not rendered yet');
  return captured.api;
}

function currentSource() {
  return FakeEventSource.instances[FakeEventSource.instances.length - 1];
}

beforeEach(() => {
  captured.api = null;
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useHeatmap frame gating', () => {
  it('renders frames once config has arrived', () => {
    render(<Probe />);
    currentSource().emit('config', config);
    currentSource().emit('frame', {
      timestamp: 1,
      state_version: 'state_v4',
      cells: [[5, 5, 0.9]],
    });
    expect(hook().frame?.cells.length).toBeGreaterThan(0);
  });

  it('drops frames that arrive before config', () => {
    render(<Probe />);
    currentSource().emit('frame', {
      timestamp: 1,
      state_version: 'state_v1',
      cells: [[5, 5, 0.9]],
    });
    expect(hook().frame).toBeNull();
  });

  it('survives a malformed payload instead of throwing out of the listener', () => {
    render(<Probe />);
    currentSource().emit('config', config);
    expect(() => currentSource().emit('frame', '{not json')).not.toThrow();

    currentSource().emit('frame', {
      timestamp: 1,
      state_version: 'state_v2',
      cells: [[5, 5, 0.9]],
    });
    expect(hook().frame?.cells.length).toBeGreaterThan(0);
  });

  it('keeps rendering after a backend restart resets state_version', async () => {
    // The version floor is raised by a scenario switch. A restarted backend
    // counts from zero again, so without a reset on reconnect every later
    // frame sits below the floor and the map freezes while still reporting
    // the connection as open.
    render(<Probe />);
    const source = currentSource();
    source.emit('config', config);

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        scenario_id: 'line-1-2',
        frame: { timestamp: 1, state_version: 'state_v40', cells: [[1, 1, 0.5]] },
      }),
    });
    await act(async () => {
      await hook().setScenario('line-1-2');
    });

    // A pre-restart frame below the floor is still correctly dropped.
    source.emit('frame', {
      timestamp: 2,
      state_version: 'state_v3',
      cells: [[5, 5, 0.9]],
    });
    expect(hook().diagnostics.lastFrameCellCount).toBe(1);

    // The reconnect handshake re-sends config; frames must flow again.
    source.emit('config', config);
    source.emit('frame', {
      timestamp: 3,
      state_version: 'state_v1',
      cells: [[5, 5, 0.9], [5, 6, 0.8]],
    });
    await waitFor(() => {
      expect(hook().diagnostics.lastFrameCellCount).toBe(2);
    });
  });

  it('lifts the scenario gate even when the response carries no frame', async () => {
    render(<Probe />);
    const source = currentSource();
    source.emit('config', config);

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ scenario_id: 'line-1-2' }),
    });
    await act(async () => {
      await hook().setScenario('line-1-2');
    });
    expect(hook().diagnostics.pendingScenarioId).toBeNull();

    source.emit('frame', {
      timestamp: 4,
      state_version: 'state_v9',
      cells: [[2, 2, 0.7]],
    });
    expect(hook().frame?.cells.length).toBeGreaterThan(0);
  });

  it('lifts the scenario gate when the request fails', async () => {
    render(<Probe />);
    currentSource().emit('config', config);

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    await act(async () => {
      await expect(hook().setScenario('line-1-2')).rejects.toThrow();
    });
    expect(hook().diagnostics.pendingScenarioId).toBeNull();
  });

  it('ignores a scenario response from before a configuration reset', async () => {
    render(<Probe />);
    currentSource().emit('config', config);
    let resolveResponse: (response: unknown) => void = () => {};
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(resolve => { resolveResponse = resolve; }));
    let pending: Promise<void>;
    act(() => { pending = hook().setScenario('line-1-2'); });
    currentSource().emit('config', config);
    await act(async () => {
      resolveResponse({ ok: true, status: 200, json: async () => ({
        scenario_id: 'line-1-2',
        frame: { timestamp: 1, state_version: 'state_v40', cells: [[1, 1, 0.5]] },
      }) });
      await pending;
    });
    expect(hook().frame).toBeNull();
    expect(hook().diagnostics.pendingScenarioId).toBeNull();
  });

  it('reports a failed connection after repeated errors', () => {
    render(<Probe />);
    const source = currentSource();
    source.emit('error');
    expect(hook().diagnostics.connection).toBe('error');
    source.emit('error');
    source.emit('error');
    expect(hook().diagnostics.connection).toBe('failed');
  });

  it('opens a fresh EventSource when the connection is retried', () => {
    render(<Probe />);
    const before = FakeEventSource.instances.length;
    act(() => {
      hook().retryConnection();
    });
    expect(FakeEventSource.instances.length).toBe(before + 1);
    expect(hook().diagnostics.connection).toBe('connecting');
  });
});

describe('useHeatmap reset handling', () => {
  it('clears accepted frames on clear and configuration replacement', () => {
    render(<Probe />);
    const source = currentSource();
    source.emit('config', config);
    source.emit('frame', { timestamp: 1, cells: [[5, 5, 0.9]] });
    expect(hook().frame).not.toBeNull();
    source.emit('clear');
    expect(hook().frame).toBeNull();
    source.emit('frame', { timestamp: 2, cells: [[5, 5, 0.9]] });
    source.emit('config', config);
    expect(hook().frame).toBeNull();
  });

  it('clears accepted frames on session reset', () => {
    render(<Probe />);
    currentSource().emit('config', config);
    currentSource().emit('frame', { timestamp: 1, cells: [[5, 5, 0.9]] });
    act(() => window.dispatchEvent(new Event('simulation-reset')));
    expect(hook().frame).toBeNull();
  });
});
