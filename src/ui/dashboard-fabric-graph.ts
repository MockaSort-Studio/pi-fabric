import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { FabricActivityRun } from "../activity/types.js";
import type { Entity, StatusFilter } from "./dashboard-model.js";
import { colorStatus, entityTail, statusGlyph } from "./dashboard-presentation.js";
import { padToWidth, safeText } from "./format.js";
import type { FabricProjectMeshModel } from "./topology.js";
import type { FabricDashboardSnapshot } from "./types.js";
import { isActiveStatus } from "./types.js";

export interface FabricGraphPoint {
  x: number;
  y: number;
}

type GraphNodeKind =
  | "main"
  | "peer"
  | "agent"
  | "actor"
  | "participant"
  | "topic"
  | "state"
  | "route";

interface GraphNode {
  id: string;
  label: string;
  status: string;
  kind: GraphNodeKind;
  parentId?: string;
  x: number;
  y: number;
}

interface GraphEdge {
  from: string;
  to: string;
  kind: "structure" | "route" | "subscription";
}

interface FabricGraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  positions: Map<string, FabricGraphPoint>;
}

interface Cell {
  char: string;
  style: "plain" | "edge" | "dim" | "accent" | "success" | "warning" | "error";
}

const kindRank: Record<GraphNodeKind, number> = {
  agent: 0,
  actor: 1,
  participant: 2,
  peer: 3,
  topic: 4,
  state: 5,
  route: 6,
  main: 7,
};

const activeRank = (status: string): number =>
  isActiveStatus(status) && status !== "blocked" ? 0 : status === "blocked" ? 1 : 2;

const nodeKind = (entity: Entity): GraphNodeKind => {
  if (entity.kind === "meshParticipant") return "participant";
  if (entity.kind === "meshTopic") return "topic";
  if (entity.kind === "meshRoute") return "route";
  if (entity.kind === "globalActor" || entity.kind === "call" || entity.kind === "item") {
    return "state";
  }
  return entity.kind;
};

const rawIdentity = (entity: Entity): Array<string | undefined> => {
  if (entity.kind === "main" || entity.kind === "peer" || entity.kind === "agent" || entity.kind === "actor") {
    return [entity.value.id, entity.value.name];
  }
  if (entity.kind === "meshParticipant") {
    return [entity.value.id, entity.value.name, entity.value.participant?.sessionId];
  }
  if (entity.kind === "meshTopic") return [entity.value.id, entity.value.name];
  if (entity.kind === "state") return [entity.value.key, entity.value.label];
  if (entity.kind === "meshRoute") return [entity.value.id];
  return [entity.id, entity.label];
};

const graphLabel = (value: string, maxWidth: number): string => {
  let output = "";
  let width = 0;
  for (const char of value) {
    const charWidth = visibleWidth(char);
    if (width + charWidth > maxWidth) {
      while (width + 1 > maxWidth && output.length > 0) {
        const parts = [...output];
        const removed = parts.pop();
        output = parts.join("");
        width -= removed ? visibleWidth(removed) : 0;
      }
      return output + "…";
    }
    output += char;
    width += charWidth;
  }
  return output;
};

const graphGlyph = (kind: GraphNodeKind): string => {
  if (kind === "main") return "◆";
  if (kind === "actor") return "◇";
  if (kind === "peer") return "◈";
  if (kind === "topic") return "◎";
  if (kind === "state") return "◫";
  if (kind === "route") return "↝";
  if (kind === "participant") return "▧";
  return "■";
};

const parentReference = (entity: Entity): string | undefined => {
  if (entity.kind === "agent") return entity.value.parentId ?? entity.value.actorId;
  if (entity.kind === "meshParticipant") return entity.value.participant?.parentId;
  if (entity.kind === "state") return entity.value.owner;
  if (entity.kind === "meshRoute") return entity.value.fromId;
  return undefined;
};

