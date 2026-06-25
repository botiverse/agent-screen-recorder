#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applyTiledWindowLayout,
  buildLayoutConfig,
  normalizeTileQueries,
  readLayoutState
} from "./layout.js";
import { compressVideo, readRecording, extractFrame, renderHighlight } from "./render.js";
import { runRecording } from "./recorder.js";
import { createRunId, relativeTo } from "./metadata.js";

const commands = new Set([
  "run",
  "windows",
  "displays",
  "start",
  "stop",
  "frame",
  "render",
  "package",
  "inspect",
  "help"
]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const nativeBinary = path.join(
  projectRoot,
  "native",
  "macos-recorder",
  ".build",
  "release",
  "raft-record"
);
const sessionFile = path.join(projectRoot, ".agent-recorder-session.json");

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--") {
    argv.shift();
  }
  const [command = "help", ...rest] = argv;
  if (!commands.has(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  const args = parseArgs(rest);

  if (command === "help") {
    printHelp();
    return;
  }

  if (command === "run") {
    requireFlag(args, "name");
    const result = await runRecording({
      name: args.name,
      url: args.url,
      scenario: args.scenario,
      out: args.out || "recordings",
      headed: Boolean(args.headed),
      width: args.width,
      height: args.height,
      deviceScaleFactor: args["device-scale-factor"],
      holdMs: args["hold-ms"],
      waitUntil: args["wait-until"]
    });
    console.log(`Recording saved: ${result.runDir}`);
    return;
  }

  if (command === "windows") {
    requireNativeBinary();
    await runForeground(nativeBinary, ["list-windows"]);
    return;
  }

  if (command === "displays") {
    requireNativeBinary();
    await runForeground(nativeBinary, ["list-displays"]);
    return;
  }

  if (command === "start") {
    requireNativeBinary();
    const target = await resolveNativeTarget(args);
    const tileQueries = normalizeTileQueries(args.tile);
    if (tileQueries.length > 0 && target.type !== "display") {
      throw new Error("--tile is only supported with --full-desktop or --display, not --window");
    }
    await ensureNoLiveSession();
    const outRoot = path.resolve(args.out || args.outputDir || "recordings");
    const runDir = path.join(outRoot, createRunId(args.name || target.name));
    await mkdir(runDir, { recursive: true });
    const output = path.resolve(args.output || path.join(runDir, target.defaultFile));
    const metadataPath = path.join(runDir, "metadata.json");
    const startedAt = new Date().toISOString();
    const layout = tileQueries.length > 0
      ? await applyTiledWindowLayout(tileQueries, {
        preset: args["tile-preset"] || "auto",
        margin: args["tile-margin"],
        gap: args["tile-gap"]
      })
      : null;
    const layoutStatePath = layout ? path.join(runDir, "layout-state.json") : null;
    const layoutLoop = layout && args["keep-layout"]
      ? await startLayoutLoop({
        runDir,
        tileQueries,
        preset: args["tile-preset"] || "auto",
        margin: args["tile-margin"],
        gap: args["tile-gap"],
        intervalMs: args["layout-interval-ms"] || args["keep-layout-ms"] || 750,
        statePath: layoutStatePath
      })
      : null;

    const nativeArgs = ["record", target.nativeFlag, target.nativeValue, "--output", output];
    if (args.duration) {
      nativeArgs.push("--duration", args.duration);
    }
    await writeNativeMetadata(metadataPath, {
      schemaVersion: 1,
      kind: "native",
      runId: path.basename(runDir),
      name: args.name || target.name,
      startedAt,
      endedAt: null,
      targetType: target.type,
      target: target.name,
      video: {
        rawPath: relativeTo(runDir, output)
      },
      layout: layout ? {
        ...layout,
        keepLayout: Boolean(args["keep-layout"]),
        keepLayoutIntervalMs: layoutLoop?.intervalMs ?? null,
        layoutStatePath: layoutStatePath ? relativeTo(runDir, layoutStatePath) : null,
        correctionCount: 0,
        correctionOccurred: false
      } : null
    });

    const child = spawn(nativeBinary, nativeArgs, {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    if (!args.duration) {
      await sleep(500);
      if (!isProcessAlive(child.pid)) {
        await stopLayoutLoop(layoutLoop?.pid).catch(() => {});
        throw new Error(
          "Native recorder exited immediately. Check Screen Recording permission and whether the target window is visible."
        );
      }
    }
    const session = {
      pid: child.pid,
      startedAt: new Date().toISOString(),
      targetType: target.type,
      target: target.name,
      output,
      runDir,
      metadataPath,
      layoutLoopPid: layoutLoop?.pid ?? null,
      layoutStatePath
    };
    await writeFile(sessionFile, `${JSON.stringify(session, null, 2)}\n`);
    console.log(`Native ${target.type} recording started: pid=${child.pid}`);
    console.log(`Output: ${output}`);
    if (layout) {
      console.log(`Tiled windows: ${layout.windows.map((window) => window.query).join(", ")}`);
      if (layoutLoop) {
        console.log(`Keep-layout loop started: pid=${layoutLoop.pid}, intervalMs=${layoutLoop.intervalMs}`);
      }
    }
    return;
  }

  if (command === "stop") {
    const session = await readSession({ required: true });
    const pid = Number(session.pid);
    await stopLayoutLoop(session.layoutLoopPid).catch((error) => {
      console.error(`Warning: failed to stop keep-layout loop: ${error.message}`);
    });
    if (!isProcessAlive(pid)) {
      await unlink(sessionFile).catch(() => {});
      await finalizeNativeMetadata(session);
      if (await outputHasBytes(session.output)) {
        console.log(`Native recording already stopped: pid=${pid}`);
        console.log(`Output: ${session.output}`);
        return;
      }
      throw new Error(
        `Native recorder session existed, but pid=${pid} is no longer running and no output was written. Removed stale session.`
      );
    }
    sendStopSignal(pid);
    console.log(`Stop signal sent to pid=${pid}`);
    await waitForPidExit(pid, Number(args.timeoutMs || args["timeout-ms"] || 15000));
    await unlink(sessionFile).catch(() => {});
    await finalizeNativeMetadata(session);
    console.log(`Native recording stopped: pid=${pid}`);
    console.log(`Output: ${session.output}`);
    return;
  }

  if (command === "frame") {
    requireFlag(args, "recording");
    requireFlag(args, "out");
    const framePath = await extractFrame({
      recordingDir: args.recording,
      atMs: args["at-ms"] ?? args.at,
      interactionId: args.interaction,
      out: args.out
    });
    console.log(`Frame saved: ${framePath}`);
    return;
  }

  if (command === "render") {
    requireFlag(args, "recording");
    requireFlag(args, "out");
    const result = await renderHighlight({
      recordingDir: args.recording,
      out: args.out,
      preMs: args["pre-ms"],
      postMs: args["post-ms"],
      zoom: args.zoom
    });
    console.log(`Rendered ${result.clipCount} interaction clips: ${result.outputPath}`);
    return;
  }

  if (command === "package") {
    requireFlag(args, "input");
    requireFlag(args, "out");
    const outputPath = await compressVideo({
      input: args.input,
      out: args.out,
      crf: args.crf,
      maxHeight: args["max-height"]
    });
    console.log(`Packaged video: ${outputPath}`);
    return;
  }

  if (command === "inspect") {
    requireFlag(args, "recording");
    const { metadata, videoPath } = await readRecording(path.resolve(args.recording));
    console.log(JSON.stringify({
      runId: metadata.runId,
      name: metadata.name,
      startedAt: metadata.startedAt,
      endedAt: metadata.endedAt,
      videoPath,
      viewport: metadata.viewport,
      deviceScaleFactor: metadata.deviceScaleFactor,
      recordVideo: metadata.recordVideo,
      layout: metadata.layout,
      interactions: (metadata.interactions || []).map((entry) => ({
        id: entry.id,
        type: entry.type,
        t: entry.t,
        tMs: entry.tMs,
        label: entry.label,
        selector: entry.selector,
        contentW: entry.contentW,
        x: entry.x,
        y: entry.y
      }))
    }, null, 2));
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }
    const key = token.slice(2);
    if (key === "tile") {
      const values = [];
      while (argv[index + 1] && !argv[index + 1].startsWith("--")) {
        values.push(argv[index + 1]);
        index += 1;
      }
      assignArg(args, key, values.length > 0 ? values : true);
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      assignArg(args, key, true);
    } else {
      assignArg(args, key, next);
      index += 1;
    }
  }
  return args;
}

function assignArg(args, key, value) {
  if (args[key] === undefined) {
    args[key] = value;
    return;
  }
  if (!Array.isArray(args[key])) {
    args[key] = [args[key]];
  }
  if (Array.isArray(value)) {
    args[key].push(...value);
  } else {
    args[key].push(value);
  }
}

function requireFlag(args, key) {
  if (!args[key]) {
    throw new Error(`Missing required flag: --${key}`);
  }
}

function printHelp() {
  console.log(`agent-recorder

Commands:
  run      Record a Playwright scenario to raw.webm + metadata.json
  windows  List capturable macOS windows via ScreenCaptureKit
  displays List capturable macOS displays via ScreenCaptureKit
  start    Start native macOS window/display recording in the background
  stop     Stop the active native macOS recording
  frame    Extract a PNG frame by --at-ms or --interaction
  render   Render interaction-focused MP4 clips
  package  Compress/transcode video to upload-friendly MP4
  inspect  Print recording metadata summary

Examples:
  pnpm cli -- run --name qa-flow --url http://localhost:3000 --scenario examples/basic-scenario.mjs --out recordings --headed
  pnpm cli -- windows
  pnpm cli -- displays
  pnpm cli -- start --window "Raft Computer" --out recordings
  pnpm cli -- start --full-desktop --out recordings
  pnpm cli -- start --full-desktop --tile "Raft Desktop" "Google Chrome" --keep-layout --out recordings
  pnpm cli -- start --display main --out recordings
  pnpm cli -- stop
  pnpm cli -- frame --recording recordings/qa-flow-... --interaction 1 --out frame.png
  pnpm cli -- render --recording recordings/qa-flow-... --out demo.mp4
  pnpm cli -- package --input native-window.mp4 --out upload.mp4
`);
}

async function startLayoutLoop(options) {
  const config = buildLayoutConfig(options);
  const configPath = path.join(options.runDir, "layout-config.json");
  const loopPath = path.join(__dirname, "layout-loop.js");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const child = spawn(process.execPath, [loopPath, "--config", configPath], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  return {
    pid: child.pid,
    intervalMs: config.intervalMs
  };
}

async function stopLayoutLoop(pid) {
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0 || !isProcessAlive(numericPid)) {
    return;
  }
  try {
    process.kill(numericPid, "SIGINT");
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
    return;
  }
  try {
    await waitForPidExit(numericPid, 5000);
  } catch {
    process.kill(numericPid, "SIGTERM");
  }
}

async function writeNativeMetadata(metadataPath, metadata) {
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

async function finalizeNativeMetadata(session) {
  if (!session.metadataPath) {
    return;
  }
  let metadata;
  try {
    metadata = JSON.parse(await readFile(session.metadataPath, "utf8"));
  } catch {
    return;
  }

  metadata.endedAt = new Date().toISOString();
  if (metadata.layout && session.layoutStatePath) {
    const state = await readLayoutState(session.layoutStatePath);
    if (state) {
      metadata.layout.keepLayoutState = state;
      metadata.layout.correctionCount = Number(state.correctionCount || 0);
      metadata.layout.correctionOccurred = metadata.layout.correctionCount > 0;
    }
  }
  await writeNativeMetadata(session.metadataPath, metadata);
}

function requireNativeBinary() {
  if (!existsSync(nativeBinary)) {
    throw new Error(
      `Native recorder is not built. Run: pnpm native:build\nExpected: ${nativeBinary}`
    );
  }
}

async function runForeground(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function runCapture(command, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} exited with code ${code}${stderr ? `\n${stderr}` : ""}`));
      }
    });
  });
}

async function resolveNativeTarget(args) {
  const chosenTargets = ["window", "display", "full-desktop"].filter((key) => Boolean(args[key]));
  if (chosenTargets.length !== 1) {
    throw new Error(
      "Choose exactly one native target: --window <name>, --display <id|index|main>, or --full-desktop"
    );
  }

  if (args.window) {
    if (args.window === true) {
      throw new Error("Missing value for --window");
    }
    await ensureWindowExists(args.window);
    return {
      type: "window",
      name: args.window,
      nativeFlag: "--window",
      nativeValue: args.window,
      defaultFile: "native-window.mp4"
    };
  }

  const displaySelector = args["full-desktop"] ? "main" : args.display;
  if (displaySelector === true) {
    throw new Error("Missing value for --display");
  }
  await ensureDisplayExists(displaySelector);
  return {
    type: "display",
    name: args["full-desktop"] ? "full-desktop" : `display-${displaySelector}`,
    nativeFlag: "--display",
    nativeValue: String(displaySelector),
    defaultFile: "desktop.mp4"
  };
}

async function ensureWindowExists(windowName) {
  const windows = await readNativeWindows();
  const match = findMatchingWindow(windows, windowName);
  if (!match) {
    throw new Error(
      `No visible window matched: ${windowName}. Run "pnpm cli -- windows" to inspect available targets.`
    );
  }
}

async function ensureDisplayExists(displaySelector) {
  const displays = await readNativeDisplays();
  const match = findMatchingDisplay(displays, displaySelector);
  if (!match) {
    throw new Error(
      `No visible display matched: ${displaySelector}. Run "pnpm cli -- displays" to inspect available targets.`
    );
  }
}

async function readNativeWindows() {
  const { stdout } = await runCapture(nativeBinary, ["list-windows"]);
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Failed to parse native window list: ${error.message}`);
  }
}

async function readNativeDisplays() {
  const { stdout } = await runCapture(nativeBinary, ["list-displays"]);
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Failed to parse native display list: ${error.message}`);
  }
}

export function findMatchingWindow(windows, query) {
  const needle = String(query || "").toLowerCase();
  return windows.find((window) => {
    const title = String(window.title || "").toLowerCase();
    const app = String(window.app || "").toLowerCase();
    return title.includes(needle) || app.includes(needle);
  });
}

export function findMatchingDisplay(displays, query) {
  const needle = String(query || "").toLowerCase();
  if (!needle) {
    return undefined;
  }
  if (needle === "main" || needle === "primary") {
    return displays.find((display) => Boolean(display.isMain)) || displays[0];
  }

  const numeric = Number(needle);
  if (Number.isInteger(numeric)) {
    return displays.find((display) => display.index === numeric || display.id === numeric);
  }

  return displays.find((display) => {
    const label = String(display.label || "").toLowerCase();
    return label.includes(needle);
  });
}

async function ensureNoLiveSession() {
  const session = await readSession({ required: false });
  if (!session) {
    return;
  }

  const pid = Number(session.pid);
  if (Number.isFinite(pid) && isProcessAlive(pid)) {
    const target = session.target || session.window || "unknown";
    throw new Error(
      `A native recording session is already active: pid=${pid}, target="${target}", output=${session.output}. Run "pnpm cli -- stop" before starting another recording.`
    );
  }

  await unlink(sessionFile).catch(() => {});
  console.error(`Removed stale native recording session for pid=${session.pid}.`);
}

async function readSession({ required }) {
  try {
    return JSON.parse(await readFile(sessionFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      if (required) {
        throw new Error("No active native recording session. Start one with: pnpm cli -- start --window \"<name>\" --out recordings, or pnpm cli -- start --full-desktop --out recordings");
      }
      return null;
    }
    throw new Error(`Failed to read native recording session file: ${error.message}`);
  }
}

function sendStopSignal(pid) {
  try {
    process.kill(pid, "SIGINT");
  } catch (error) {
    if (error.code === "ESRCH") {
      throw new Error(`Native recorder pid=${pid} is no longer running.`);
    }
    throw error;
  }
}

async function outputHasBytes(output) {
  if (!output) {
    return false;
  }
  try {
    const info = await stat(output);
    return info.size > 0;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleep(100);
  }
  throw new Error(
    `Native recorder pid=${pid} did not exit within ${timeoutMs}ms; output may not be finalized`
  );
}

function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") {
      return false;
    }
    if (error.code === "EPERM") {
      return true;
    }
    throw error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error.stack);
    process.exitCode = 1;
  });
}
