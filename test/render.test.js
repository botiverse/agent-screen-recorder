import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFocalLockTransform,
  buildZoomFilter,
  createClipPlans,
  resolveTime
} from "../src/render.js";

test("buildZoomFilter centers crop on interaction when possible", () => {
  const result = buildZoomFilter({
    width: 1280,
    height: 720,
    x: 640,
    y: 360,
    zoom: 1.6
  });

  assert.equal(result.cropWidth, 800);
  assert.equal(result.cropHeight, 450);
  assert.equal(result.cropX, 240);
  assert.equal(result.cropY, 135);
  assert.match(result.filter, /drawbox/);
});

test("buildZoomFilter clamps crop near viewport edges", () => {
  const result = buildZoomFilter({
    width: 1280,
    height: 720,
    x: 10,
    y: 12,
    zoom: 1.5
  });

  assert.equal(result.cropX, 0);
  assert.equal(result.cropY, 0);
  assert.ok(result.markerX >= 0);
  assert.ok(result.markerY >= 0);
});

test("createClipPlans uses only coordinate-bearing interactions", () => {
  const plans = createClipPlans({
    viewport: { width: 1280, height: 720 },
    video: { width: 1280, height: 720 },
    interactions: [
      { id: 1, type: "mark", tMs: 100 },
      { id: 2, type: "click", tMs: 1000, x: 500, y: 300, selector: "button" }
    ]
  }, {
    preMs: 250,
    postMs: 1000,
    zoom: 1.25
  });

  assert.equal(plans.length, 1);
  assert.equal(plans[0].interactionId, 2);
  assert.equal(plans[0].startMs, 750);
  assert.equal(plans[0].durationMs, 1250);
});

test("createClipPlans derives zoom from interaction contentW", () => {
  const plans = createClipPlans({
    viewport: { width: 1920, height: 1080 },
    video: { width: 1920, height: 1080 },
    interactions: [
      { id: 1, type: "click", tMs: 1000, x: 960, y: 540, contentW: 600 }
    ]
  });

  assert.equal(plans[0].zoom, 3.2);
  assert.equal(plans[0].cropWidth, 600);
});

test("buildFocalLockTransform pins focal point to canvas center at full progress", () => {
  const transform = buildFocalLockTransform({
    width: 1920,
    height: 1080,
    x: 300,
    y: 240,
    zoom: 2.5,
    progress: 1
  });

  assert.equal(Math.round(transform.tx + 300 * transform.scale), 960);
  assert.equal(Math.round(transform.ty + 240 * transform.scale), 540);
});

test("buildFocalLockTransform starts from unshifted full-frame view", () => {
  const start = buildFocalLockTransform({
    width: 1920,
    height: 1080,
    x: 300,
    y: 240,
    zoom: 2.5,
    progress: 0
  });
  const early = buildFocalLockTransform({
    width: 1920,
    height: 1080,
    x: 300,
    y: 240,
    zoom: 2.5,
    progress: 0.05
  });

  assert.equal(start.scale, 1);
  assert.equal(start.tx, 0);
  assert.equal(start.ty, 0);
  assert.ok(Math.abs(early.tx) < 60);
  assert.ok(Math.abs(early.ty) < 40);
});

test("resolveTime can resolve by interaction id or explicit timestamp", () => {
  const metadata = {
    interactions: [
      { id: 1, t: 1234, tMs: 1234 },
      { id: 2, t: 4567, tMs: 4567 }
    ]
  };

  assert.equal(resolveTime(metadata, { interactionId: 2 }), 4567);
  assert.equal(resolveTime(metadata, { atMs: 900 }), 900);
  assert.throws(() => resolveTime(metadata, { interactionId: 99 }), /Interaction not found/);
});

test("resolveTime accepts legacy tMs-only interactions", () => {
  assert.equal(resolveTime({
    interactions: [
      { id: 1, tMs: 3210 }
    ]
  }, { interactionId: 1 }), 3210);
});
