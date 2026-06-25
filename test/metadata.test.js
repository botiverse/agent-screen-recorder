import test from "node:test";
import assert from "node:assert/strict";
import { createRunId, safeSlug } from "../src/metadata.js";

test("safeSlug creates filesystem-safe names", () => {
  assert.equal(safeSlug("PR #123: Login Flow QA"), "pr-123-login-flow-qa");
  assert.equal(safeSlug(""), "recording");
});

test("createRunId prefixes timestamp with safe name", () => {
  const id = createRunId("Demo Run", new Date("2026-06-25T10:00:00.000Z"));
  assert.equal(id, "demo-run-2026-06-25T10-00-00.000Z");
});

