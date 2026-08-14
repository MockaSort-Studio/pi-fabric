import type {
  FabricCommittedCapabilityView,
  FabricInvocationContext,
  FabricProvider,
} from "../protocol.js";

export type FabricComponentGuarantee = "managed" | "revertible";

export interface FabricCapabilityRequirement {
  ref: string;
  optional?: boolean;
}

export interface FabricComponentProvision {
  provider: string;
}

export type FabricComponentDisposer = () => void | Promise<void>;

type FabricComponentEffectValue =
  | void
  | FabricComponentDisposer
  | Iterable<FabricComponentDisposer, void, void>
  | AsyncIterable<FabricComponentDisposer, void, void>;

export type FabricComponentEffect =
  | FabricComponentEffectValue
  | Promise<FabricComponentEffectValue>;

export interface FabricComponentDefinition<TConfig = unknown> {
  name: string;
  description?: string;
  requires?: readonly (string | FabricCapabilityRequirement)[];
  provides?: readonly (string | FabricComponentProvision)[];
  guarantee?: FabricComponentGuarantee;
  activate(
    context: FabricComponentContext,
    config: TConfig,
  ): FabricComponentEffect;
}

export interface FabricComponentProviderLease {
  readonly bindingId: string;
  readonly name: string;
  readonly generation: number;
  readonly active: boolean;
  retire(): void;
  release(): Promise<void>;
}

export interface FabricComponentContext {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly view: FabricCommittedCapabilityView;
  readonly invocation: FabricInvocationContext;
  effect(
    setup: () => FabricComponentEffect,
    label?: string,
  ): Promise<FabricComponentDisposer>;
  defer(disposer: FabricComponentDisposer, label?: string): FabricComponentDisposer;
  provide(provider: FabricProvider): FabricComponentProviderLease;
  acquire<T = unknown>(ref: string, args?: Record<string, unknown>): Promise<T>;
  call(ref: string, args?: Record<string, unknown>): Promise<unknown>;
}

export type FabricComponentState =
  | "waiting"
  | "loading"
  | "active"
  | "unloading"
  | "failed"
  | "quarantined"
  | "disposed";

export interface FabricComponentEntry {
  id: string;
  component: string;
  config?: unknown;
  disabled?: boolean;
}

export interface FabricComponentInfo {
  id: string;
  component: string;
  state: FabricComponentState;
  guarantee: FabricComponentGuarantee;
  requirements: string[];
  provisions: string[];
  missing: string[];
  optionalMissing: string[];
  targetDigest?: string;
  error?: string;
  cleanupErrors?: string[];
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface FabricComponentGraph {
  components: FabricComponentInfo[];
  edges: Array<{
    from: string;
    to: string;
    ref: string;
  }>;
  cycles: string[][];
}

export interface FabricComponentRegistration {
  version: 1;
  component: FabricComponentDefinition;
  overwrite?: boolean;
}

export interface FabricComponentDiscovery {
  version: 1;
  register(
    component: FabricComponentDefinition,
    options?: { overwrite?: boolean },
  ): void;
}
