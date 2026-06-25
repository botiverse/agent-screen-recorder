import test from "node:test";
import assert from "node:assert/strict";
import { findMatchingDisplay, findMatchingWindow } from "../src/cli.js";
import { buildTileLayout, normalizeTileQueries } from "../src/layout.js";

test("findMatchingWindow matches title or app name case-insensitively", () => {
  const windows = [
    { title: "Inbox", app: "Mail" },
    { title: "Onboarding", app: "Raft Desktop" }
  ];

  assert.deepEqual(findMatchingWindow(windows, "raft"), windows[1]);
  assert.deepEqual(findMatchingWindow(windows, "onboard"), windows[1]);
  assert.equal(findMatchingWindow(windows, "missing"), undefined);
});

test("findMatchingDisplay resolves main, index, id, and label", () => {
  const displays = [
    { index: 1, id: 111, label: "main", isMain: true },
    { index: 2, id: 222, label: "display-2", isMain: false }
  ];

  assert.deepEqual(findMatchingDisplay(displays, "main"), displays[0]);
  assert.deepEqual(findMatchingDisplay(displays, "primary"), displays[0]);
  assert.deepEqual(findMatchingDisplay(displays, "2"), displays[1]);
  assert.deepEqual(findMatchingDisplay(displays, "222"), displays[1]);
  assert.deepEqual(findMatchingDisplay(displays, "display-2"), displays[1]);
  assert.equal(findMatchingDisplay(displays, "missing"), undefined);
});

test("normalizeTileQueries accepts variadic and repeated tile args", () => {
  assert.deepEqual(normalizeTileQueries("Raft Desktop"), ["Raft Desktop"]);
  assert.deepEqual(normalizeTileQueries([["Raft Desktop", "Google Chrome"], "Finder"]), [
    "Raft Desktop",
    "Google Chrome",
    "Finder"
  ]);
  assert.deepEqual(normalizeTileQueries(true), []);
});

test("buildTileLayout creates a two-up layout", () => {
  const layout = buildTileLayout({
    queries: ["Raft Desktop", "Google Chrome"],
    desktopBounds: { x: 0, y: 0, width: 1200, height: 800 },
    margin: 20,
    gap: 10
  });

  assert.deepEqual(layout, [
    { query: "Raft Desktop", bounds: { x: 20, y: 20, width: 575, height: 760 } },
    { query: "Google Chrome", bounds: { x: 605, y: 20, width: 575, height: 760 } }
  ]);
});

test("buildTileLayout creates a three-up proof layout", () => {
  const layout = buildTileLayout({
    queries: ["Raft Desktop", "Google Chrome", "System Settings"],
    desktopBounds: { x: 0, y: 0, width: 1200, height: 800 },
    margin: 20,
    gap: 10
  });

  assert.deepEqual(layout, [
    { query: "Raft Desktop", bounds: { x: 20, y: 20, width: 575, height: 760 } },
    { query: "Google Chrome", bounds: { x: 605, y: 20, width: 575, height: 375 } },
    { query: "System Settings", bounds: { x: 605, y: 405, width: 575, height: 375 } }
  ]);
});
