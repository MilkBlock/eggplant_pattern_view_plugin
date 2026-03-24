import { ActionEffect, TextSpan } from "./ir";

export type ActionRecoveryMode = "static" | "sample" | "hybrid";

export interface ActionRecoveryPreviewMetadata {
  summary: string;
  diagnostics: ActionSampleDiagnostic[];
  graphOverride: ActionSampleGraphOverride;
}

export interface ActionSampleGraphOverride {
  effectLabels: Record<string, string>;
  visibleEffectIds: string[] | null;
}

export interface ActionSampleDiagnostic {
  severity: "info" | "warning";
  message: string;
  source_range: TextSpan | null;
}

interface RuntimeActionSampleTrace {
  version: number;
  events: RuntimeActionSampleEvent[];
}

type RuntimeActionSampleEvent =
  | { kind: "insert"; id: string; effect_id: string | null; table: string | null; key_debug: string[]; rendered_label: string | null }
  | { kind: "union"; id: string; effect_id: string | null; lhs_debug: string | null; rhs_debug: string | null; rendered_label: string | null }
  | { kind: "subsume"; id: string; effect_id: string | null }
  | { kind: "remove"; id: string; effect_id: string | null }
  | { kind: "dynamic-unknown"; id: string; effect_id: string | null; reason: string };

function stableEffectId(effect: ActionEffect): string {
  return `effect@${effect.range.start}:${effect.range.end}`;
}

function indexActionEffectsByStableId(actionEffects: ActionEffect[]): Map<string, ActionEffect> {
  return new Map(actionEffects.map((effect) => [stableEffectId(effect), effect]));
}

export function summarizeRuntimeActionSampleTrace(
  payload: unknown,
  actionEffects: ActionEffect[],
  mode: ActionRecoveryMode
): ActionRecoveryPreviewMetadata | null {
  const trace = parseRuntimeActionSampleTrace(payload);
  if (!trace) {
    return null;
  }

  const effectsByStableId = indexActionEffectsByStableId(actionEffects);
  let matchedCount = 0;
  let unresolvedCount = 0;
  let dynamicUnknownCount = 0;
  const diagnostics: ActionSampleDiagnostic[] = [];
  const effectLabels: Record<string, string> = {};
  const visibleEffectIds = new Set<string>();

  for (const event of trace.events) {
    const effect = event.effect_id === null ? null : effectsByStableId.get(event.effect_id) ?? null;
    if (effect) {
      matchedCount += 1;
      visibleEffectIds.add(effect.id);
    } else {
      unresolvedCount += 1;
    }

    if (event.kind === "dynamic-unknown") {
      dynamicUnknownCount += 1;
      diagnostics.push({
        severity: "warning",
        message: effect
          ? `dynamic-unknown at ${event.id}: ${event.reason} (${event.effect_id})`
          : `dynamic-unknown at ${event.id}: ${event.reason}`,
        source_range: effect?.range ?? null
      });
      continue;
    }

    if (effect) {
      const label = runtimeEventLabel(event);
      if (label) {
        effectLabels[effect.id] = label;
      }
    }

    if (!effect && event.effect_id !== null) {
      diagnostics.push({
        severity: "info",
        message: `sample event ${event.id} (${event.kind}) did not match any extracted action effect (${event.effect_id})`,
        source_range: null
      });
    }
  }

  const summaryParts = [
    `recovery=${mode}`,
    `events=${trace.events.length}`,
    `matched=${matchedCount}`
  ];
  if (dynamicUnknownCount > 0) {
    summaryParts.push(`dynamic-unknown=${dynamicUnknownCount}`);
  }
  if (unresolvedCount > 0) {
    summaryParts.push(`unresolved=${unresolvedCount}`);
  }

  return {
    summary: summaryParts.join(" | "),
    diagnostics,
    graphOverride: {
      effectLabels,
      visibleEffectIds: mode === "sample" ? Array.from(visibleEffectIds) : null
    }
  };
}

function parseRuntimeActionSampleTrace(payload: unknown): RuntimeActionSampleTrace | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const candidate = payload as Record<string, unknown>;
  if (typeof candidate.version !== "number" || !Array.isArray(candidate.events)) {
    return null;
  }

  const events = candidate.events
    .map(parseRuntimeActionSampleEvent)
    .filter((event): event is RuntimeActionSampleEvent => event !== null);

  return {
    version: candidate.version,
    events
  };
}

