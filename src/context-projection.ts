type UnknownRecord = Record<string, unknown>;

interface ContextMessageLike {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
}

interface ToolCallLike extends UnknownRecord {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
}

const MAX_OPERATION_SUMMARY_CHARS = 180;
const MAX_CALL_SUMMARY_CHARS = 1_600;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const compactText = (value: string, maxChars: number): string => {
  const singleLine = value.replaceAll(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxChars - 1))}…`;
};

const projectedArgSummary = (args: unknown): string | undefined => {
  if (!isRecord(args)) return undefined;
  const parts: string[] = [];
  for (const key of [
    "path",
    "pattern",
    "query",
    "ref",
    "provider",
    "action",
    "offset",
    "limit",
    "command",
  ]) {
    const value = args[key];
    if (typeof value === "string") {
      parts.push(`${key}=${JSON.stringify(compactText(value, key === "command" ? 100 : 80))}`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${String(value)}`);
    }
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
};

const operationSummary = (operation: unknown): string | undefined => {
  if (!isRecord(operation)) return undefined;
  const ref = typeof operation.ref === "string" ? operation.ref : undefined;
  if (!ref) return undefined;
  const args = projectedArgSummary(operation.args);
  const outcome = typeof operation.outcome === "string" && operation.outcome !== "succeeded"
    ? ` → ${operation.outcome}`
    : "";
  return compactText(`${ref}${args ? `(${args})` : ""}${outcome}`, MAX_OPERATION_SUMMARY_CHARS);
};

const completedCallSummary = (details: unknown): string => {
  const trace = isRecord(details) && isRecord(details.trace) ? details.trace : undefined;
  const operations = trace && Array.isArray(trace.operations)
    ? trace.operations.map(operationSummary).filter((item): item is string => Boolean(item))
    : [];
  if (operations.length === 0) return "completed fabric_exec call; arguments omitted";
  const omitted = operations.length > 12 ? `; +${operations.length - 12} more` : "";
  return compactText(
    `completed fabric_exec: ${operations.slice(0, 12).join("; ")}${omitted}`,
    MAX_CALL_SUMMARY_CHARS,
  );
};

const projectedArguments = (argumentsValue: unknown, details: unknown): UnknownRecord => {
  const original = isRecord(argumentsValue) ? argumentsValue : {};
  const display = isRecord(original.display)
    ? {
      ...(typeof original.display.name === "string" ? { name: original.display.name } : {}),
      ...(typeof original.display.description === "string"
        ? { description: original.display.description }
        : {}),
    }
    : undefined;
  return {
    code: `/* ${completedCallSummary(details)} */`,
    ...(display && Object.keys(display).length > 0 ? { display } : {}),
  };
};

const toolCallId = (part: ToolCallLike): string | undefined =>
  part.type === "toolCall" && part.name === "fabric_exec" && typeof part.id === "string"
    ? part.id
    : undefined;

export const projectCompletedFabricCallArguments = <T extends ContextMessageLike>(
  messages: readonly T[],
  retainRecent = 0,
): T[] | undefined => {
  const completed: Array<{ id: string; details: unknown }> = [];
  for (const message of messages) {
    if (
      message.role === "toolResult" &&
      message.toolName === "fabric_exec" &&
      typeof message.toolCallId === "string" &&
      message.isError !== true
    ) {
      completed.push({ id: message.toolCallId, details: message.details });
    }
  }
  const projectCount = Math.max(0, completed.length - Math.max(0, retainRecent));
  if (projectCount === 0) return undefined;
  const detailsById = new Map(completed.slice(0, projectCount).map((item) => [item.id, item.details]));

  let changed = false;
  const projected = messages.map((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
    let contentChanged = false;
    const content = message.content.map((part: unknown) => {
      if (!isRecord(part)) return part;
      const id = toolCallId(part);
      if (!id || !detailsById.has(id)) return part;
      const nextArguments = projectedArguments(part.arguments, detailsById.get(id));
      if (JSON.stringify(nextArguments).length >= JSON.stringify(part.arguments).length) return part;
      contentChanged = true;
      return { ...part, arguments: nextArguments };
    });
    if (!contentChanged) return message;
    changed = true;
    return { ...message, content } as T;
  });
  return changed ? projected : undefined;
};
