import * as fs from "fs";
import * as path from "path";
import { DisplayTemplate, PatternIr, PrecedenceTemplate, TypstTemplate } from "./ir";

interface ParsedMetadataFile {
  display_templates: DisplayTemplate[];
  typst_templates: TypstTemplate[];
  precedence_templates: PrecedenceTemplate[];
}

interface MetadataIndexEntry {
  dsl_type_names: string[];
  variant_names: string[];
}

interface CachedMetadataFile extends ParsedMetadataFile {
  mtimeMs: number;
  size: number;
}

const metadataCache = new Map<string, CachedMetadataFile>();

export function metadataCacheMatches(
  cached: { mtimeMs: number; size: number },
  stat: { mtimeMs: number; size: number }
): boolean {
  return cached.mtimeMs === stat.mtimeMs && cached.size === stat.size;
}

function extractTemplates(source: string, attrName: "display" | "typst"): Array<DisplayTemplate | TypstTemplate> {
  const pattern = new RegExp(
    String.raw`#\s*\[\s*(?:eggplant::)?${attrName}\("(?<template>(?:\\.|[^"])*)"\)\s*\]\s*(?:#\s*\[[^\]]+\]\s*)*(?<variant>[A-Za-z_][A-Za-z0-9_]*)\s*(?:\{(?<fields>[^}]*)\})?`,
    "gs"
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

function extractDslTypeNames(source: string): string[] {
  const pattern = /#\s*\[\s*(?:eggplant::)?dsl\s*\]\s*enum\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/g;
  const names: string[] = [];
  for (const match of source.matchAll(pattern)) {
    const name = match.groups?.name?.trim();
    if (name) {
      names.push(name);
    }
  }
  return names;
}

export function indexMetadataSource(source: string): MetadataIndexEntry {
  const parsed = parseMetadataSource(source);
  const variantNames = new Set<string>();
  for (const template of parsed.display_templates) {
    variantNames.add(template.variant_name);
  }
  for (const template of parsed.typst_templates) {
    variantNames.add(template.variant_name);
  }
  for (const template of parsed.precedence_templates) {
    variantNames.add(template.variant_name);
  }

  return {
    dsl_type_names: extractDslTypeNames(source),
    variant_names: Array.from(variantNames)
  };
}

export function metadataSourceMatchesIdentifiers(
  source: string,
  requiredIdentifiers: ReadonlySet<string>
): boolean {
  if (requiredIdentifiers.size === 0) {
    return false;
  }
  const index = indexMetadataSource(source);
  return index.dsl_type_names.some((name) => requiredIdentifiers.has(name))
    || index.variant_names.some((name) => requiredIdentifiers.has(name));
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
      if (cached && metadataCacheMatches(cached, stat)) {
        loaded.push(cached);
        continue;
      }
      const source = await fs.promises.readFile(filePath, "utf8");
      const parsed = parseMetadataSource(source);
      const nextCached: CachedMetadataFile = {
        ...parsed,
        mtimeMs: stat.mtimeMs,
        size: stat.size
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

export async function discoverWorkspaceMetadataSourceFiles(
  currentDocumentPath: string,
  manualMetadataSourceFiles: readonly string[],
  requiredIdentifiers: ReadonlySet<string>
): Promise<string[]> {
  if (requiredIdentifiers.size === 0) {
    return [];
  }
  const vscode = await import("vscode");
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(currentDocumentPath));
  const workspaceRustFiles = workspaceFolder
    ? await vscode.workspace.findFiles(
        new vscode.RelativePattern(workspaceFolder, "**/*.rs"),
        "**/{target,node_modules,.git,dist,out}/**"
      )
    : [];
  const rustFiles = workspaceRustFiles.length > 0
    ? workspaceRustFiles
    : (await collectRustFiles(path.dirname(currentDocumentPath))).map((filePath) => vscode.Uri.file(filePath));
  const excluded = new Set([currentDocumentPath, ...manualMetadataSourceFiles]);
  const discovered: string[] = [];
  for (const uri of rustFiles) {
    const filePath = uri.fsPath;
    if (excluded.has(filePath)) {
      continue;
    }
    try {
      const source = await fs.promises.readFile(filePath, "utf8");
      if (metadataSourceMatchesIdentifiers(source, requiredIdentifiers)) {
        discovered.push(filePath);
      }
    } catch {
      // Ignore unreadable files and keep metadata discovery fail-open.
    }
  }
  return discovered;
}

async function collectRustFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.promises.readdir(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if ([".git", "dist", "node_modules", "out", "target"].includes(entry.name)) {
        continue;
      }
      files.push(...await collectRustFiles(fullPath));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith(".rs")) {
      files.push(fullPath);
    }
  }
  return files;
}
