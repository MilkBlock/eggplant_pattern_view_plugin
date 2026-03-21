import * as fs from "fs";
import { DisplayTemplate, PatternIr, PrecedenceTemplate, TypstTemplate } from "./ir";

interface ParsedMetadataFile {
  display_templates: DisplayTemplate[];
  typst_templates: TypstTemplate[];
  precedence_templates: PrecedenceTemplate[];
}

interface CachedMetadataFile extends ParsedMetadataFile {
  mtimeMs: number;
}

const metadataCache = new Map<string, CachedMetadataFile>();

function extractTemplates(source: string, attrName: "display" | "typst"): Array<DisplayTemplate | TypstTemplate> {
  const pattern = new RegExp(
    String.raw`(?s)#\s*\[\s*(?:eggplant::)?${attrName}\("(?<template>(?:\\.|[^"])*)"\)\s*\]\s*(?:#\s*\[[^\]]+\]\s*)*(?<variant>[A-Za-z_][A-Za-z0-9_]*)\s*(?:\{(?<fields>[^}]*)\})?`,
    "g"
  );
  const templates: Array<DisplayTemplate | TypstTemplate> = [];

  for (const match of source.matchAll(pattern)) {
    const variantName = match.groups?.variant?.trim();
    const template = match.groups?.template?.replace(/\\"/g, "\"");
    if (!variantName || !template) {
      continue;
    }
    const fields = (match.groups?.fields ?? "")
      .split(",")
      .map((field) => field.trim())
      .filter((field) => field.length > 0)
      .map((field) => field.split(":")[0]?.trim() ?? field);
    templates.push({
      variant_name: variantName,
      template,
      fields
    });
  }

  return templates;
}

function extractPrecedenceTemplates(source: string): PrecedenceTemplate[] {
  const pattern = /#\s*\[\s*(?:eggplant::)?precedence\((?<precedence>\d+)\)\s*\]\s*(?:#\s*\[[^\]]+\]\s*)*(?<variant>[A-Za-z_][A-Za-z0-9_]*)/g;
  const templates: PrecedenceTemplate[] = [];
  for (const match of source.matchAll(pattern)) {
    const variantName = match.groups?.variant?.trim();
    const precedence = Number(match.groups?.precedence);
    if (!variantName || Number.isNaN(precedence)) {
      continue;
    }
    templates.push({
      variant_name: variantName,
      precedence
    });
  }
  return templates;
}

function parseMetadataSource(source: string): ParsedMetadataFile {
  return {
    display_templates: extractTemplates(source, "display") as DisplayTemplate[],
    typst_templates: extractTemplates(source, "typst") as TypstTemplate[],
    precedence_templates: extractPrecedenceTemplates(source)
  };
}

export function mergeExternalMetadata(ir: PatternIr, metadataFiles: ParsedMetadataFile[]): PatternIr {
  const displayMap = new Map(ir.display_templates.map((template) => [template.variant_name, template]));
  const typstMap = new Map(ir.typst_templates.map((template) => [template.variant_name, template]));
  const precedenceMap = new Map(ir.precedence_templates.map((template) => [template.variant_name, template]));

  for (const metadata of metadataFiles) {
    for (const template of metadata.display_templates) {
      if (!displayMap.has(template.variant_name)) {
        displayMap.set(template.variant_name, template);
      }
    }
    for (const template of metadata.typst_templates) {
      if (!typstMap.has(template.variant_name)) {
        typstMap.set(template.variant_name, template);
      }
    }
    for (const template of metadata.precedence_templates) {
      if (!precedenceMap.has(template.variant_name)) {
        precedenceMap.set(template.variant_name, template);
      }
    }
  }

  return {
    ...ir,
    display_templates: Array.from(displayMap.values()),
    typst_templates: Array.from(typstMap.values()),
    precedence_templates: Array.from(precedenceMap.values())
  };
}

export function clearMetadataSourceCache(paths?: string[]): void {
  if (!paths) {
    metadataCache.clear();
    return;
  }
  for (const filePath of paths) {
    metadataCache.delete(filePath);
  }
}

export async function loadMetadataSources(paths: readonly string[]): Promise<ParsedMetadataFile[]> {
  const loaded: ParsedMetadataFile[] = [];
  for (const filePath of paths) {
    try {
      const stat = await fs.promises.stat(filePath);
      const cached = metadataCache.get(filePath);
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        loaded.push(cached);
        continue;
      }
      const source = await fs.promises.readFile(filePath, "utf8");
      const parsed = parseMetadataSource(source);
      const nextCached: CachedMetadataFile = {
        ...parsed,
        mtimeMs: stat.mtimeMs
      };
      metadataCache.set(filePath, nextCached);
      loaded.push(nextCached);
    } catch {
      // Ignore unreadable metadata files and keep preview fail-open.
    }
  }
  return loaded;
}

export async function pickMetadataSourceFiles(): Promise<string[] | undefined> {
  const vscode = await import("vscode");
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: true,
    canSelectFiles: true,
    canSelectFolders: false,
    filters: { Rust: ["rs"] },
    openLabel: "Use As Typst Metadata Sources"
  });
  return picked?.map((uri) => uri.fsPath);
}
