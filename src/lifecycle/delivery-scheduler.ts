import type { FabricLifecycleEvent, FabricLifecycleSubscription } from "./types.js";

export interface PendingLifecycleDelivery {
  subscription: FabricLifecycleSubscription;
  event: FabricLifecycleEvent;
}

export type LifecycleBatchDispatcher = (
  target: string,
  batch: PendingLifecycleDelivery[],
) => Promise<void>;

export type LifecycleDeliveryErrorHandler = (
  target: string,
  batch: PendingLifecycleDelivery[],
  error: unknown,
) => void;

export const DEFAULT_LIFECYCLE_COALESCE_MS = 2_000;

/**
 * Coalesce lifecycle deliveries per target so a burst of run completions
 * wakes the orchestrator once instead of once per event (#85).
 *
 * Each wake turn costs the orchestrator a full agent run; without coalescing,
 * a fan-out of N completed runs serializes into N runs and later events land
 * many minutes after their occurredAt. followUp deliveries for the same
 * target inside the coalescing window are batched into one message; steer
 * deliveries pass through immediately because they interrupt the current
 * run and must not be delayed.
 */
export class LifecycleDeliveryScheduler {
  readonly #coalesceMs: number;
  readonly #buffers = new Map<string, PendingLifecycleDelivery[]>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #inFlight = new Map<string, Promise<void>>();
  #closed = false;

  constructor(
    coalesceMs: number,
    readonly deliver: LifecycleBatchDispatcher,
    readonly onError: LifecycleDeliveryErrorHandler = () => {},
  ) {
    this.#coalesceMs = Math.max(0, coalesceMs);
  }

  schedule(target: string, delivery: PendingLifecycleDelivery): void {
    if (this.#closed) return;
    if (delivery.subscription.delivery === "steer") {
      void this.#dispatch(target, [delivery]);
      return;
    }
    const buffer = this.#buffers.get(target);
    if (buffer) buffer.push(delivery);
    else this.#buffers.set(target, [delivery]);
    if (this.#timers.has(target)) return;
    const timer = setTimeout(() => void this.flush(target), this.#coalesceMs);
    timer.unref();
    this.#timers.set(target, timer);
  }

  async flush(target: string): Promise<void> {
    const timer = this.#timers.get(target);
    if (timer) {
      clearTimeout(timer);
      this.#timers.delete(target);
    }
    const batch = this.#buffers.get(target);
    if (!batch || batch.length === 0) return;
    this.#buffers.delete(target);
    await this.#dispatch(target, batch);
  }

  async flushAll(): Promise<void> {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    const targets = [...this.#buffers.keys()];
    await Promise.all(targets.map((target) => this.flush(target)));
    await Promise.all(this.#inFlight.values());
  }

  async dispose(): Promise<void> {
    this.#closed = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#buffers.clear();
    await Promise.all(this.#inFlight.values());
  }

  async #dispatch(target: string, batch: PendingLifecycleDelivery[]): Promise<void> {
    const previous = this.#inFlight.get(target);
    const operation = (async () => {
      await previous?.catch(() => undefined);
      try {
        await this.deliver(target, batch);
      } catch (error) {
        this.onError(target, batch, error);
      }
    })();
    this.#inFlight.set(
      target,
      operation.finally(() => {
        if (this.#inFlight.get(target) === operation) this.#inFlight.delete(target);
      }),
    );
    await operation;
  }
}
