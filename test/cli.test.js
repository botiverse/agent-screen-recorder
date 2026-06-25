import test from "node:test";
import assert from "node:assert/strict";
import { findMatchingDisplay, findMatchingWindow } from "../src/cli.js";

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