const buildLayout = (
  snapshot: FabricDashboardSnapshot,
  entities: Entity[],
  selectedRun: FabricActivityRun | undefined,
  mesh: FabricProjectMeshModel,
): FabricGraphLayout => {
  const aliases = new Map<string, string>();
  const entityById = new Map(entities.map((entity) => [entity.id, entity] as const));
  for (const entity of entities) {
    for (const identity of rawIdentity(entity)) {
      if (identity) aliases.set(identity, entity.id);
    }
  }
  const mainId = entities.find((entity) => entity.kind === "main")?.id ?? `main:${snapshot.main.id}`;
  aliases.set(snapshot.main.id, mainId);
  aliases.set(snapshot.main.name, mainId);
  aliases.set("main", mainId);

  const nodes: GraphNode[] = entities.map((entity) => {
    const parentRef = parentReference(entity);
    const parentId = parentRef ? aliases.get(parentRef) : undefined;
    return {
      id: entity.id,
      label: entity.kind === "main" ? "Main" : entity.label,
      status: entity.status,
      kind: nodeKind(entity),
      ...(entity.kind !== "main" ? { parentId: parentId ?? mainId } : {}),
      x: 0,
      y: 0,
    };
  });

  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const children = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (!node.parentId || node.parentId === node.id || !nodeById.has(node.parentId)) continue;
    const bucket = children.get(node.parentId) ?? [];
    bucket.push(node);
    children.set(node.parentId, bucket);
  }
  const inSelectedRun = (node: GraphNode): boolean => {
    const entity = entityById.get(node.id);
    return Boolean(selectedRun && entity?.kind === "agent" && entity.value.runId === selectedRun.id);
  };
  for (const bucket of children.values()) {
    bucket.sort(
      (left, right) =>
        activeRank(left.status) - activeRank(right.status) ||
        Number(inSelectedRun(right)) - Number(inSelectedRun(left)) ||
        kindRank[left.kind] - kindRank[right.kind] ||
        left.label.localeCompare(right.label),
    );
  }

  let nextLeafY = 0;
  const visited = new Set<string>();
  const place = (node: GraphNode, depth: number): number => {
    if (visited.has(node.id)) return node.y;
    visited.add(node.id);
    node.x = depth * 20;
    const descendants = (children.get(node.id) ?? []).filter((child) => !visited.has(child.id));
    if (descendants.length === 0) {
      node.y = nextLeafY;
      nextLeafY += 3;
      return node.y;
    }
    const childRows = descendants.map((child) => place(child, depth + 1));
    node.y = (childRows[0]! + childRows[childRows.length - 1]!) / 2;
    return node.y;
  };
  const main = nodeById.get(mainId);
  if (main) place(main, 0);
  for (const node of nodes) {
    if (!visited.has(node.id)) place(node, 1);
  }
  const mainY = main?.y ?? 0;
  for (const node of nodes) node.y = Math.round(node.y - mainY);

  const edges: GraphEdge[] = [];
  for (const node of nodes) {
    if (node.parentId && nodeById.has(node.parentId) && node.parentId !== node.id) {
      edges.push({ from: node.parentId, to: node.id, kind: node.kind === "route" ? "route" : "structure" });
    }
  }
  for (const topic of mesh.topics) {
    const target = aliases.get(topic.id) ?? aliases.get(topic.name);
    if (!target) continue;
    for (const subscriber of topic.subscribers) {
      const source = aliases.get(subscriber.id) ?? aliases.get(subscriber.name);
      if (source && source !== target) edges.push({ from: source, to: target, kind: "subscription" });
    }
  }
  for (const route of mesh.routes) {
    const source = aliases.get(route.fromId) ?? aliases.get(route.fromName);
    const target = aliases.get(route.targetId) ?? aliases.get(route.targetName) ?? aliases.get(route.topic);
    if (source && target && source !== target) edges.push({ from: source, to: target, kind: "route" });
  }
  return {
    nodes,
    edges,
    positions: new Map(nodes.map((node) => [node.id, { x: node.x, y: node.y }] as const)),
  };
};

const lineChar = (mask: number): string => {
  const chars: Record<number, string> = {
    1: "│", 2: "─", 3: "└", 4: "│", 5: "│", 6: "┌", 7: "├",
    8: "─", 9: "┘", 10: "─", 11: "┴", 12: "┐", 13: "┤", 14: "┬", 15: "┼",
  };
  return chars[mask] ?? "·";
};

const styleForStatus = (status: string): Cell["style"] => {
  if (["failed", "timed_out", "error"].includes(status)) return "error";
  if (status === "blocked") return "warning";
  if (isActiveStatus(status)) return "success";
  return "dim";
};

