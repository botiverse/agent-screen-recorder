import test from "node:test";
import assert from "node:assert/strict";
import { createInteractionRecorder } from "../src/recorder.js";

test("interaction metadata records a ground-truth t timestamp", async () => {
  const metadata = { interactions: [] };
  const recorder = createInteractionRecorder({}, metadata, performance.now() - 250);

  const interaction = await recorder.mark("checkpoint");

  assert.equal(interaction.id, 1);
  assert.equal(interaction.t, interaction.tMs);
  assert.ok(Number.isFinite(interaction.t));
  assert.ok(interaction.t >= 0);
  assert.equal(metadata.interactions[0], interaction);

  const manual = recorder.log({ type: "mark", t: null, tMs: null });
  assert.equal(manual.id, 2);
  assert.equal(manual.t, manual.tMs);
  assert.ok(Number.isFinite(manual.t));
});
