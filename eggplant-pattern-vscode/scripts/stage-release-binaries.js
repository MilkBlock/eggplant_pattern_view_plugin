"use strict";

const fs = require("fs");
const path = require("path");

const extensionRoot = path.resolve(__dirname, "..");
const artifactsRoot = path.resolve(process.argv[2] || path.join(extensionRoot, ".artifacts"));
const binaryBaseName = "eggplant-pattern-extractor";
const targets = [
  { target: "aarch64-apple-darwin", platform: "darwin-arm64", binary: binaryBaseName },
  { target: "x86_64-apple-darwin", platform: "darwin-x64", binary: binaryBaseName },
  { target: "x86_64-unknown-linux-gnu", platform: "linux-x64", binary: binaryBaseName },
  { target: "aarch64-unknown-linux-gnu", platform: "linux-arm64", binary: binaryBaseName },
  { target: "x86_64-pc-windows-msvc", platform: "win32-x64", binary: `${binaryBaseName}.exe` },
  { target: "aarch64-pc-windows-msvc", platform: "win32-arm64", binary: `${binaryBaseName}.exe` }
];

for (const { target, platform, binary } of targets) {
  const sourcePath = path.join(artifactsRoot, target, binary);
  if (!fs.existsSync(sourcePath)) {
    console.error(`Missing release artifact: ${sourcePath}`);
    process.exit(1);
  }

  const destinationDir = path.join(extensionRoot, "bin", platform);
  const destinationPath = path.join(destinationDir, binary);
  fs.mkdirSync(destinationDir, { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);

  if (!destinationPath.endsWith(".exe")) {
    fs.chmodSync(destinationPath, 0o755);
  }

  console.log(`Staged ${target} -> ${destinationPath}`);
}
