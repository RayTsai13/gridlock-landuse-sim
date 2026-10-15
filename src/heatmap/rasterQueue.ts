import type { CellTuple } from './grid.ts';
import type { RasterRequest, RasterResponse } from './raster.ts';

export type RasterWorker = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror'>;

export class RasterQueue {
  private serial = 0;
  private busy = false;
  private pending: { id: number; cells: CellTuple[] } | null = null;
  private disposed = false;
  private worker: RasterWorker;
  private accept: (result: RasterResponse) => void;

  constructor(worker: RasterWorker, init: Extract<RasterRequest, { type: 'init' }>, accept: (result: RasterResponse) => void, fail: () => void) {
    this.worker = worker;
    this.accept = accept;
    worker.onmessage = (event: MessageEvent<RasterResponse>) => {
      if (this.disposed) return;
      this.busy = false;
      if (event.data.id === this.serial) this.accept(event.data);
      this.flush();
    };
    worker.onerror = () => { this.dispose(); fail(); };
    worker.postMessage(init);
  }

  submit(cells: CellTuple[]) {
    this.pending = { id: ++this.serial, cells };
    this.flush();
  }

  invalidate() {
    this.serial++;
    this.pending = null;
  }

  private flush() {
    if (this.disposed || this.busy || !this.pending) return;
    this.worker.postMessage({ type: 'render', ...this.pending } satisfies RasterRequest);
    this.pending = null;
    this.busy = true;
  }

  dispose() {
    this.disposed = true;
    this.invalidate();
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
  }
}