function parseRuntimeActionSampleEvent(payload: unknown): RuntimeActionSampleEvent | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as Record<string, unknown>;
  if (typeof candidate.kind === "string" && typeof candidate.id === "string") {
    return parseAlreadyNormalizedRuntimeEvent(candidate);
  }

  const entries = Object.entries(candidate);
  if (entries.length !== 1) {
    return null;
  }

  const [variant, body] = entries[0];
  if (!body || typeof body !== "object") {
    return null;
  }
  const record = body as Record<string, unknown>;
  const eventId = typeof record.event_id === "string" ? record.event_id : null;
  const effectId = typeof record.effect_id === "string" ? record.effect_id : null;
  if (!eventId) {
    return null;
  }

  switch (variant) {
    case "Insert":
      return {
        kind: "insert",
        id: eventId,
        effect_id: effectId,
        table: typeof record.table === "string" ? record.table : null,
        key_debug: Array.isArray(record.key_debug)
          ? record.key_debug.filter((entry): entry is string => typeof entry === "string")
          : [],
        rendered_label: typeof record.rendered_label === "string" ? record.rendered_label : null
      };
    case "Union":
      return {
        kind: "union",
        id: eventId,
        effect_id: effectId,
        lhs_debug: typeof record.lhs_debug === "string" ? record.lhs_debug : null,
        rhs_debug: typeof record.rhs_debug === "string" ? record.rhs_debug : null,
        rendered_label: typeof record.rendered_label === "string" ? record.rendered_label : null
      };
    case "Subsume":
      return { kind: "subsume", id: eventId, effect_id: effectId };
    case "Remove":
      return { kind: "remove", id: eventId, effect_id: effectId };
    case "DynamicUnknown":
      return {
        kind: "dynamic-unknown",
        id: eventId,
        effect_id: effectId,
        reason: typeof record.reason === "string" ? record.reason : "unknown"
      };
    default:
      return null;
  }
}

function parseAlreadyNormalizedRuntimeEvent(
  candidate: Record<string, unknown>
): RuntimeActionSampleEvent | null {
  const id = typeof candidate.id === "string" ? candidate.id : null;
  const effectId = typeof candidate.effect_id === "string" ? candidate.effect_id : null;
  if (!id) {
    return null;
  }

  switch (candidate.kind) {
    case "insert":
      return {
        kind: "insert",
        id,
        effect_id: effectId,
        table: typeof candidate.table === "string" ? candidate.table : null,
        key_debug: Array.isArray(candidate.key_debug)
          ? candidate.key_debug.filter((entry): entry is string => typeof entry === "string")
          : [],
        rendered_label: typeof candidate.rendered_label === "string" ? candidate.rendered_label : null
      };
    case "union":
      return {
        kind: "union",
        id,
        effect_id: effectId,
        lhs_debug: typeof candidate.lhs_debug === "string" ? candidate.lhs_debug : null,
        rhs_debug: typeof candidate.rhs_debug === "string" ? candidate.rhs_debug : null,
        rendered_label: typeof candidate.rendered_label === "string" ? candidate.rendered_label : null
      };
    case "subsume":
    case "remove":
      return {
        kind: candidate.kind,
        id,
        effect_id: effectId
      };
    case "dynamic-unknown":
      return {
        kind: "dynamic-unknown",
        id,
        effect_id: effectId,
        reason: typeof candidate.reason === "string" ? candidate.reason : "unknown"
      };
    default:
      return null;
  }
}

function runtimeEventLabel(event: RuntimeActionSampleEvent): string | null {
  switch (event.kind) {
    case "insert":
      if (event.rendered_label) {
        return event.rendered_label;
      }
      if (!event.table) {
        return null;
      }
      return `${event.table}(${event.key_debug.join(", ")})`;
    case "union":
      if (event.rendered_label) {
        return event.rendered_label;
      }
      if (event.lhs_debug && event.rhs_debug) {
        return `union(${event.lhs_debug}, ${event.rhs_debug})`;
      }
      return null;
    default:
      return null;
  }
}
