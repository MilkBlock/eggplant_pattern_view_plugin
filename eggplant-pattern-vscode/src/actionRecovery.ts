import { ActionEffect, TextSpan } from "./ir";

export type ActionRecoveryMode = "static" | "sample" | "hybrid";
export type ActionRecoveryStatus = "resolved" | "dynamic-unknown" | "unsupported";
export type ActionRecoverySource = "static-inline" | "sample-trace" | "fallback";

export interface DynamicActionRecoveryPolicy {
  enabled: boolean;
  mode: ActionRecoveryMode;
  failOpen: true;
  unknownMarker: "dynamic-unknown";
}

export interface ActionRecoveryResult {
  status: ActionRecoveryStatus;
  source: ActionRecoverySource;
  summary: string;
  anchor: TextSpan | null;
}

export interface ActionRecoveryPreviewMetadata {
  summary: string;
  diagnostics: ActionSampleDiagnostic[];
}

export interface TraceSourcePreview {
  actionEffects: ActionEffect[];
  summary: string;
  diagnostics: ActionSampleDiagnostic[];
}

export interface ActionSampleTrace {
  version: 1;
  action_range: TextSpan;
  events: ActionSampleEvent[];
  diagnostics: ActionSampleDiagnostic[];
}

export type ActionSampleEvent =
  | ActionInsertEvent
  | ActionUnionEvent
  | ActionBranchEvent
  | ActionUnknownEvent;

export interface ActionInsertEvent {
  kind: "insert";
  id: string;
  effect_id: string;
  callee: string;
  rendered_label: string | null;
  source_range: TextSpan;
  input_ids: string[];
}

export interface ActionUnionEvent {
  kind: "union";
  id: string;
  effect_id: string;
  lhs: string;
  rhs: string;
  source_range: TextSpan;
}

export interface ActionBranchEvent {
  kind: "branch";
  id: string;
  effect_id: string | null;
  branch_kind: "if" | "match";
  source_range: TextSpan;
  chosen_arm_label: string | null;
}

export interface ActionUnknownEvent {
  kind: "dynamic-unknown";
  id: string;
  effect_id: string | null;
  source_range: TextSpan | null;
  reason: string;
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
  | { kind: "insert"; id: string; effect_id: string | null }
  | { kind: "union"; id: string; effect_id: string | null }
  | { kind: "subsume"; id: string; effect_id: string | null }
  | { kind: "remove"; id: string; effect_id: string | null }
  | { kind: "dynamic-unknown"; id: string; effect_id: string | null; reason: string };

export const DEFAULT_DYNAMIC_ACTION_RECOVERY_POLICY: DynamicActionRecoveryPolicy = {
  enabled: false,
  mode: "hybrid",
  failOpen: true,
  unknownMarker: "dynamic-unknown"
};

export function normalizeActionRecoveryMode(value: string | undefined): ActionRecoveryMode {
  switch (value) {
    case "static":
    case "sample":
    case "hybrid":
      return value;
    default:
      return DEFAULT_DYNAMIC_ACTION_RECOVERY_POLICY.mode;
  }
}

export function resolveDynamicActionRecoveryPolicy(settings: {
  enabled?: boolean;
  mode?: string;
}): DynamicActionRecoveryPolicy {
  return {
    enabled: settings.enabled ?? DEFAULT_DYNAMIC_ACTION_RECOVERY_POLICY.enabled,
    mode: normalizeActionRecoveryMode(settings.mode),
    failOpen: true,
    unknownMarker: "dynamic-unknown"
  };
}

export function indexActionEffectsByStableId(
  actionEffects: ActionEffect[]
): Map<string, ActionEffect> {
  return new Map(actionEffects.map((effect) => [effect.effect_id, effect]));
}

export function resolveTraceEventEffect(
  event: ActionSampleEvent,
  byStableId: Map<string, ActionEffect>
): ActionEffect | null {
  if (event.effect_id === null) {
    return null;
  }
  return byStableId.get(event.effect_id) ?? null;
}

export function summarizeRuntimeActionSampleTrace(
  payload: unknown,
  actionEffects: ActionEffect[]
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

  for (const event of trace.events) {
    const effect = event.effect_id === null ? null : effectsByStableId.get(event.effect_id) ?? null;
    if (effect) {
      matchedCount += 1;
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

    if (!effect && event.effect_id !== null) {
      diagnostics.push({
        severity: "info",
        message: `sample event ${event.id} (${event.kind}) did not match any extracted action effect (${event.effect_id})`,
        source_range: null
      });
    }
  }

  const summaryParts = [
    `recovery=sample`,
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
    diagnostics
  };
}

export function buildTraceSourcePreview(
  payload: unknown,
  actionEffects: ActionEffect[]
): TraceSourcePreview | null {
  const trace = parseRuntimeActionSampleTrace(payload);
  if (!trace) {
    return null;
  }

  const effectsByStableId = indexActionEffectsByStableId(actionEffects);
  let matchedCount = 0;
  let unresolvedCount = 0;
  let dynamicUnknownCount = 0;
  const diagnostics: ActionSampleDiagnostic[] = [];
  const traceActionEffects: ActionEffect[] = [];

  for (const event of trace.events) {
    const effect = event.effect_id === null ? null : effectsByStableId.get(event.effect_id) ?? null;
    if (effect) {
      matchedCount += 1;
      traceActionEffects.push({
        ...effect,
        id: `trace:${event.id}`,
        source_text:
          event.kind === "dynamic-unknown"
            ? `dynamic-unknown: ${event.reason}`
            : effect.source_text
      });
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

    if (!effect && event.effect_id !== null) {
      diagnostics.push({
        severity: "info",
        message: `trace event ${event.id} (${event.kind}) did not match any extracted action effect (${event.effect_id})`,
        source_range: null
      });
    }
  }

  const summaryParts = [
    "source=trace",
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
    actionEffects: traceActionEffects,
    summary: summaryParts.join(" | "),
    diagnostics
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
      return { kind: "insert", id: eventId, effect_id: effectId };
    case "Union":
      return { kind: "union", id: eventId, effect_id: effectId };
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
    case "union":
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
