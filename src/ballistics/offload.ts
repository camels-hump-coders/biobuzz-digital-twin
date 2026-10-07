/**
 * Main-thread side of the ballistics worker. Everything degrades to synchronous computation when workers are not
 * available (tests, very old browsers), so callers never have to care.
 */
import { monteCarlo, type MonteCarlo, type NoiseConfig, type NominalLaunch } from "./dispersion";
import type { ShotRequest } from "./solver";
import type { WorkerRequest, WorkerResponse } from "./ballistics.worker";

type BatchHandler = (from: number, results: any[]) => void;

export class BallisticsOffload {
  private worker?: Worker;
  private nextId = 1;
  private mcPending = new Map<string, number>(); // cache key -> request id in flight
  private mcResults = new Map<string, MonteCarlo>();
  private mcIdToKey = new Map<number, string>();
  private batches = new Map<number, BatchHandler>();
  /** how many Monte Carlos were answered by the worker (diagnostics) */
  answered = 0;
  constructor() {
    try {
      if (typeof Worker !== "undefined") {
        this.worker = new Worker(new URL("./ballistics.worker.ts", import.meta.url), { type: "module" });
        this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.onMessage(e.data);
        this.worker.onerror = () => { this.worker = undefined; }; // fall back to synchronous maths
      }
    } catch { this.worker = undefined; }
  }
  get active() { return !!this.worker; }

  private onMessage(m: WorkerResponse) {
    if (m.kind === "mc") {
      const key = this.mcIdToKey.get(m.id); this.mcIdToKey.delete(m.id);
      if (key === undefined) return;
      if (this.mcPending.get(key) === m.id) this.mcPending.delete(key);
      this.mcResults.set(key, m.result); this.answered++;
      if (this.mcResults.size > 64) this.mcResults.delete(this.mcResults.keys().next().value!);
      return;
    }
    this.batches.get(m.id)?.(m.from, m.results);
  }

  /**
   * Monte Carlo by cache key. Synchronous when there is no worker; otherwise returns the cached result for this key
   * (or `fallback`, typically the previous answer) while the worker computes a new one.
   */
  monteCarlo(key: string, req: ShotRequest, nominal: NominalLaunch, noise: NoiseConfig, n: number, seed: number, fallback?: MonteCarlo): MonteCarlo | undefined {
    const hit = this.mcResults.get(key);
    if (hit) return hit;
    if (!this.worker) { const r = monteCarlo(req, nominal, noise, n, seed); this.mcResults.set(key, r); return r; }
    if (!this.mcPending.has(key)) {
      const id = this.nextId++;
      this.mcPending.set(key, id); this.mcIdToKey.set(id, key);
      this.post({ kind: "mc", id, req, nominal, noise, n, seed });
    }
    return fallback;
  }

  /** Start a map batch in the worker; returns its id, or undefined when there is no worker (compute on the main thread). */
  startBatch(payload: Omit<Extract<WorkerRequest, { kind: "hitmap" }>, "id"> | Omit<Extract<WorkerRequest, { kind: "reach" }>, "id">, onChunk: BatchHandler): number | undefined {
    if (!this.worker) return undefined;
    const id = this.nextId++;
    this.batches.set(id, onChunk);
    this.post({ ...payload, id } as WorkerRequest);
    return id;
  }
  cancel(id: number | undefined) {
    if (id === undefined) return;
    this.batches.delete(id);
    this.post({ kind: "cancel", id });
  }
  private post(m: WorkerRequest) { this.worker?.postMessage(m); }
}
