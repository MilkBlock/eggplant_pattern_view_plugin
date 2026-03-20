import * as path from "path";
import { run } from "./suite/headlessIndex";

async function main(): Promise<void> {
  try {
    await run(path.resolve(__dirname, "./suite/headless.test.js"));
  } catch (error) {
    console.error("Headless test run failed:", error);
    process.exit(1);
  }
}

void main();
