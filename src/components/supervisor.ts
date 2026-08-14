import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stableJsonHash } from "../core/stable-hash.js";
import {
  ActionRegistry,
  type FabricCallAudit,
  type FabricCapabilityViewLease,
} from "../core/action-registry.js";
import type {
  FabricInvocationContext,
  FabricScopedProviderResult,
} from "../protocol.js";
import { FabricEffectScope } from "./effect-scope.js";
import type {
  FabricCapabilityRequirement,
  FabricComponentContext,
  FabricComponentDefinition,
  FabricComponentEntry,
  FabricComponentGraph,
  FabricComponentInfo,
  FabricComponentProviderLease,
  FabricComponentState,
} from "./types.js";

interface ManagedComponent {
  entry: FabricComponentEntry;
  definition: FabricComponentDefinition;
  state: FabricComponentState;
  guarantee: "managed" | "revertible";
  requirements: FabricCapabilityRequirement[];
  provisions: string[];
  missing: string[];
  optionalMissing: string[];
  revision: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
  cleanupErrors?: string[];
  blockedKey?: string;
  scope: FabricEffectScope | undefined;
  viewLease: FabricCapabilityViewLease | undefined;
  providerLeases: FabricComponentProviderLease[];
  abortController: AbortController | undefined;
  tearingDown?: boolean;
}

