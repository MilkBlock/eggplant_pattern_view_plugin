import { TextSpan } from "./ir";

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
  callee: string;
  rendered_label: string | null;
  source_range: TextSpan;
  input_ids: string[];
}

export interface ActionUnionEvent {
  kind: "union";
  id: string;
  lhs: string;
  rhs: string;
  source_range: TextSpan;
}

export interface ActionBranchEvent {
  kind: "branch";
  id: string;
  branch_kind: "if" | "match";
  source_range: TextSpan;
  chosen_arm_label: string | null;
}

export interface ActionUnknownEvent {
  kind: "dynamic-unknown";
  id: string;
  source_range: TextSpan | null;
  reason: string;
}

export interface ActionSampleDiagnostic {
  severity: "info" | "warning";
  message: string;
  source_range: TextSpan | null;
}

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
