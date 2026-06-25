#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { applyTiledWindowLayout, writeLayoutState } from "./layout.js";

const args = parseArgs(process.argv.slice(2));
const configPath = args.config;
if (!configPath) {
  console.error("Missing required flag: --config");
  process.exit(1);
}

let stopped = false;
process.on("SIGINT", () => {
  stopped = true;
});
process.on("SIGTERM", () => {
  stopped = true;
});

const config = JSON.parse(await readFile(configPath, "utf8"));
const state = {
  startedAt: new Date().toISOString(),
  updatedAt: null,
  iterations: 0,
  correctionCount: 0,
  lastLayout: null,
  lastError: null
};

while (!stopped) {
  await sleep(config.intervalMs);
  if (stopped) {
    break;
  }
  try {
    const layout = await applyTiledWindowLayout(config.queries, config);
    state.iterations += 1;
    state.correctionCount += 1;
    state.updatedAt = new Date().toISOString();
    state.lastLayout = layout;
    state.lastError = null;
  } catch (error) {
    state.iterations += 1;
    state.updatedAt = new Date().toISOString();
    state.lastError = error.message;
  }
  await writeLayoutState(config.statePath, state);
}

state.stoppedAt = new Date().toISOString();
await writeLayoutState(config.statePath, state);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }
    parsed[token.slice(2)] = argv[index + 1];
    index += 1;
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
