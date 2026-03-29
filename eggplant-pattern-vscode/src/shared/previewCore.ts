import { PatternIr } from "../ir";
import { compactConstraintLabel, inlineConstraintAnnotation } from "../dot";
import type { RuleCheckEntry } from "../ruleChecks";
import type { DotLabelStyle, DotViewMode, RecursiveStrategy } from "../dot";
import type { RenderedTypstSnippet } from "./typstCore";

export type PreviewSourceMode = "ast" | "trace";
export type PreviewConstraintFilterMode = "all" | "node-specific";
export type RecoveryUiMode = "off" | "static" | "sample" | "hybrid";
export type PreviewMetadataSourceKind = "current" | "auto" | "manual";

export interface PreviewMetadataSourceEntry {
  path: string;
  kind: PreviewMetadataSourceKind;
}

export interface PreviewMetadataEffectiveSourceEntry {
  path: string;
  kinds: PreviewMetadataSourceKind[];
}

export interface PreviewMetadataSourcesView {
  currentFile: string;
  autoDiscovered: string[];
  manual: string[];
  effective: string[];
  entries: PreviewMetadataSourceEntry[];
  effectiveEntries: PreviewMetadataEffectiveSourceEntry[];
}

export interface PreviewConstraintEntry {
  id: string;
  compactText: string;
  fullText: string;
  sourceText: string;
  referencedNodeIds: string[];
}

export interface PreviewInteractionState {
  ruleCheckViewVisible: boolean;
  activeRuleCheckId: string | null;
  sourceMode?: PreviewSourceMode;
  constraintFilterMode: PreviewConstraintFilterMode;
  constraintFilterNodeId: string | null;
  activeConstraintId: string | null;
}

export interface PreviewPanelState {
  renderNonce?: number;
  title: string;
  mode: DotViewMode;
  sourceMode: PreviewSourceMode;
  labelStyle: DotLabelStyle;
  effectiveLabelStyle: DotLabelStyle;
  recursiveStrategy: RecursiveStrategy;
  fileName: string;
  dot: string;
  svg: string;
  typstRenderings: Record<string, RenderedTypstSnippet>;
  typstSources: Record<string, string>;
  typstStatusByTargetId: Record<string, string>;
  sourceTargetIds: string[];
  allConstraints: PreviewConstraintEntry[];
  constraints: PreviewConstraintEntry[];
  nodeConstraintsPopoverTargetId?: string | null;
  nodeConstraintsPopoverRows?: PreviewConstraintEntry[];
  ruleChecks: RuleCheckEntry[];
  ruleCheckViewVisible: boolean;
  activeRuleCheckId: string | null;
  highlightedPatternNodeIds: string[];
  highlightedActionEffectIds: string[];
  constraintCountByNodeId: Record<string, number>;
  constraintFilterMode: PreviewConstraintFilterMode;
  constraintFilterNodeId: string | null;
  activeConstraintId: string | null;
  activeConstraintNodeIds: string[];
  metadataSourceFiles: string[];
  metadataSourcesView: PreviewMetadataSourcesView;
  recoveryMode: RecoveryUiMode;
  tracePath: string;
  recoverySummary: string | null;
  recoveryDiagnostics: string[];
  sourceWarning: string | null;
  showSwitchToAst: boolean;
  notice: string | null;
}

export function buildConstraintEntries(
  ir: PatternIr,
  options: { includeInlineHidden?: boolean } = {}
): PreviewConstraintEntry[] {
  const nodeIds = new Set(ir.nodes.map((node) => node.id));
  const rootIds = new Set(ir.roots);
  return ir.constraints
    .filter((constraint) => options.includeInlineHidden || inlineConstraintAnnotation(constraint)?.hideInSidebar !== true)
    .map((constraint) => ({
      id: constraint.id,
      compactText: compactConstraintLabel(constraint.source_text, constraint.resolved_text),
      fullText: constraint.resolved_text,
      sourceText: constraint.source_text,
      referencedNodeIds: (() => {
        const referenced = constraint.referenced_vars.filter((name) => nodeIds.has(name) || rootIds.has(name));
        return referenced.length > 0 ? referenced : [...ir.roots];
      })()
    }));
}

export function filterConstraintEntries(
  constraints: PreviewConstraintEntry[],
  mode: PreviewConstraintFilterMode,
  nodeId: string | null
): PreviewConstraintEntry[] {
  if (mode !== "node-specific") {
    return constraints;
  }
  if (!nodeId) {
    return [];
  }
  return constraints.filter((constraint) => constraint.referencedNodeIds.includes(nodeId));
}

export function buildConstraintCountByNodeId(
  constraints: PreviewConstraintEntry[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const constraint of constraints) {
    for (const nodeId of constraint.referencedNodeIds) {
      counts[nodeId] = (counts[nodeId] ?? 0) + 1;
    }
  }
  return counts;
}

export function toggleRuleCheckView(state: PreviewInteractionState): PreviewInteractionState {
  const visible = !state.ruleCheckViewVisible;
  return {
    ...state,
    ruleCheckViewVisible: visible,
    activeRuleCheckId: visible ? state.activeRuleCheckId : null
  };
}

export function selectRuleCheck(state: PreviewInteractionState, checkId: string): PreviewInteractionState {
  return {
    ...state,
    ruleCheckViewVisible: true,
    activeRuleCheckId: state.activeRuleCheckId === checkId ? null : checkId
  };
}

export function selectConstraint(state: PreviewInteractionState, constraintId: string): PreviewInteractionState {
  return {
    ...state,
    activeConstraintId: state.activeConstraintId === constraintId ? null : constraintId
  };
}

export function setConstraintFilterMode(
  state: PreviewInteractionState,
  mode: PreviewConstraintFilterMode
): PreviewInteractionState {
  return {
    ...state,
    constraintFilterMode: mode,
    constraintFilterNodeId: mode === "all" ? null : state.constraintFilterNodeId
  };
}

export function drilldownConstraintNode(
  state: PreviewInteractionState,
  targetId: string,
  visibleConstraints: PreviewConstraintEntry[]
): PreviewInteractionState {
  return {
    ...state,
    constraintFilterMode: "node-specific",
    constraintFilterNodeId: targetId,
    activeConstraintId: visibleConstraints.some((constraint) => constraint.id === state.activeConstraintId)
      ? state.activeConstraintId
      : null
  };
}

export function reconcilePreviewInteractionState(
  state: PreviewInteractionState,
  ruleChecks: RuleCheckEntry[],
  constraints: PreviewConstraintEntry[]
): PreviewInteractionState {
  const activeRuleCheckId = ruleChecks.some((check) => check.id === state.activeRuleCheckId)
    ? state.activeRuleCheckId
    : null;

  let constraintFilterMode = state.constraintFilterMode;
  let constraintFilterNodeId = state.constraintFilterNodeId;
  if (
    constraintFilterMode === "node-specific"
    && constraintFilterNodeId
    && !constraints.some((constraint) => constraint.referencedNodeIds.includes(constraintFilterNodeId as string))
  ) {
    constraintFilterMode = "all";
    constraintFilterNodeId = null;
  }

  const visibleConstraints = filterConstraintEntries(constraints, constraintFilterMode, constraintFilterNodeId);
  const activeConstraintId = visibleConstraints.some((constraint) => constraint.id === state.activeConstraintId)
    ? state.activeConstraintId
    : null;

  return {
    ...state,
    activeRuleCheckId,
    constraintFilterMode,
    constraintFilterNodeId,
    activeConstraintId
  };
}
