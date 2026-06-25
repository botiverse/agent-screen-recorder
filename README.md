# Agent Screen Recorder

CLI-first screen recording and demo rendering tool for Raft agents.

The v0 design follows one principle: when an agent drives UI with Playwright, the interaction metadata is ground truth. The recorder should capture video and metadata together, then use that metadata for QA evidence, trimming, zoom, and annotations.

## Current Scope

- `run`: execute a Playwright scenario and save `raw.webm` plus `metadata.json`.
- `windows` / `displays`: list native macOS capture targets.
- `start` / `stop`: record a native macOS window or display in the background.
- `frame`: extract a PNG frame by timestamp or interaction id.
- `render`: create an interaction-focused MP4/GIF-friendly video by trimming idle time and zooming to recorded click coordinates.
- `inspect`: print a concise summary of a recording.

There are three first-class v0 capture paths:

- Browser/webapp: deterministic Playwright recording plus ground-truth interaction metadata.
- Native macOS window: ScreenCaptureKit-based window recording for Electron, menu bar apps, and Raft Computer flows that Playwright cannot see.
- Full desktop/display: ScreenCaptureKit-based display recording for multi-window, OAuth callback, system prompt, and desktop-wide QA flows.

## Install

```bash
pnpm install
pnpm exec playwright install chromium
pnpm native:build
```

## Record A Scenario

```bash
pnpm cli -- run \
  --name qa-login-flow \
  --url http://localhost:3000 \
  --scenario examples/basic-scenario.mjs \
  --out recordings \
  --headed
```

The scenario module receives `{ page, recorder, metadata }`. Use `recorder.click()`, `recorder.fill()`, and `recorder.press()` instead of direct page actions when you want ground-truth metadata.

Path A pins Playwright to `deviceScaleFactor: 1`, default `viewport: 1920x1080`, and `recordVideo.size: 1920x1080`, so CSS pixels match video pixels. Override `--width`, `--height`, or `--device-scale-factor` only when you also update downstream coordinate checks.

For per-click zoom framing, pass `contentW`:

```js
await recorder.click("#send", { label: "send", contentW: 600 });
```

## Record A Native macOS Window

```bash
pnpm cli -- windows

pnpm cli -- start \
  --window "Raft Computer" \
  --out recordings

# perform the native app flow

pnpm cli -- stop

pnpm cli -- package \
  --input recordings/<run>/native-window.mp4 \
  --out recordings/<run>/upload.mp4
```

The native path uses ScreenCaptureKit and requires macOS Screen Recording permission for the terminal/app launching the CLI.

Path B lifecycle guarantees:

- `start` validates that the requested window exists before writing a session.
- Only one native recording session can be active; a second `start` fails instead of overwriting `.agent-recorder-session.json`.
- If the target window closes or ScreenCaptureKit stops unexpectedly after frames were captured, the recorder finalizes the MP4 before exit so the file keeps its `moov` atom.
- `stop` waits for native finalization when the recorder is still running, cleans stale sessions when the PID has already exited, and returns human-readable errors for no-session/dead-session cases.

## Record Full Desktop / Display

```bash
pnpm cli -- displays

pnpm cli -- start \
  --full-desktop \
  --out recordings

# or target a listed display explicitly
pnpm cli -- start \
  --display main \
  --out recordings

# perform the multi-window or desktop-wide flow

pnpm cli -- stop

pnpm cli -- package \
  --input recordings/<run>/desktop.mp4 \
  --out recordings/<run>/upload.mp4
```

Path C uses the same native session lifecycle as Path B. It validates that the requested display exists before writing a session, rejects a second active `start`, finalizes the MP4 on `stop`, and packages the result through the same upload-friendly MP4 path. Treat Path C as required v0 coverage for flows where the useful evidence spans multiple windows or system UI instead of one app window.

## Extract A QA Frame

```bash
pnpm cli -- frame \
  --recording recordings/qa-login-flow-2026-06-25T10-00-00-000Z \
  --interaction 1 \
  --out frame.png
```

## Render A Demo Clip

```bash
pnpm cli -- render \
  --recording recordings/qa-login-flow-2026-06-25T10-00-00-000Z \
  --out demo.mp4 \
  --pre-ms 700 \
  --post-ms 1600 \
  --zoom 1.35
```

## Metadata Contract

`metadata.json` contains:

- `schemaVersion`
- `runId`, `name`, `startedAt`, `endedAt`
- `viewport`
- `video.rawPath`
- `interactions[]` with `id`, `type`, `t` in milliseconds from `recordVideo.clockOrigin`, `tMs` as a backward-compatible alias, `selector`, `label`, `x`, `y`, and optional element box metadata

The metadata is the durable contract for future Raft CLI integration and a human review app.

## Path A Acceptance Checklist

- Coordinate space is 1:1: `deviceScaleFactor` is `1`, `viewport` equals `recordVideo.size`, and a click `(x,y)` lands on the clicked element center in the matching video frame.
- Timestamp alignment: extracting a frame by interaction id lands near the click moment, not more than roughly 300 ms early or late.
- Zoom focal point: `render` uses the same recorded coordinate as the zoom target. The pure focal-lock invariant is covered by `buildFocalLockTransform()` tests.
- Interaction marker: v0 renders a fixed red marker over the recorded click coordinate. A full Remotion-style ripple is not implemented yet.
- ROI width: use `contentW` per interaction to avoid over-zooming and cutting off wide content.

Relevant files:

- Playwright wrapper and metadata contract: `src/recorder.js`
- Frame extraction, content-width zoom, focal-lock math, and FFmpeg render path: `src/render.js`
- Focal-lock/content-width tests: `test/render.test.js`
