import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";

const execFileAsync = promisify(execFile);

export async function readRecording(recordingDir) {
  const metadataPath = path.join(recordingDir, "metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  if (!metadata.video?.rawPath) {
    throw new Error(`Recording has no video.rawPath: ${metadataPath}`);
  }
  return {
    metadata,
    videoPath: path.join(recordingDir, metadata.video.rawPath)
  };
}

export function buildZoomFilter({ width, height, x, y, zoom = 1.35 }) {
  const safeZoom = Math.max(1, Number(zoom) || 1);
  const cropWidth = Math.max(1, Math.round(width / safeZoom));
  const cropHeight = Math.max(1, Math.round(height / safeZoom));
  const cropX = clamp(Math.round(x - cropWidth / 2), 0, width - cropWidth);
  const cropY = clamp(Math.round(y - cropHeight / 2), 0, height - cropHeight);
  const markerX = clamp(Math.round((x - cropX) * safeZoom - 16), 0, width - 32);
  const markerY = clamp(Math.round((y - cropY) * safeZoom - 16), 0, height - 32);

  return {
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    markerX,
    markerY,
    filter: [
      `crop=${cropWidth}:${cropHeight}:${cropX}:${cropY}`,
      `scale=${width}:${height}:flags=lanczos`,
      `drawbox=x=${markerX}:y=${markerY}:w=32:h=32:color=red@0.65:t=4`
    ].join(",")
  };
}

export function buildFocalLockTransform({ width, height, x, y, zoom = 1.35, progress = 1 }) {
  const safeZoom = Math.max(1, Number(zoom) || 1);
  const p = clamp(Number(progress), 0, 1);
  const s = 1 + (safeZoom - 1) * p;
  const focalX = width / 2 + (x - width / 2) * p;
  const focalY = height / 2 + (y - height / 2) * p;

  return {
    scale: s,
    tx: width / 2 - focalX * s,
    ty: height / 2 - focalY * s
  };
}

export function createClipPlans(metadata, options = {}) {
  const width = Number(metadata.video?.width || metadata.viewport?.width || 1280);
  const height = Number(metadata.video?.height || metadata.viewport?.height || 720);
  const preMs = Number(options.preMs ?? 700);
  const postMs = Number(options.postMs ?? 1600);
  const zoom = Number(options.zoom ?? 1.35);

  return metadata.interactions
    .filter((entry) => Number.isFinite(entry.x) && Number.isFinite(entry.y))
    .map((entry) => {
      const startMs = Math.max(0, interactionTime(entry) - preMs);
      const durationMs = Math.max(250, preMs + postMs);
      const interactionZoom = resolveInteractionZoom({ entry, width, defaultZoom: zoom });
      return {
        interactionId: entry.id,
        type: entry.type,
        label: entry.label || entry.selector || entry.type,
        startMs,
        durationMs,
        zoom: interactionZoom,
        focalLock: buildFocalLockTransform({
          width,
          height,
          x: entry.x,
          y: entry.y,
          zoom: interactionZoom,
          progress: 1
        }),
        ...buildZoomFilter({ width, height, x: entry.x, y: entry.y, zoom: interactionZoom })
      };
    });
}

export async function extractFrame({ recordingDir, atMs, interactionId, out }) {
  assertFfmpeg();
  const { metadata, videoPath } = await readRecording(recordingDir);
  const targetMs = resolveTime(metadata, { atMs, interactionId });
  await runFfmpeg([
    "-y",
    "-ss",
    seconds(targetMs),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    path.resolve(out)
  ]);
  return path.resolve(out);
}

export async function renderHighlight({ recordingDir, out, preMs, postMs, zoom }) {
  assertFfmpeg();
  const { metadata, videoPath } = await readRecording(recordingDir);
  const outputPath = path.resolve(out);
  const plans = createClipPlans(metadata, { preMs, postMs, zoom });

  if (plans.length === 0) {
    await runFfmpeg([
      "-y",
      "-i",
      videoPath,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-an",
      outputPath
    ]);
    return { outputPath, clipCount: 0 };
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "agent-recorder-"));
  try {
    const clipPaths = [];
    for (let index = 0; index < plans.length; index += 1) {
      const plan = plans[index];
      const clipPath = path.join(tmpDir, `clip-${String(index).padStart(3, "0")}.mp4`);
      await runFfmpeg([
        "-y",
        "-ss",
        seconds(plan.startMs),
        "-t",
        seconds(plan.durationMs),
        "-i",
        videoPath,
        "-vf",
        plan.filter,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-an",
        clipPath
      ]);
      clipPaths.push(clipPath);
    }

    const concatFile = path.join(tmpDir, "concat.txt");
    await writeFile(
      concatFile,
      clipPaths.map((clipPath) => `file '${escapeConcatPath(clipPath)}'`).join("\n") + "\n"
    );

    await runFfmpeg([
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatFile,
      "-c",
      "copy",
      outputPath
    ]);
    return { outputPath, clipCount: plans.length };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export async function compressVideo({ input, out, crf = 28, maxHeight = 1080 }) {
  assertFfmpeg();
  const scaleFilter = `scale=-2:'min(${Number(maxHeight)},ih)'`;
  await runFfmpeg([
    "-y",
    "-i",
    path.resolve(input),
    "-vf",
    scaleFilter,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-an",
    path.resolve(out)
  ]);
  return path.resolve(out);
}

export function resolveTime(metadata, { atMs, interactionId }) {
  if (interactionId !== undefined) {
    const interaction = metadata.interactions.find(
      (entry) => String(entry.id) === String(interactionId)
    );
    if (!interaction) {
      throw new Error(`Interaction not found: ${interactionId}`);
    }
    return interactionTime(interaction);
  }

  if (atMs === undefined) {
    throw new Error("Provide --at-ms or --interaction");
  }

  return Number(atMs);
}

function assertFfmpeg() {
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static did not resolve an ffmpeg binary");
  }
}

async function runFfmpeg(args) {
  try {
    await execFileAsync(ffmpegPath, args, { maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    error.message = `ffmpeg failed: ${error.message}\nargs: ${args.join(" ")}`;
    throw error;
  }
}

function seconds(ms) {
  return (Number(ms) / 1000).toFixed(3);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function resolveInteractionZoom({ entry, width, defaultZoom }) {
  const contentW = Number(entry.contentW);
  if (Number.isFinite(contentW) && contentW > 0) {
    return Math.max(1, width / Math.min(width, contentW));
  }
  return Math.max(1, Number(defaultZoom) || 1);
}

function interactionTime(entry) {
  const t = Number(entry.t ?? entry.tMs);
  if (!Number.isFinite(t)) {
    throw new Error(`Interaction has no finite timestamp: ${entry.id}`);
  }
  return t;
}

function escapeConcatPath(filePath) {
  return filePath.replace(/'/g, "'\\''");
}
