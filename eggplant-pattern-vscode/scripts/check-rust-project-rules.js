#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function parseArgs(argv) {
  const args = {
    project: process.cwd(),
    extractor: "",
    edition: "2024",
    json: false,
    failOnWarnings: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--project" || token === "-p") {
      args.project = requireValue(token, argv, ++i);
    } else if (token === "--extractor" || token === "-e") {
      args.extractor = requireValue(token, argv, ++i);
    } else if (token === "--edition") {
      args.edition = requireValue(token, argv, ++i);
    } else if (token === "--json") {
      args.json = true;
    } else if (token === "--fail-on-warnings") {
      args.failOnWarnings = true;
    } else if (token === "--help" || token === "-h") {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${token}`);
      printUsage();
      process.exit(2);
    }
  }

  return args;
}

function requireValue(flag, argv, index) {
  if (index >= argv.length) {
    console.error(`Missing value for ${flag}`);
    process.exit(2);
  }
  return argv[index];
}

function printUsage() {
  console.log(`check-rust-project-rules\n\nUsage:\n  node ./scripts/check-rust-project-rules.js [options]\n\nOptions:\n  -p, --project <path>     Rust project root to scan (default: cwd)\n  -e, --extractor <path>   Explicit extractor binary path\n      --edition <edition>  Rust edition passed to extractor (default: 2024)\n      --json               Emit JSON report only\n      --fail-on-warnings   Return non-zero if warning diagnostics appear\n  -h, --help               Show this help\n`);
}

function binaryName() {
  return process.platform === "win32" ? "eggplant-pattern-extractor.exe" : "eggplant-pattern-extractor";
}

function resolveExtractorPath(explicitExtractorPath, extensionRoot) {
  if (explicitExtractorPath && explicitExtractorPath.trim() !== "") {
    return path.resolve(explicitExtractorPath.trim());
  }

  const envPath = process.env.EGGPLANT_PATTERN_EXTRACTOR;
  if (envPath && envPath.trim() !== "") {
    return path.resolve(envPath.trim());
  }

  const bundled = path.resolve(extensionRoot, "bin", `${process.platform}-${process.arch}`, binaryName());
  if (fs.existsSync(bundled)) {
    return bundled;
  }

  return path.resolve(extensionRoot, "..", "eggplant-pattern-extractor", "target", "debug", binaryName());
}

function collectRustFiles(rootDir) {
  const ignoredDirs = new Set([".git", "target", "node_modules", "dist", "out", "build", ".idea", ".vscode"]);
  const files = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const dir = queue.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) {
          queue.push(fullPath);
        }
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".rs")) {
        files.push(fullPath);
      }
    }
  }

  files.sort();
  return files;
}

function maskCommentsAndStrings(source) {
  const out = source.split("");
  const keepNewline = (index) => {
    if (out[index] !== "\n") {
      out[index] = " ";
    }
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = i + 1 < source.length ? source[i + 1] : "";

    if (ch === "/" && next === "/") {
      keepNewline(i);
      keepNewline(i + 1);
      i += 2;
      while (i < source.length && source[i] !== "\n") {
        out[i] = " ";
        i += 1;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      keepNewline(i);
      keepNewline(i + 1);
      i += 2;
      let depth = 1;
      while (i < source.length && depth > 0) {
        const c = source[i];
        const n = i + 1 < source.length ? source[i + 1] : "";
        if (c === "/" && n === "*") {
          keepNewline(i);
          keepNewline(i + 1);
          depth += 1;
          i += 2;
          continue;
        }
        if (c === "*" && n === "/") {
          keepNewline(i);
          keepNewline(i + 1);
          depth -= 1;
          i += 2;
          continue;
        }
        keepNewline(i);
        i += 1;
      }
      continue;
    }

    if (ch === '"') {
      out[i] = " ";
      i += 1;
      while (i < source.length) {
        const c = source[i];
        if (c === "\\") {
          out[i] = " ";
          if (i + 1 < source.length) {
            keepNewline(i + 1);
          }
          i += 2;
          continue;
        }
        out[i] = c === "\n" ? "\n" : " ";
        i += 1;
        if (c === '"') {
          break;
        }
      }
      continue;
    }

    if (ch === "'" && i + 1 < source.length) {
      out[i] = " ";
      i += 1;
      while (i < source.length) {
        const c = source[i];
        if (c === "\\") {
          out[i] = " ";
          if (i + 1 < source.length) {
            keepNewline(i + 1);
          }
          i += 2;
          continue;
        }
        out[i] = c === "\n" ? "\n" : " ";
        i += 1;
        if (c === "'") {
          break;
        }
      }
      continue;
    }

    if (ch === "r" && next === '"') {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < source.length) {
        const c = source[i];
        out[i] = c === "\n" ? "\n" : " ";
        i += 1;
        if (c === '"') {
          break;
        }
      }
      continue;
    }

    if (ch === "r" && next === "#") {
      let j = i + 1;
      while (j < source.length && source[j] === "#") {
        j += 1;
      }
      if (j < source.length && source[j] === '"') {
        const hashes = j - (i + 1);
        for (let k = i; k <= j; k += 1) {
          out[k] = " ";
        }
        i = j + 1;
        while (i < source.length) {
          const c = source[i];
          out[i] = c === "\n" ? "\n" : " ";
          if (c === '"') {
            let close = true;
            for (let h = 0; h < hashes; h += 1) {
              if (i + 1 + h >= source.length || source[i + 1 + h] !== "#") {
                close = false;
                break;
              }
            }
            if (close) {
              for (let h = 0; h < hashes; h += 1) {
                out[i + 1 + h] = " ";
              }
              i += hashes + 1;
              break;
            }
          }
          i += 1;
        }
        continue;
      }
    }

    i += 1;
  }

  return out.join("");
}

function findRuleOffsets(source) {
  const masked = maskCommentsAndStrings(source);
  const regex = /(?:::|\.)\s*(add_rule(?:_with_hook)?)\s*\(/g;
  const results = [];
  let match;
  while ((match = regex.exec(masked)) !== null) {
    const raw = match[0];
    const methodName = match[1];
    const localIndex = raw.indexOf(methodName);
    const offset = match.index + (localIndex >= 0 ? localIndex : 0);
    const ruleName = inferRuleName(source, offset, methodName);
    results.push({
      methodName,
      offset,
      ruleName
    });
  }
  return results;
}

function inferRuleName(source, offset, methodName) {
  const snippet = source.slice(offset, offset + 320);
  const pattern = new RegExp(`${methodName}\\s*\\(\\s*"([^"\\n]+)"`);
  const match = snippet.match(pattern);
  return match ? match[1] : null;
}