const renderCanvas = (
  theme: Theme,
  layout: FabricGraphLayout,
  selectedEntityId: string | undefined,
  width: number,
  height: number,
  camera: FabricGraphPoint,
): string[] => {
  const originX = Math.round(camera.x - width / 2);
  const originY = Math.round(camera.y - height / 2);
  const cells: Cell[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({ char: " ", style: "plain" as const })),
  );
  const masks: number[][] = Array.from({ length: height }, () => Array<number>(width).fill(0));
  const nodeById = new Map(layout.nodes.map((node) => [node.id, node] as const));
  const setCell = (x: number, y: number, char: string, style: Cell["style"]): void => {
    const sx = x - originX;
    const sy = y - originY;
    if (sx < 0 || sx >= width || sy < 0 || sy >= height) return;
    cells[sy]![sx] = { char, style };
  };
  const addMask = (x: number, y: number, mask: number): void => {
    const sx = x - originX;
    const sy = y - originY;
    if (sx < 0 || sx >= width || sy < 0 || sy >= height) return;
    masks[sy]![sx] = (masks[sy]![sx] ?? 0) | mask;
  };
  const horizontal = (x1: number, x2: number, y: number): void => {
    if (y < originY || y >= originY + height) return;
    const worldStart = Math.min(x1, x2);
    const worldEnd = Math.max(x1, x2);
    const start = Math.max(worldStart, originX);
    const end = Math.min(worldEnd, originX + width - 1);
    for (let x = start; x <= end; x++) {
      addMask(x, y, (x > worldStart ? 8 : 0) | (x < worldEnd ? 2 : 0));
    }
  };
  const vertical = (x: number, y1: number, y2: number): void => {
    if (x < originX || x >= originX + width) return;
    const worldStart = Math.min(y1, y2);
    const worldEnd = Math.max(y1, y2);
    const start = Math.max(worldStart, originY);
    const end = Math.min(worldEnd, originY + height - 1);
    for (let y = start; y <= end; y++) {
      addMask(x, y, (y > worldStart ? 1 : 0) | (y < worldEnd ? 4 : 0));
    }
  };
  const meshPaths: Array<{ from: GraphNode; to: GraphNode }> = [];

  for (const edge of layout.edges) {
    if (edge.kind !== "structure" && edge.from !== selectedEntityId && edge.to !== selectedEntityId) continue;
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to) continue;
    if (edge.kind !== "structure") {
      meshPaths.push({ from, to });
      continue;
    }
    const fromEnd = from.x + Math.min(16, visibleWidth(safeText(from.label)) + 3);
    const toStart = to.x - 2;
    const bend = Math.max(fromEnd + 1, Math.floor((fromEnd + toStart) / 2));
    horizontal(fromEnd, bend, from.y);
    vertical(bend, from.y, to.y);
    horizontal(bend, toStart, to.y);
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const mask = masks[y]?.[x] ?? 0;
      if (mask) cells[y]![x] = { char: lineChar(mask), style: "edge" };
    }
  }

  for (const { from, to } of meshPaths) {
    const fromEnd = from.x + Math.min(16, visibleWidth(safeText(from.label)) + 3);
    const toStart = to.x - 2;
    const bend = Math.max(fromEnd + 1, Math.floor((fromEnd + toStart) / 2));
    const drawDots = (x1: number, y1: number, x2: number, y2: number): void => {
      if (y1 === y2) {
        if (y1 < originY || y1 >= originY + height) return;
        const worldStart = Math.min(x1, x2);
        const start = Math.max(worldStart, originX);
        const end = Math.min(Math.max(x1, x2), originX + width - 1);
        const alignedStart = start + ((start - worldStart) % 2);
        for (let x = alignedStart; x <= end; x += 2) setCell(x, y1, "·", "accent");
        return;
      }
      if (x1 < originX || x1 >= originX + width) return;
      const worldStart = Math.min(y1, y2);
      const start = Math.max(worldStart, originY);
      const end = Math.min(Math.max(y1, y2), originY + height - 1);
      const alignedStart = start + ((start - worldStart) % 2);
      for (let y = alignedStart; y <= end; y += 2) setCell(x1, y, "·", "accent");
    };
    drawDots(fromEnd, from.y, bend, from.y);
    drawDots(bend, from.y, bend, to.y);
    drawDots(bend, to.y, toStart, to.y);
  }

  for (const node of layout.nodes) {
    const selected = node.id === selectedEntityId;
    const glyph = selected ? "▣" : graphGlyph(node.kind);
    const label = graphLabel(safeText(node.label), 14);
    setCell(node.x, node.y, glyph, selected ? "accent" : styleForStatus(node.status));
    setCell(node.x + 1, node.y, " ", "plain");
    let offset = 0;
    for (const char of label) {
      setCell(node.x + 2 + offset, node.y, char, selected ? "accent" : "plain");
      offset += visibleWidth(char);
    }
  }

  const apply = (style: Cell["style"], value: string): string => {
    if (style === "edge") return theme.fg("borderMuted", value);
    if (style === "dim") return theme.fg("dim", value);
    if (style === "accent") return theme.fg("accent", theme.bold(value));
    if (style === "success") return theme.fg("success", value);
    if (style === "warning") return theme.fg("warning", value);
    if (style === "error") return theme.fg("error", value);
    return value;
  };
  return cells.map((row) => {
    let rendered = "";
    let style = row[0]?.style ?? "plain";
    let run = "";
    for (const cell of row) {
      if (cell.style !== style) {
        rendered += apply(style, run);
        style = cell.style;
        run = "";
      }
      run += cell.char;
    }
    rendered += apply(style, run);
    return truncateToWidth(rendered, width, "");
  });
};

