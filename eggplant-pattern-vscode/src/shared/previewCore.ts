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

export interface PreviewInteractionProjection {
  state: PreviewInteractionState;
  visibleConstraints: PreviewConstraintEntry[];
  activeConstraintNodeIds: string[];
  highlightedPatternNodeIds: string[];
  highlightedActionEffectIds: string[];
}

export interface MathViewPreviewEntry {
  targetId: string;
  label: string;
}

export interface MathViewPreviewState {
  ruleName: string;
  formulaTargetId: string;
  formulaSource: string;
  derivations: MathViewPreviewEntry[];
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
  mathView: MathViewPreviewState | null;
}

export interface BuildPreviewPanelStateInput {
  mode: DotViewMode;
  sourceMode: PreviewSourceMode;
  selectedLabelStyle: DotLabelStyle;
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
  ruleChecks: RuleCheckEntry[];
  interactionState: PreviewInteractionState;
  metadataSourceFiles: string[];
  metadataSourcesView: PreviewMetadataSourcesView;
  recoveryMode: RecoveryUiMode;
  tracePath: string;
  recoverySummary: string | null;
  recoveryDiagnostics: string[];
  sourceWarning: string | null;
  showSwitchToAst: boolean;
  notice: string | null;
  mathView: MathViewPreviewState | null;
}

