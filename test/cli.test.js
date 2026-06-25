import test from "node:test";
import assert from "node:assert/strict";
import { findMatchingWindow } from "../src/cli.js";

test("findMatchingWindow matches title or app name case-insensitively", () => {
  const windows = [
    { title: "Inbox", app: "Mail" },
    { title: "Onboarding", app: "Raft Desktop" }
  ];

  assert.deepEqual(findMatchingWindow(windows, "raft"), windows[1]);
  assert.deepEqual(findMatchingWindow(windows, "onboard"), windows[1]);
  assert.equal(findMatchingWindow(windows, "missing"), undefined);
});