const wrapInspector = (theme: Theme, label: string, value: string, width: number): string[] => {
  const clean = safeText(value);
  const first = truncateToWidth(clean, Math.max(1, width - label.length - 1), "…");
  return [`${label} ${theme.fg("dim", first)}`];
};

const inspectorLines = (
  theme: Theme,
  entity: Entity | undefined,
  snapshot: FabricDashboardSnapshot,
  run: FabricActivityRun | undefined,
  width: number,
  height: number,
): string[] => {
  const inner = Math.max(1, width - 2);
  const border = (value: string): string => theme.fg("borderMuted", value);
  const content: string[] = [];
  if (entity) {
    content.push(theme.fg("accent", theme.bold(truncateToWidth(safeText(entity.label), inner - 2, "…"))));
    content.push(colorStatus(theme, entity.status, `${statusGlyph(entity.status)} ${entity.kind} · ${entity.status}`));
    content.push("");
    content.push(theme.fg("dim", truncateToWidth(safeText(entityTail(entity, snapshot.now)), inner - 2, "…")));
    if (entity.kind === "agent") {
      const agentRun = snapshot.runs.find((candidate) => candidate.id === entity.value.runId) ?? run;
      const phase = agentRun?.phases.find((candidate) => candidate.id === entity.value.phaseId);
      if (agentRun) content.push(`run   ${safeText(agentRun.name)}`);
      if (phase) content.push(`phase ${safeText(phase.name)}`);
      if (entity.value.currentTool) content.push(`tool  ${safeText(entity.value.currentTool)}`);
      if (entity.value.model) content.push(`model ${safeText(entity.value.model)}`);
      if (entity.value.task) content.push(...wrapInspector(theme, "task", entity.value.task, inner - 2));
    } else if (entity.kind === "actor") {
      content.push(`runner ${entity.value.runner}`);
      content.push(`queue  ${entity.value.queued}`);
      if (entity.value.topics.length > 0) content.push(`${entity.value.topics.length} subscriptions`);
    } else if (entity.kind === "meshTopic") {
      content.push(`${entity.value.subscribers.length} subscribers`);
      content.push(`${entity.value.recentEvents} recent events`);
    } else if (entity.kind === "meshRoute") {
      content.push(`${safeText(entity.value.fromName)} → ${safeText(entity.value.targetName)}`);
      content.push(theme.fg("dim", safeText(entity.value.topic)));
    } else if (entity.kind === "state") {
      content.push(`version ${entity.value.version}`);
      if (entity.value.owner) content.push(`owner   ${safeText(entity.value.owner)}`);
    }
  } else {
    content.push(theme.fg("dim", "No node selected"));
  }
  const title = " selected ";
  const rows = [border(`╭${title}${"─".repeat(Math.max(0, inner - visibleWidth(title)))}╮`)];
  for (let index = 0; index < height - 2; index++) {
    rows.push(`${border("│")}${padToWidth(` ${content[index] ?? ""}`, inner)}${border("│")}`);
  }
  rows.push(border(`╰${"─".repeat(inner)}╯`));
  return rows.slice(0, height);
};

const graphContextEntities = (allEntities: Entity[], entities: Entity[]): Entity[] => {
  const byRawId = new Map<string, Entity>();
  for (const entity of allEntities) {
    for (const identity of rawIdentity(entity)) {
      if (identity) byRawId.set(identity, entity);
    }
  }
  const visible = new Map(entities.map((entity) => [entity.id, entity] as const));
  for (const entity of entities) {
    let parentRef = parentReference(entity);
    const visited = new Set<string>();
    while (parentRef && !visited.has(parentRef)) {
      visited.add(parentRef);
      const parent = byRawId.get(parentRef);
      if (!parent) break;
      visible.set(parent.id, parent);
      parentRef = parentReference(parent);
    }
  }
  return allEntities.filter((entity) => visible.has(entity.id));
};

