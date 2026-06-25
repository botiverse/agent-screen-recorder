#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compressVideo, readRecording, extractFrame, renderHighlight } from "./render.js";
import { runRecording } from "./recorder.js";
import { createRunId } from "./metadata.js";

const commands = new Set([
  "run",
  "windows",
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

  if (command === "start") {
    requireNativeBinary();
    requireFlag(args, "window");
    await ensureNoLiveSession();
    await ensureWindowExists(args.window);
    const outRoot = path.resolve(args.out || args.outputDir || "recordings");
    const runDir = path.join(outRoot, createRunId(args.name || args.window));
    await mkdir(runDir, { recursive: true });
    const output = path.resolve(args.output || path.join(runDir, "native-window.mp4"));
    const nativeArgs = ["record", "--window", args.window, "--output", output];
    if (args.duration) {
      nativeArgs.push("--duration", args.duration);
    }
    const child = spawn(nativeBinary, nativeArgs, {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    if (!args.duration) {
      await sleep(500);
      if (!isProcessAlive(child.pid)) {
        throw new Error(
          "Native recorder exited immediately. Check Screen Recording permission and whether the target window is visible."
        );
      }
    }
    const session = {
      pid: child.pid,
      startedAt: new Date().toISOString(),
      window: args.window,
      output
    };
    await writeFile(sessionFile, `${JSON.stringify(session, null, 2)}\n`);
    console.log(`Native window recording started: pid=${child.pid}`);
    console.log(`Output: ${output}`);
    return;
  }

  if (command === "stop") {
    const session = await readSession({ required: true });
    const pid = Number(session.pid);
    if (!isProcessAlive(pid)) {
      await unlink(sessionFile).catch(() => {});
      if (await outputHasBytes(session.output)) {
        console.log(`Native window recording already stopped: pid=${pid}`);
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
    console.log(`Native window recording stopped: pid=${pid}`);
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
      interactions: metadata.interactions.map((entry) => ({
        id: entry.id,
        type: entry.type,
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
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
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
  start    Start native macOS window recording in the background
  stop     Stop the active native macOS window recording
  frame    Extract a PNG frame by --at-ms or --interaction
  render   Render interaction-focused MP4 clips
  package  Compress/transcode video to upload-friendly MP4
  inspect  Print recording metadata summary

Examples:
  pnpm cli -- run --name qa-flow --url http://localhost:3000 --scenario examples/basic-scenario.mjs --out recordings --headed
  pnpm cli -- windows
  pnpm cli -- start --window "Raft Computer" --out recordings
  pnpm cli -- stop
  pnpm cli -- frame --recording recordings/qa-flow-... --interaction 1 --out frame.png
  pnpm cli -- render --recording recordings/qa-flow-... --out demo.mp4
  pnpm cli -- package --input native-window.mp4 --out upload.mp4
`);
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

async function ensureWindowExists(windowName) {
  const windows = await readNativeWindows();
  const match = findMatchingWindow(windows, windowName);
  if (!match) {
    throw new Error(
      `No visible window matched: ${windowName}. Run "pnpm cli -- windows" to inspect available targets.`
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

export function findMatchingWindow(windows, query) {
  const needle = String(query || "").toLowerCase();
  return windows.find((window) => {
    const title = String(window.title || "").toLowerCase();
    const app = String(window.app || "").toLowerCase();
    return title.includes(needle) || app.includes(needle);
  });
}

async function ensureNoLiveSession() {
  const session = await readSession({ required: false });
  if (!session) {
    return;
  }

  const pid = Number(session.pid);
  if (Number.isFinite(pid) && isProcessAlive(pid)) {
    throw new Error(
      `A native recording session is already active: pid=${pid}, window="${session.window}", output=${session.output}. Run "pnpm cli -- stop" before starting another recording.`
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
        throw new Error("No active native recording session. Start one with: pnpm cli -- start --window \"<name>\" --out recordings");
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
