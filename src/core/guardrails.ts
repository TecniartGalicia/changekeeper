/**
 * Guardrails: size limits and the burst detector. Pure.
 */

export interface Limits {
  /** files above this are recorded (hash/size) but neither copied nor diffed */
  maxFileBytes: number;
  /** distinct *new* paths within `burstWindowMs` that trigger the burst pause */
  burstThreshold: number;
  burstWindowMs: number;
  /** soft cap of tracked files per session */
  maxFilesPerSession: number;
  /** baseline copy limits (dirty/untracked at start, or whole folder without git) */
  baselineMaxFiles: number;
  baselineMaxBytes: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxFileBytes: 2 * 1024 * 1024,
  burstThreshold: 500,
  burstWindowMs: 5000,
  maxFilesPerSession: 5000,
  baselineMaxFiles: 2000,
  baselineMaxBytes: 200 * 1024 * 1024,
};

/**
 * Sliding-window counter of distinct new paths. When the threshold is exceeded the detector goes
 * into `paused` state; the caller queues new paths until the user decides (track / ignore / re-baseline).
 */
export class BurstDetector {
  private readonly seen = new Map<string, number>(); // path → first-seen timestamp in window
  paused = false;
  constructor(private readonly threshold: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}

  /** Registers a *new* path (not yet tracked). Returns true when this registration tripped the guard. */
  register(pathKey: string): boolean {
    const t = this.now();
    for (const [k, ts] of this.seen) if (t - ts > this.windowMs) this.seen.delete(k);
    if (!this.seen.has(pathKey)) this.seen.set(pathKey, t);
    if (!this.paused && this.seen.size > this.threshold) {
      this.paused = true;
      return true;
    }
    return false;
  }

  reset(): void {
    this.seen.clear();
    this.paused = false;
  }

  get windowCount(): number {
    return this.seen.size;
  }
}
