"use strict";

const fs = require("fs");
const path = require("path");

const extensionRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(extensionRoot, "..");
const binaryName = process.platform === "win32"
  ? "eggplant-pattern-extractor.exe"
  : "eggplant-pattern-extractor";
const platformTriple = `${process.platform}-${process.arch}`;
const sourcePath = path.resolve(
  repoRoot,
  "eggplant-pattern-extractor",
  "target",
  "debug",
  binaryName
);
const destinationDir = path.resolve(extensionRoot, "bin", platformTriple);
const destinationPath = path.resolve(destinationDir, binaryName);

if (!fs.existsSync(sourcePath)) {
  console.error(`Extractor binary not found at ${sourcePath}. Run 'npm run build:extractor' first.`);
  process.exit(1);
}

fs.mkdirSync(destinationDir, { recursive: true });
fs.copyFileSync(sourcePath, destinationPath);
fs.chmodSync(destinationPath, 0o755);

console.log(`Bundled extractor for ${platformTriple}: ${destinationPath}`);