function offsetToLineCol(source, offset) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === "\n") {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
  return { line, col };
}

function runExtractor(extractorPath, filePath, offset, edition) {
  const result = spawnSync(
    extractorPath,
    ["--file", filePath, "--offset", String(offset), "--edition", edition],
    { encoding: "utf8" }
  );

  if (result.error) {
    return {
      ok: false,
      reason: result.error.message,
      ir: null
    };
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    const stdout = (result.stdout || "").trim();
    return {
      ok: false,
      reason: stderr || stdout || `extractor exited with code ${result.status}`,
      ir: null
    };
  }

  try {
    return {
      ok: true,
      reason: "",
      ir: JSON.parse(result.stdout)
    };
  } catch (error) {
    return {
      ok: false,
      reason: `invalid JSON output: ${error instanceof Error ? error.message : String(error)}`,
      ir: null
    };
  }
}

function checkProject(options) {
  const extensionRoot = path.resolve(__dirname, "..");
  const projectRoot = path.resolve(options.project);
  const extractorPath = resolveExtractorPath(options.extractor, extensionRoot);

  if (!fs.existsSync(projectRoot)) {
    console.error(`Project path does not exist: ${projectRoot}`);
    process.exit(2);
  }

  if (!fs.existsSync(extractorPath)) {
    console.error(`Extractor binary not found at: ${extractorPath}`);
    console.error("Run 'npm run build:extractor' first, or pass --extractor <path>.");
    process.exit(2);
  }

  const rustFiles = collectRustFiles(projectRoot);
  const checks = [];

  for (const file of rustFiles) {
    const source = fs.readFileSync(file, "utf8");
    const matches = findRuleOffsets(source);
    for (const match of matches) {
      const location = offsetToLineCol(source, match.offset);
      const result = runExtractor(extractorPath, file, match.offset, options.edition);
      if (!result.ok) {
        checks.push({
          file,
          offset: match.offset,
          line: location.line,
          col: location.col,
          method: match.methodName,
          ruleName: match.ruleName,
          status: "fail",
          diagnostics: [],
          reason: result.reason,
          summary: null
        });
        continue;
      }

      const ir = result.ir;
      const diagnostics = Array.isArray(ir?.diagnostics) ? ir.diagnostics : [];
      const errorDiagnostics = diagnostics.filter((diag) => String(diag.severity).toLowerCase() === "error");
      const warningDiagnostics = diagnostics.filter((diag) => String(diag.severity).toLowerCase() === "warning");
      const scopeKind = ir?.scope?.kind;
      const isScopeMismatch = scopeKind !== "add_rule_call";
      const status = errorDiagnostics.length > 0 || isScopeMismatch ? "fail" : (warningDiagnostics.length > 0 ? "warn" : "pass");
      const reason = isScopeMismatch
        ? `scope kind mismatch: expected add_rule_call, got ${scopeKind ?? "unknown"}`
        : (errorDiagnostics[0]?.message || "");

      checks.push({
        file,
        offset: match.offset,
        line: location.line,
        col: location.col,
        method: match.methodName,
        ruleName: match.ruleName,
        status,
        diagnostics,
        reason,
        summary: {
          scopeKind,
          roots: Array.isArray(ir?.roots) ? ir.roots.length : 0,
          nodes: Array.isArray(ir?.nodes) ? ir.nodes.length : 0,
          constraints: Array.isArray(ir?.constraints) ? ir.constraints.length : 0,
          actionEffects: Array.isArray(ir?.action_effects) ? ir.action_effects.length : 0
        }
      });
    }
  }

  return {
    projectRoot,
    extractorPath,
    scannedRustFiles: rustFiles.length,
    discoveredRules: checks.length,
    checks
  };
}