export interface FabricTopologyRenderResult {
  lines: string[];
  positions: Map<string, FabricGraphPoint>;
  selectedPosition?: FabricGraphPoint;
}

export const renderFabricTopologyPanel = ({
  theme,
  filter,
  selectedEntityId,
  snapshot,
  run,
  mesh,
  allEntities,
  entities,
  width,
  height,
  camera,
}: {
  theme: Theme;
  filter: StatusFilter;
  selectedEntityId: string | undefined;
  snapshot: FabricDashboardSnapshot;
  run: FabricActivityRun | undefined;
  mesh: FabricProjectMeshModel;
  allEntities: Entity[];
  entities: Entity[];
  width: number;
  height: number;
  camera: FabricGraphPoint;
}): FabricTopologyRenderResult => {
  const graphEntities = graphContextEntities(allEntities, entities);
  const layout = buildLayout(snapshot, graphEntities, run, mesh);
  const selectableIds = new Set(entities.map((entity) => entity.id));
  const selected = entities.find((entity) => entity.id === selectedEntityId) ?? entities[0];
  const inspectorWidth = width >= 92 ? Math.min(36, Math.max(30, Math.floor(width * 0.3))) : 0;
  const graphWidth = Math.max(1, width - inspectorWidth);
  const graph = renderCanvas(theme, layout, selected?.id, graphWidth, height, camera);
  const inspector = inspectorWidth > 0
    ? inspectorLines(theme, selected, snapshot, run, inspectorWidth, height)
    : [];
  const lines = inspectorWidth > 0
    ? graph.map((line, index) =>
        `${padToWidth(line, graphWidth)}${inspector[index] ?? ""}`,
      )
    : graph;
  const active = entities.filter((entity) => isActiveStatus(entity.status)).length;
  const originX = Math.round(camera.x - graphWidth / 2);
  const originY = Math.round(camera.y - height / 2);
  const hiddenLeft = layout.nodes.filter((node) => node.x < originX).length;
  const hiddenRight = layout.nodes.filter((node) => node.x + 2 > originX + graphWidth).length;
  const hiddenUp = layout.nodes.filter((node) => node.y < originY).length;
  const hiddenDown = layout.nodes.filter((node) => node.y >= originY + height).length;
  const offCanvas = new Set(
    layout.nodes
      .filter(
        (node) =>
          node.x < originX || node.x + 2 > originX + graphWidth ||
          node.y < originY || node.y >= originY + height,
      )
      .map((node) => node.id),
  ).size;
  const directions = [
    hiddenLeft > 0 ? "←" : "",
    hiddenRight > 0 ? "→" : "",
    hiddenUp > 0 ? "↑" : "",
    hiddenDown > 0 ? "↓" : "",
  ].join("");
  if (lines.length > 0 && height > 1) {
    const legend = [
      offCanvas > 0 ? `${directions} ${offCanvas} off-canvas` : undefined,
      `${active} active`,
      "◆ Main",
      "■ agent",
      "◇ actor",
      "◎ topic",
      filter !== "all" ? `${entities.length}/${allEntities.length} ${filter}` : undefined,
    ].filter((value): value is string => Boolean(value)).join(" · ");
    const graphLegend = padToWidth(theme.fg("dim", truncateToWidth(legend, graphWidth, "")), graphWidth);
    lines[0] = truncateToWidth(
      graphLegend + (inspectorWidth > 0 ? inspector[0] ?? "" : ""),
      width,
      "",
    );
  }
  const selectedPosition = selected ? layout.positions.get(selected.id) : undefined;
  return {
    lines,
    positions: new Map(
      [...layout.positions].filter(([id]) => selectableIds.has(id)),
    ),
    ...(selectedPosition ? { selectedPosition } : {}),
  };
};

export const directionalGraphTarget = (
  positions: ReadonlyMap<string, FabricGraphPoint>,
  currentId: string | undefined,
  direction: "left" | "right" | "up" | "down",
): string | undefined => {
  const current = currentId ? positions.get(currentId) : undefined;
  if (!current) return positions.keys().next().value;
  let best: { id: string; score: number } | undefined;
  for (const [id, point] of positions) {
    if (id === currentId) continue;
    const dx = point.x - current.x;
    const dy = point.y - current.y;
    const primary = direction === "left" ? -dx : direction === "right" ? dx : direction === "up" ? -dy : dy;
    if (primary <= 0) continue;
    const secondary = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
    const score = primary + secondary * 2.4;
    if (!best || score < best.score) best = { id, score };
  }
  return best?.id;
};
