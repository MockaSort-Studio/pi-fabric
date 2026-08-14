import type {
  FabricComponentDisposer,
  FabricComponentEffect,
} from "./types.js";

interface FabricEffectFailure {
  label: string;
  error: string;
}

export interface FabricEffectCleanupReport {
  status: "disposed" | "quarantined";
  failures: FabricEffectFailure[];
}

interface EffectRecord {
  label: string;
  disposers: FabricComponentDisposer[];
  setup: Promise<void>;
  dispose: () => Promise<void>;
  disposed: boolean;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  "then" in value &&
  typeof (value as { then?: unknown }).then === "function";

const isIterable = (value: unknown): value is Iterable<unknown> =>
  typeof value === "object" &&
  value !== null &&
  Symbol.iterator in value &&
  typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function";

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  typeof value === "object" &&
  value !== null &&
  Symbol.asyncIterator in value &&
  typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function";

const collectDisposer = (
  value: unknown,
  disposers: FabricComponentDisposer[],
): void => {
  if (value === undefined || value === null) return;
  if (typeof value !== "function") throw new TypeError("Fabric effect yielded an invalid disposer");
  disposers.push(value as FabricComponentDisposer);
};

const collectEffect = async (
  effect: FabricComponentEffect,
  disposers: FabricComponentDisposer[],
): Promise<void> => {
  const resolved = isPromiseLike(effect) ? await effect : effect;
  if (resolved === undefined || resolved === null || typeof resolved === "function") {
    collectDisposer(resolved, disposers);
    return;
  }
  if (isAsyncIterable(resolved)) {
    for await (const disposer of resolved) collectDisposer(disposer, disposers);
    return;
  }
  if (isIterable(resolved)) {
    for (const disposer of resolved) collectDisposer(disposer, disposers);
    return;
  }
  throw new TypeError("Fabric effect returned an unsupported value");
};

export class FabricEffectScope {
  readonly #records: EffectRecord[] = [];
  readonly #setupCleanupFailures: FabricEffectFailure[] = [];
  #state: "open" | "disposing" | "disposed" = "open";
  #cleanup: Promise<FabricEffectCleanupReport> | undefined;

  get state(): "open" | "disposing" | "disposed" {
    return this.#state;
  }

  async effect(
    setup: () => FabricComponentEffect,
    label = "anonymous",
  ): Promise<FabricComponentDisposer> {
    if (this.#state !== "open") {
      throw new Error("Cannot create an effect on a disposing Fabric scope");
    }

    const record: EffectRecord = {
      label,
      disposers: [],
      setup: Promise.resolve(),
      dispose: async () => {},
      disposed: false,
    };
    const cleanupDisposers = async (): Promise<void> => {
      const failures: unknown[] = [];
      for (const disposer of record.disposers.splice(0).reverse()) {
        try {
          await disposer();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, `Fabric effect cleanup failed: ${label}`);
      }
    };

    let disposal: Promise<void> | undefined;
    record.dispose = async () => {
      if (record.disposed) return disposal;
      record.disposed = true;
      disposal = (async () => {
        await record.setup.catch(() => undefined);
        await cleanupDisposers();
      })();
      return disposal;
    };

    this.#records.push(record);
    record.setup = (async () => {
      try {
        await collectEffect(setup(), record.disposers);
      } catch (error) {
        try {
          await cleanupDisposers();
        } catch (cleanupError) {
          const failures = cleanupError instanceof AggregateError
            ? cleanupError.errors
            : [cleanupError];
          for (const failure of failures) {
            this.#setupCleanupFailures.push({ label, error: errorMessage(failure) });
          }
          throw new AggregateError(
            [error, cleanupError],
            `Fabric effect setup and rollback failed: ${label}`,
          );
        }
        throw error;
      }
    })();

    try {
      await record.setup;
      if (this.#state === "open") {
        const index = this.#records.indexOf(record);
        if (index >= 0 && index !== this.#records.length - 1) {
          this.#records.splice(index, 1);
          this.#records.push(record);
        }
      }
    } catch (error) {
      const index = this.#records.indexOf(record);
      if (index >= 0) this.#records.splice(index, 1);
      throw error;
    }
    return record.dispose;
  }

  defer(
    disposer: FabricComponentDisposer,
    label = "deferred",
  ): FabricComponentDisposer {
    if (this.#state !== "open") {
      throw new Error("Cannot defer cleanup on a disposing Fabric scope");
    }
    const record: EffectRecord = {
      label,
      disposers: [disposer],
      setup: Promise.resolve(),
      dispose: async () => {},
      disposed: false,
    };
    let disposal: Promise<void> | undefined;
    record.dispose = async () => {
      if (record.disposed) return disposal;
      record.disposed = true;
      disposal = (async () => {
        const failures: unknown[] = [];
        for (const cleanup of record.disposers.splice(0).reverse()) {
          try {
            await cleanup();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, `Fabric effect cleanup failed: ${label}`);
        }
      })();
      return disposal;
    };
    this.#records.push(record);
    return record.dispose;
  }

  dispose(): Promise<FabricEffectCleanupReport> {
    if (this.#cleanup) return this.#cleanup;
    this.#state = "disposing";
    this.#cleanup = (async () => {
      const failures: FabricEffectFailure[] = this.#setupCleanupFailures.splice(0);
      for (const record of this.#records.splice(0).reverse()) {
        try {
          await record.dispose();
        } catch (error) {
          if (error instanceof AggregateError) {
            for (const nested of error.errors) {
              failures.push({ label: record.label, error: errorMessage(nested) });
            }
          } else {
            failures.push({ label: record.label, error: errorMessage(error) });
          }
        }
      }
      this.#state = "disposed";
      return {
        status: failures.length > 0 ? "quarantined" : "disposed",
        failures,
      };
    })();
    return this.#cleanup;
  }
}