export interface FabricComponentSupervisorOptions {
  invocationContext?(): FabricInvocationContext;
  invoke?(
    ref: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<unknown>;
  acquire?(
    ref: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<FabricScopedProviderResult>;
  maxResultChars?: number;
}

const COMPONENT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const PROVIDER_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const normalizeRequirements = (
  definition: FabricComponentDefinition,
): FabricCapabilityRequirement[] => {
  const normalized = new Map<string, boolean>();
  for (const requirement of definition.requires ?? []) {
    const ref = (typeof requirement === "string" ? requirement : requirement.ref).trim();
    if (!ref || ref.length > 256 || !ref.includes(".")) {
      throw new Error(
        `Fabric component ${definition.name} requirement must use provider.action: ${ref || "<empty>"}`,
      );
    }
    const optional = typeof requirement === "string" ? false : requirement.optional === true;
    normalized.set(ref, (normalized.get(ref) ?? true) && optional);
  }
  return [...normalized]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([ref, optional]) => ({ ref, ...(optional ? { optional: true } : {}) }));
};

const normalizeProvisions = (definition: FabricComponentDefinition): string[] => {
  const names = (definition.provides ?? []).map((provision) =>
    (typeof provision === "string" ? provision : provision.provider).trim(),
  );
  for (const name of names) {
    if (!PROVIDER_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid provider declaration on ${definition.name}: ${name}`);
    }
  }
  return [...new Set(names)].sort();
};

const defaultInvocationContext = (): FabricInvocationContext => ({
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "fabric-component",
  nestedToolCallId: "fabric-component",
  extensionContext: {} as ExtensionContext,
  update() {},
});

const targetKey = (
  revision: number,
  digest: string | undefined,
  missing: readonly string[],
): string => stableJsonHash({ revision, digest, missing });

export class FabricComponentSupervisor {
  readonly #components = new Map<string, ManagedComponent>();
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribeRegistry: () => void;
  #requested = false;
  #reconciling: Promise<void> | undefined;
  #closed = false;

  constructor(
    readonly registry: ActionRegistry,
    readonly options: FabricComponentSupervisorOptions = {},
  ) {
    this.#unsubscribeRegistry = registry.subscribeProviderChanges(() => this.refresh());
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  list(): FabricComponentInfo[] {
    return [...this.#components.values()]
      .map((component) => this.#info(component))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  status(id: string): FabricComponentInfo {
    return this.#info(this.#require(id));
  }

  graph(): FabricComponentGraph {
    const providers = new Map<string, string[]>();
    for (const component of this.#components.values()) {
      for (const provider of component.provisions) {
        const ids = providers.get(provider) ?? [];
        ids.push(component.entry.id);
        providers.set(provider, ids);
      }
    }
    const edges: FabricComponentGraph["edges"] = [];
    for (const component of this.#components.values()) {
      for (const requirement of component.requirements) {
        const provider = requirement.ref.slice(0, requirement.ref.indexOf("."));
        for (const source of providers.get(provider) ?? []) {
          edges.push({ from: component.entry.id, to: source, ref: requirement.ref });
        }
      }
    }
    edges.sort((left, right) =>
      left.from.localeCompare(right.from) ||
      left.to.localeCompare(right.to) ||
      left.ref.localeCompare(right.ref),
    );
    return { components: this.list(), edges, cycles: this.#cycles(edges) };
  }

  async start(
    entry: FabricComponentEntry,
    definition: FabricComponentDefinition,
  ): Promise<FabricComponentInfo> {
    this.#assertOpen();
    if (!COMPONENT_ID_PATTERN.test(entry.id)) {
      throw new Error(`Invalid Fabric component id: ${entry.id}`);
    }
    if (this.#components.has(entry.id)) {
      throw new Error(`Fabric component already exists: ${entry.id}`);
    }
    if (entry.component !== definition.name) {
      throw new Error(
        `Fabric component entry ${entry.id} selects ${entry.component}, not ${definition.name}`,
      );
    }
    const now = Date.now();
    const component: ManagedComponent = {
      entry: structuredClone(entry),
      definition,
      state: "waiting",
      guarantee: definition.guarantee ?? "managed",
      requirements: normalizeRequirements(definition),
      provisions: normalizeProvisions(definition),
      missing: [],
      optionalMissing: [],
      revision: 1,
      createdAt: now,
      updatedAt: now,
      scope: undefined,
      viewLease: undefined,
      providerLeases: [],
      abortController: undefined,
    };
    this.#components.set(entry.id, component);
    this.#emit();
    await this.#requestReconcile();
    if (component.state === "failed" || component.state === "quarantined") {
      throw new Error(component.error ?? `Fabric component ${entry.id} failed to start`);
    }
    return this.#info(component);
  }

  async replace(
    id: string,
    entry: FabricComponentEntry,
    definition: FabricComponentDefinition,
  ): Promise<FabricComponentInfo> {
    this.#assertOpen();
    const component = this.#require(id);
    if (entry.id !== id) throw new Error("Fabric component replacement cannot change its entry id");
    if (entry.component !== definition.name) {
      throw new Error(
        `Fabric component entry ${entry.id} selects ${entry.component}, not ${definition.name}`,
      );
    }
    const previous = {
      entry: structuredClone(component.entry),
      definition: component.definition,
      requirements: component.requirements,
      provisions: component.provisions,
      guarantee: component.guarantee,
      revision: component.revision,
    };

    await this.#unload(component, new Set());
    const unloadedState = component.state as FabricComponentState;
    if (unloadedState === "quarantined") {
      throw new Error(component.error ?? `Fabric component ${id} cleanup failed`);
    }
    this.#applyReplacement(component, entry, definition, previous.revision + 1);
    await this.#requestReconcile();
    const candidateState = component.state as FabricComponentState;
    if (candidateState !== "failed" && candidateState !== "quarantined") {
      return this.#info(component);
    }

    const replacementError = component.error ?? `Fabric component ${id} replacement failed`;
    if (candidateState === "quarantined") throw new Error(replacementError);
    await this.#unload(component, new Set());
    component.entry = previous.entry;
    component.definition = previous.definition;
    component.requirements = previous.requirements;
    component.provisions = previous.provisions;
    component.guarantee = previous.guarantee;
    component.revision = previous.revision + 2;
    component.state = "waiting";
    delete component.error;
    delete component.cleanupErrors;
    delete component.blockedKey;
    component.updatedAt = Date.now();
    await this.#requestReconcile();
    const rollbackState = component.state as FabricComponentState;
    if (rollbackState === "failed" || rollbackState === "quarantined") {
      throw new AggregateError(
        [new Error(replacementError), new Error(component.error ?? "rollback failed")],
        `Fabric component ${id} replacement and rollback failed`,
      );
    }
    throw new Error(`${replacementError}; previous revision restored`);
  }

  async stop(id: string): Promise<void> {
    const component = this.#require(id);
    await this.#unload(component, new Set());
    if (component.state === "quarantined") {
      throw new Error(component.error ?? `Fabric component ${id} cleanup failed`);
    }
    component.state = "disposed";
    component.updatedAt = Date.now();
    this.#emit();
    this.#components.delete(id);
    this.#emit();
    await this.#requestReconcile();
  }

  refresh(): void {
    if (this.#closed) return;
    void this.#requestReconcile().catch(() => undefined);
  }

  async settle(): Promise<void> {
    await this.#waitForReconcile();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribeRegistry();
    const visited = new Set<string>();
    for (const component of [...this.#components.values()].reverse()) {
      await this.#unload(component, visited);
      if (component.state !== "quarantined") component.state = "disposed";
      component.updatedAt = Date.now();
      this.#emit();
    }
    this.#components.clear();
    this.#emit();
    this.#listeners.clear();
  }

  #applyReplacement(
    component: ManagedComponent,
    entry: FabricComponentEntry,
    definition: FabricComponentDefinition,
    revision: number,
  ): void {
    component.entry = structuredClone(entry);
    component.definition = definition;
    component.requirements = normalizeRequirements(definition);
    component.provisions = normalizeProvisions(definition);
    component.guarantee = definition.guarantee ?? "managed";
    component.revision = revision;
    component.state = "waiting";
    component.missing = [];
    component.optionalMissing = [];
    delete component.error;
    delete component.cleanupErrors;
    delete component.blockedKey;
    component.updatedAt = Date.now();
  }

  #requestReconcile(): Promise<void> {
    this.#requested = true;
    this.#startReconcile();
    return this.#waitForReconcile();
  }

  #startReconcile(): void {
    if (this.#reconciling || this.#closed) return;
    const task = this.#drainReconcile();
    this.#reconciling = task;
    void task.finally(() => {
      if (this.#reconciling === task) this.#reconciling = undefined;
      if (this.#requested && !this.#closed) this.#startReconcile();
    }).catch(() => undefined);
  }

  async #waitForReconcile(): Promise<void> {
    for (;;) {
      this.#startReconcile();
      const task = this.#reconciling;
      if (!task) return;
      await task;
      if (!this.#requested && !this.#reconciling) return;
    }
  }

  async #drainReconcile(): Promise<void> {
    while (this.#requested && !this.#closed) {
      this.#requested = false;
      for (const component of this.#components.values()) {
        await this.#reconcile(component);
      }
    }
  }

  async #reconcile(component: ManagedComponent): Promise<void> {
    if (
      component.state === "loading" ||
      component.state === "unloading" ||
      component.state === "disposed" ||
      component.state === "quarantined"
    ) {
      return;
    }
    const baseContext = this.#invocationContext(component);
    const resolution = await this.registry.inspectCapabilities(
      component.requirements,
      baseContext,
    );
    component.missing = resolution.missing;
    component.optionalMissing = resolution.optionalMissing;
    const key = targetKey(component.revision, resolution.view?.digest, resolution.missing);

    if (component.state === "active") {
      if (resolution.satisfied && resolution.view?.digest === component.viewLease?.view?.digest) return;
      await this.#unload(component, new Set());
    }
    if (!resolution.satisfied) {
      component.state = "waiting";
      component.updatedAt = Date.now();
      component.blockedKey = key;
      this.#emit();
      return;
    }
    if (component.state === "failed" && component.blockedKey === key) return;
    await this.#load(component, baseContext, key);
  }

  async #load(
    component: ManagedComponent,
    baseContext: FabricInvocationContext,
    key: string,
  ): Promise<void> {
    component.state = "loading";
    component.updatedAt = Date.now();
    component.missing = [];
    delete component.error;
    delete component.cleanupErrors;
    this.#emit();

    const scope = new FabricEffectScope();
    const controller = new AbortController();
    const viewLease = await this.registry.acquireCapabilityView(
      component.requirements,
      { ...baseContext, signal: controller.signal },
    );
    if (!viewLease.satisfied || !viewLease.view) {
      await viewLease.release();
      component.state = "waiting";
      component.missing = viewLease.missing;
      component.optionalMissing = viewLease.optionalMissing;
      component.updatedAt = Date.now();
      this.#emit();
      return;
    }

    component.scope = scope;
    component.viewLease = viewLease;
    component.abortController = controller;
    component.providerLeases = [];
    const declared = new Set(component.provisions);
    const invocation: FabricInvocationContext = {
      ...baseContext,
      signal: controller.signal,
      capabilityView: viewLease.view,
      effectPolicy: component.guarantee === "revertible" ? "strict" : "advisory",
    };
    const context: FabricComponentContext = {
      id: component.entry.id,
      signal: controller.signal,
      invocation,
      view: viewLease.view,
      effect: (setup, label) => scope.effect(setup, label),
      defer: (disposer, label) => scope.defer(disposer, label),
      provide: (provider) => {
        if (component.guarantee === "revertible" && !provider.close) {
          throw new Error(
            `Revertible Fabric component ${component.entry.id} provider ${provider.name} must implement close()`,
          );
        }
        if (!declared.has(provider.name)) {
          throw new Error(
            `Fabric component ${component.entry.id} mounted undeclared provider ${provider.name}`,
          );
        }
        if (component.providerLeases.some((lease) => lease.name === provider.name)) {
          throw new Error(
            `Fabric component ${component.entry.id} mounted provider ${provider.name} more than once`,
          );
        }
        const lease = this.registry.mount(provider, { staged: true });
        component.providerLeases.push(lease);
        return lease;
      },
      acquire: async <T = unknown>(ref: string, args?: Record<string, unknown>) => {
        if (!viewLease.view?.bindings[ref]) {
          throw new Error(
            `Fabric component ${component.entry.id} acquired undeclared or unavailable capability ${ref}`,
          );
        }
        const acquired = this.options.acquire
          ? await this.options.acquire(ref, args ?? {}, invocation)
          : await this.registry.acquireScoped(ref, args ?? {}, invocation);
        try {
          scope.defer(acquired.dispose, `acquire:${ref}`);
        } catch (error) {
          await acquired.dispose();
          throw error;
        }
        return acquired.value as T;
      },
      call: async (ref, args) => {
        if (!viewLease.view?.bindings[ref]) {
          throw new Error(
            `Fabric component ${component.entry.id} called undeclared or unavailable capability ${ref}`,
          );
        }
        const callInvocation: FabricInvocationContext = {
          ...invocation,
          signal: component.tearingDown ? undefined : invocation.signal,
        };
        const action = await this.registry.describe(ref, callInvocation);
        if (action.effect?.kind === "scoped") {
          throw new Error(`Fabric scoped action ${ref} must be used through context.acquire()`);
        }
        if (
          component.guarantee === "revertible" &&
          action.effect?.kind !== "none" &&
          action.effect?.kind !== "transactional"
        ) {
          throw new Error(
            `Revertible Fabric component ${component.entry.id} cannot emit non-revertible action ${ref}`,
          );
        }
        const callArgs = args ?? {};
        if (this.options.invoke) return this.options.invoke(ref, callArgs, callInvocation);
        const audits: FabricCallAudit[] = [];
        return this.registry.invoke(ref, callArgs, {
          ...callInvocation,
          approve: async () => {},
          audits,
          maxResultChars: this.options.maxResultChars ?? 2_000_000,
        });
      },
    };

    try {
      await scope.effect(
        () => component.definition.activate(context, component.entry.config),
        "component:activate",
      );
      const unprovided = component.provisions.filter(
        (name) => !component.providerLeases.some((lease) => lease.name === name),
      );
      if (unprovided.length > 0) {
        throw new Error(
          `Fabric component ${component.entry.id} did not mount declared providers: ${unprovided.join(", ")}`,
        );
      }
      const verification = await this.registry.inspectCapabilities(
        component.requirements,
        invocation,
      );
      if (!verification.satisfied || verification.view?.digest !== viewLease.view.digest) {
        throw new Error(
          `Fabric component ${component.entry.id} capability target changed during activation`,
        );
      }
      this.registry.activateProviderBindings(
        component.providerLeases.map((lease) => lease.bindingId),
      );
      component.state = "active";
      component.optionalMissing = viewLease.optionalMissing;
      component.blockedKey = key;
      component.updatedAt = Date.now();
      this.#emit();
    } catch (error) {
      component.tearingDown = true;
      controller.abort(error);
      const report = await scope.dispose();
      const providerCleanup = await Promise.allSettled(
        component.providerLeases.map((lease) => lease.release()),
      );
      const [viewCleanup] = await Promise.allSettled([viewLease.release()]);
      component.scope = undefined;
      component.viewLease = undefined;
      component.abortController = undefined;
      component.providerLeases = [];
      component.tearingDown = false;
      component.error = errorMessage(error);
      component.blockedKey = key;
      component.updatedAt = Date.now();
      const cleanupErrors = [
        ...report.failures.map((failure) => `${failure.label}: ${failure.error}`),
        ...providerCleanup.flatMap((result) =>
          result.status === "rejected" ? [`provider: ${errorMessage(result.reason)}`] : [],
        ),
        ...(viewCleanup?.status === "rejected"
          ? [`capability-view: ${errorMessage(viewCleanup.reason)}`]
          : []),
      ];
      if (cleanupErrors.length > 0) {
        component.state = "quarantined";
        component.cleanupErrors = cleanupErrors;
      } else {
        component.state = "failed";
      }
      this.#emit();
    }
  }

  async #unload(component: ManagedComponent, visited: Set<string>): Promise<void> {
    if (visited.has(component.entry.id)) return;
    visited.add(component.entry.id);
    if (!component.scope && !component.viewLease && component.providerLeases.length === 0) {
      if (component.state !== "disposed" && component.state !== "quarantined") {
        component.state = "waiting";
      }
      return;
    }
    component.state = "unloading";
    component.tearingDown = true;
    component.updatedAt = Date.now();
    component.abortController?.abort(
      new Error(`Fabric component ${component.entry.id} is unloading`),
    );
    for (const lease of component.providerLeases) lease.retire();
    this.#emit();

    const bindingIds = new Set(component.providerLeases.map((lease) => lease.bindingId));
    for (const dependent of this.#components.values()) {
      if (dependent === component || !dependent.viewLease?.view) continue;
      const depends = Object.values(dependent.viewLease.view.bindings).some((binding) =>
        bindingIds.has(binding.providerBindingId),
      );
      if (depends) await this.#unload(dependent, visited);
    }

    const report = await component.scope?.dispose();
    const providerCleanup = await Promise.allSettled(
      component.providerLeases.map((lease) => lease.release()),
    );
    const viewCleanup = component.viewLease
      ? (await Promise.allSettled([component.viewLease.release()]))[0]
      : undefined;
    component.scope = undefined;
    component.viewLease = undefined;
    component.abortController = undefined;
    component.providerLeases = [];
    component.tearingDown = false;
    component.updatedAt = Date.now();
    const cleanupErrors = [
      ...(report?.failures ?? []).map(
        (failure) => `${failure.label}: ${failure.error}`,
      ),
      ...providerCleanup.flatMap((result) =>
        result.status === "rejected" ? [`provider: ${errorMessage(result.reason)}`] : [],
      ),
      ...(viewCleanup?.status === "rejected"
        ? [`capability-view: ${errorMessage(viewCleanup.reason)}`]
        : []),
    ];
    if (cleanupErrors.length > 0) {
      component.state = "quarantined";
      component.error = `Fabric component ${component.entry.id} cleanup failed`;
      component.cleanupErrors = cleanupErrors;
    } else {
      component.state = "waiting";
      delete component.cleanupErrors;
    }
    this.#emit();
  }

  #invocationContext(component: ManagedComponent): FabricInvocationContext {
    const base = this.options.invocationContext?.() ?? defaultInvocationContext();
    return {
      ...base,
      parentToolCallId: `component:${component.entry.id}:${component.revision}`,
      nestedToolCallId: `component:${component.entry.id}:${component.revision}`,
    };
  }

  #info(component: ManagedComponent): FabricComponentInfo {
    return {
      id: component.entry.id,
      component: component.definition.name,
      state: component.state,
      guarantee: component.guarantee,
      revision: component.revision,
      requirements: component.requirements.map((requirement) => requirement.ref),
      provisions: [...component.provisions],
      missing: [...component.missing],
      optionalMissing: [...component.optionalMissing],
      ...(component.viewLease?.view?.digest
        ? { targetDigest: component.viewLease.view.digest }
        : {}),
      ...(component.error ? { error: component.error } : {}),
      ...(component.cleanupErrors
        ? { cleanupErrors: [...component.cleanupErrors] }
        : {}),
      createdAt: component.createdAt,
      updatedAt: component.updatedAt,
    };
  }

  #cycles(edges: FabricComponentGraph["edges"]): string[][] {
    const adjacent = new Map<string, string[]>();
    for (const edge of edges) {
      const targets = adjacent.get(edge.from) ?? [];
      targets.push(edge.to);
      adjacent.set(edge.from, targets);
    }
    const cycles = new Map<string, string[]>();
    const visit = (node: string, path: string[], positions: Map<string, number>): void => {
      const position = positions.get(node);
      if (position !== undefined) {
        const cycle = path.slice(position);
        const rotations = cycle.map((_, index) => [
          ...cycle.slice(index),
          ...cycle.slice(0, index),
        ]);
        rotations.sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
        const canonical = rotations[0]!;
        cycles.set(canonical.join("\0"), canonical);
        return;
      }
      if (path.length > this.#components.size) return;
      const nextPositions = new Map(positions).set(node, path.length);
      for (const target of adjacent.get(node) ?? []) {
        visit(target, [...path, node], nextPositions);
      }
    };
    for (const id of this.#components.keys()) visit(id, [], new Map());
    return [...cycles.values()].sort((left, right) =>
      left.join("\0").localeCompare(right.join("\0")),
    );
  }

  #require(id: string): ManagedComponent {
    const component = this.#components.get(id);
    if (!component) throw new Error(`Unknown Fabric component: ${id}`);
    return component;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Fabric component supervisor is closed");
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // Lifecycle observers cannot affect component ownership.
      }
    }
  }
}