function printHumanReport(report) {
  const pass = report.checks.filter((item) => item.status === "pass").length;
  const warn = report.checks.filter((item) => item.status === "warn").length;
  const fail = report.checks.filter((item) => item.status === "fail").length;

  console.log(`Project: ${report.projectRoot}`);
  console.log(`Extractor: ${report.extractorPath}`);
  console.log(`Rust files scanned: ${report.scannedRustFiles}`);
  console.log(`Rules discovered: ${report.discoveredRules}`);
  console.log(`Result: pass=${pass}, warn=${warn}, fail=${fail}`);

  if (report.checks.length === 0) {
    console.log("No add_rule/add_rule_with_hook calls found.");
    return;
  }

  for (const item of report.checks) {
    const rel = path.relative(report.projectRoot, item.file) || path.basename(item.file);
    const rule = item.ruleName ? ` rule=\"${item.ruleName}\"` : "";
    const position = `${rel}:${item.line}:${item.col}`;

    if (item.status === "pass") {
      const summary = item.summary || { roots: 0, nodes: 0, constraints: 0, actionEffects: 0 };
      console.log(
        `[PASS] ${position} ${item.method}${rule} roots=${summary.roots} nodes=${summary.nodes} constraints=${summary.constraints} actions=${summary.actionEffects}`
      );
      continue;
    }

    if (item.status === "warn") {
      const message = item.diagnostics.map((diag) => diag.message).join(" | ");
      console.log(`[WARN] ${position} ${item.method}${rule} ${message}`);
      continue;
    }

    console.log(`[FAIL] ${position} ${item.method}${rule} ${item.reason}`);
  }
}

function computeExitCode(report, failOnWarnings) {
  const failCount = report.checks.filter((item) => item.status === "fail").length;
  const warnCount = report.checks.filter((item) => item.status === "warn").length;

  if (failCount > 0) {
    return 1;
  }
  if (failOnWarnings && warnCount > 0) {
    return 1;
  }
  return 0;
}

(function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = checkProject(options);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report);
  }

  process.exit(computeExitCode(report, options.failOnWarnings));
})();