export function createDefaultPreviewInteractionState(): PreviewInteractionState {
  return {
    ruleCheckViewVisible: false,
    activeRuleCheckId: null,
    constraintFilterMode: "all",
    constraintFilterNodeId: null,
    activeConstraintId: null
  };
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
      compactText: constraint.semantic_text?.trim() || compactConstraintLabel(constraint.source_text, constraint.resolved_text),
      fullText: constraint.semantic_text?.trim() || constraint.resolved_text,
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

export function projectPreviewInteractionState(
  state: PreviewInteractionState,
  ruleChecks: RuleCheckEntry[],
  constraints: PreviewConstraintEntry[]
): PreviewInteractionProjection {
  const reconciled = reconcilePreviewInteractionState(state, ruleChecks, constraints);
  const visibleConstraints = filterConstraintEntries(
    constraints,
    reconciled.constraintFilterMode,
    reconciled.constraintFilterNodeId
  );
  const activeConstraint = visibleConstraints.find((constraint) => constraint.id === reconciled.activeConstraintId) ?? null;
  const activeRuleCheck = ruleChecks.find((check) => check.id === reconciled.activeRuleCheckId) ?? null;
  const highlightedPatternNodeIds = new Set<string>();
  const highlightedActionEffectIds = new Set<string>();
  const checksToHighlight = reconciled.ruleCheckViewVisible
    ? (activeRuleCheck ? [activeRuleCheck] : ruleChecks)
    : [];
  for (const check of checksToHighlight) {
    for (const nodeId of check.duplicatePatternNodeIds) {
      highlightedPatternNodeIds.add(nodeId);
    }
    for (const effectId of check.duplicateActionEffectIds) {
      highlightedActionEffectIds.add(effectId);
    }
  }

  return {
    state: {
      ...reconciled,
      activeRuleCheckId: activeRuleCheck?.id ?? null,
      activeConstraintId: activeConstraint?.id ?? null
    },
    visibleConstraints,
    activeConstraintNodeIds: activeConstraint?.referencedNodeIds ?? [],
    highlightedPatternNodeIds: Array.from(highlightedPatternNodeIds),
    highlightedActionEffectIds: Array.from(highlightedActionEffectIds)
  };
}

export function modeLabel(mode: DotViewMode): string {
  switch (mode) {
    case "pattern":
      return "pattern.dot";
    case "action":
      return "action.dot";
    case "combined":
      return "action + pattern.dot";
  }
}

export function formatPreviewTitle(
  mode: DotViewMode,
  sourceMode: PreviewSourceMode,
  effectiveLabelStyle: DotLabelStyle,
  recursiveStrategy: RecursiveStrategy,
  fileName: string
): string {
  const strategySuffix = effectiveLabelStyle === "recursive" ? `, ${recursiveStrategy}` : "";
  return `Eggplant Pattern (${modeLabel(mode)}, ${sourceMode}, ${effectiveLabelStyle}${strategySuffix}): ${fileName}`;
}

export function collectSourceTargetIds(ir: PatternIr, mode: DotViewMode): string[] {
  const targetIds: string[] = [];
  if (mode === "pattern" || mode === "combined") {
    for (const node of ir.nodes) {
      targetIds.push(node.id);
    }
  }
  if (mode === "action" || mode === "combined") {
    for (const effect of ir.action_effects) {
      targetIds.push(`effect:${effect.id}`);
    }
    for (const fact of ir.seed_facts) {
      targetIds.push(`seed:${fact.id}`);
    }
  }
  return targetIds;
}

export function buildMetadataSourcesView(
  currentFile: string,
  autoMetadataSourceFiles: string[],
  manualMetadataSourceFiles: string[]
): PreviewMetadataSourcesView {
  const autoDiscovered = Array.from(new Set(autoMetadataSourceFiles));
  const manual = Array.from(new Set(manualMetadataSourceFiles));
  const entries: PreviewMetadataSourceEntry[] = [
    { path: currentFile, kind: "current" },
    ...autoDiscovered.map((filePath) => ({ path: filePath, kind: "auto" as const })),
    ...manual.map((filePath) => ({ path: filePath, kind: "manual" as const }))
  ];
  const effectiveKinds = new Map<string, Set<PreviewMetadataSourceKind>>();
  for (const entry of entries) {
    const kinds = effectiveKinds.get(entry.path) ?? new Set<PreviewMetadataSourceKind>();
    kinds.add(entry.kind);
    effectiveKinds.set(entry.path, kinds);
  }
  const effectiveEntries = Array.from(effectiveKinds.entries()).map(([filePath, kinds]) => ({
    path: filePath,
    kinds: Array.from(kinds)
  }));
  const effective = effectiveEntries.map((entry) => entry.path);
  return {
    currentFile,
    autoDiscovered,
    manual,
    effective,
    entries,
    effectiveEntries
  };
}

export function buildPreviewPanelState(input: BuildPreviewPanelStateInput): PreviewPanelState {
  const {
    mode,
    sourceMode,
    selectedLabelStyle,
    effectiveLabelStyle,
    recursiveStrategy,
    fileName,
    dot,
    svg,
    typstRenderings,
    typstSources,
    typstStatusByTargetId,
    sourceTargetIds,
    allConstraints,
    constraints,
    ruleChecks,
    interactionState,
    metadataSourceFiles,
    metadataSourcesView,
    recoveryMode,
    tracePath,
    recoverySummary,
    recoveryDiagnostics,
    sourceWarning,
    showSwitchToAst,
    notice,
    mathView
  } = input;
  const projection = projectPreviewInteractionState(interactionState, ruleChecks, constraints);
  const projectedState = projection.state;

  return {
    title: formatPreviewTitle(mode, sourceMode, effectiveLabelStyle, recursiveStrategy, fileName),
    mode,
    sourceMode,
    recoveryMode,
    tracePath,
    labelStyle: selectedLabelStyle,
    effectiveLabelStyle,
    recursiveStrategy,
    fileName,
    dot,
    svg,
    typstRenderings,
    typstSources,
    typstStatusByTargetId,
    sourceTargetIds,
    allConstraints,
    constraints: projection.visibleConstraints,
    ruleChecks,
    ruleCheckViewVisible: projectedState.ruleCheckViewVisible,
    activeRuleCheckId: projectedState.activeRuleCheckId,
    highlightedPatternNodeIds: projection.highlightedPatternNodeIds,
    highlightedActionEffectIds: projection.highlightedActionEffectIds,
    constraintCountByNodeId: buildConstraintCountByNodeId(constraints),
    constraintFilterMode: projectedState.constraintFilterMode,
    constraintFilterNodeId: projectedState.constraintFilterNodeId,
    activeConstraintId: projectedState.activeConstraintId,
    activeConstraintNodeIds: projection.activeConstraintNodeIds,
    metadataSourceFiles,
    metadataSourcesView,
    recoverySummary,
    recoveryDiagnostics,
    sourceWarning,
    showSwitchToAst,
    notice,
    mathView
  };
}
