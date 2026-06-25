import { rename } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import {
  createRunId,
  ensureDir,
  relativeTo,
  safeSlug,
  writeJson
} from "./metadata.js";

export function createInteractionRecorder(page, metadata, startedAtMs) {
  let nextId = 1;

  const elapsed = () => Math.max(0, Math.round(performance.now() - startedAtMs));

  const push = (entry) => {
    const t = elapsed();
    const interaction = {
      ...entry,
      id: nextId++,
      t,
      tMs: t
    };
    metadata.interactions.push(interaction);
    return interaction;
  };

  const centerOf = async (selector) => {
    const locator = page.locator(selector).first();
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (!box) {
      throw new Error(`Cannot resolve visible bounding box for selector: ${selector}`);
    }
    return {
      locator,
      box,
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2)
    };
  };

  return {
    log: push,

    async mark(label, extra = {}) {
      return push({ type: "mark", label, ...extra });
    },

    async wait(ms, label = "wait") {
      const entry = push({ type: "wait", label, durationMs: Number(ms) });
      await page.waitForTimeout(Number(ms));
      return entry;
    },

    async click(selector, options = {}) {
      const { box, x, y } = await centerOf(selector);
      const entry = push({
        type: "click",
        selector,
        label: options.label,
        contentW: normalizedContentWidth(options.contentW),
        x,
        y,
        button: options.button || "left",
        box: roundedBox(box)
      });
      await page.mouse.click(x, y, {
        button: options.button || "left",
        clickCount: options.clickCount || 1,
        delay: options.delay
      });
      return entry;
    },

    async fill(selector, value, options = {}) {
      const { locator, box, x, y } = await centerOf(selector);
      const entry = push({
        type: "fill",
        selector,
        label: options.label,
        contentW: normalizedContentWidth(options.contentW),
        x,
        y,
        valueLength: String(value).length,
        valueCaptured: Boolean(options.captureValue),
        value: options.captureValue ? String(value) : undefined,
        box: roundedBox(box)
      });
      await locator.fill(String(value));
      return entry;
    },

    async press(selector, key, options = {}) {
      const { locator, box, x, y } = await centerOf(selector);
      const entry = push({
        type: "press",
        selector,
        label: options.label,
        contentW: normalizedContentWidth(options.contentW),
        x,
        y,
        key,
        box: roundedBox(box)
      });
      await locator.press(key);
      return entry;
    },

    async screenshot(name, options = {}) {
      const fileName = `${safeSlug(name)}.png`;
      const outputPath = path.join(metadata.paths.framesDir, fileName);
      await ensureDir(metadata.paths.framesDir);
      await page.screenshot({ path: outputPath, fullPage: Boolean(options.fullPage) });
      return push({
        type: "screenshot",
        label: name,
        path: relativeTo(metadata.paths.runDir, outputPath)
      });
    }
  };
}

function roundedBox(box) {
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height)
  };
}

function normalizedContentWidth(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export async function runRecording(options) {
  const name = options.name || "recording";
  const runId = createRunId(name);
  const outRoot = path.resolve(options.out || "recordings");
  const runDir = path.join(outRoot, runId);
  const videoDir = path.join(runDir, "video-tmp");
  const framesDir = path.join(runDir, "frames");
  const deviceScaleFactor = Number(options.deviceScaleFactor || 1);
  const viewport = {
    width: Number(options.width || 1920),
    height: Number(options.height || 1080)
  };

  await ensureDir(videoDir);
  await ensureDir(framesDir);

  const metadata = {
    schemaVersion: 1,
    runId,
    name,
    startedAt: new Date().toISOString(),
    endedAt: null,
    viewport,
    deviceScaleFactor,
    recordVideo: {
      size: viewport,
      clockOrigin: "after-new-page"
    },
    video: null,
    interactions: [],
    paths: {
      runDir,
      framesDir
    }
  };

  const browser = await chromium.launch({ headless: !options.headed });
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor,
    recordVideo: {
      dir: videoDir,
      size: viewport
    }
  });
  const page = await context.newPage();
  const startedAtMs = performance.now();
  const recorder = createInteractionRecorder(page, metadata, startedAtMs);

  try {
    if (options.url) {
      await page.goto(options.url, { waitUntil: options.waitUntil || "domcontentloaded" });
    }

    if (options.scenario) {
      const scenarioUrl = pathToFileURL(path.resolve(options.scenario)).href;
      const scenarioModule = await import(`${scenarioUrl}?t=${Date.now()}`);
      if (typeof scenarioModule.default !== "function") {
        throw new Error(`Scenario must export a default async function: ${options.scenario}`);
      }
      await scenarioModule.default({ page, recorder, metadata });
    } else if (options.holdMs) {
      await recorder.wait(Number(options.holdMs), "hold");
    }
  } finally {
    metadata.endedAt = new Date().toISOString();
    const video = page.video();
    await context.close();
    await browser.close();

    if (video) {
      const sourceVideoPath = await video.path();
      const rawVideoPath = path.join(runDir, "raw.webm");
      await rename(sourceVideoPath, rawVideoPath);
      metadata.video = {
        rawPath: relativeTo(runDir, rawVideoPath),
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor
      };
    }

    delete metadata.paths;
    await writeJson(path.join(runDir, "metadata.json"), metadata);
  }

  return { runDir, metadata };
}
