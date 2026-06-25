import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

export function normalizeTileQueries(value) {
  if (value === undefined || value === null || value === false) {
    return [];
  }
  const values = Array.isArray(value) ? value.flat() : [value];
  return values
    .filter((entry) => entry !== true && entry !== false && entry !== undefined && entry !== null)
    .map((entry) => String(entry).trim())
    .filter(Boolean);
}

export function buildTileLayout({ queries, desktopBounds, preset = "auto", margin = 24, gap = 16 }) {
  const tiles = normalizeTileQueries(queries);
  if (tiles.length === 0) {
    throw new Error("Provide at least one --tile window query");
  }
  const bounds = normalizeBounds(desktopBounds);
  const safeMargin = Math.max(0, Number(margin) || 0);
  const safeGap = Math.max(0, Number(gap) || 0);
  const inner = {
    x: bounds.x + safeMargin,
    y: bounds.y + safeMargin,
    width: Math.max(1, bounds.width - safeMargin * 2),
    height: Math.max(1, bounds.height - safeMargin * 2)
  };

  if (tiles.length === 1) {
    return [{
      query: tiles[0],
      bounds: roundBounds(inner)
    }];
  }

  if (tiles.length === 2) {
    const width = Math.floor((inner.width - safeGap) / 2);
    return tiles.map((query, index) => ({
      query,
      bounds: roundBounds({
        x: inner.x + index * (width + safeGap),
        y: inner.y,
        width,
        height: inner.height
      })
    }));
  }

  if (tiles.length === 3) {
    const leftWidth = Math.floor((inner.width - safeGap) / 2);
    const rightWidth = inner.width - leftWidth - safeGap;
    const rightHeight = Math.floor((inner.height - safeGap) / 2);
    return [
      {
        query: tiles[0],
        bounds: roundBounds({
          x: inner.x,
          y: inner.y,
          width: leftWidth,
          height: inner.height
        })
      },
      {
        query: tiles[1],
        bounds: roundBounds({
          x: inner.x + leftWidth + safeGap,
          y: inner.y,
          width: rightWidth,
          height: rightHeight
        })
      },
      {
        query: tiles[2],
        bounds: roundBounds({
          x: inner.x + leftWidth + safeGap,
          y: inner.y + rightHeight + safeGap,
          width: rightWidth,
          height: inner.height - rightHeight - safeGap
        })
      }
    ];
  }

  const columns = Math.ceil(Math.sqrt(tiles.length));
  const rows = Math.ceil(tiles.length / columns);
  const cellWidth = Math.floor((inner.width - safeGap * (columns - 1)) / columns);
  const cellHeight = Math.floor((inner.height - safeGap * (rows - 1)) / rows);

  return tiles.map((query, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      query,
      bounds: roundBounds({
        x: inner.x + column * (cellWidth + safeGap),
        y: inner.y + row * (cellHeight + safeGap),
        width: cellWidth,
        height: cellHeight
      })
    };
  });
}

export async function applyTiledWindowLayout(queries, options = {}) {
  const desktopBounds = options.desktopBounds || await readDesktopBounds();
  const plan = buildTileLayout({
    queries,
    desktopBounds,
    preset: options.preset,
    margin: options.margin,
    gap: options.gap
  });
  const windows = [];
  for (const tile of plan) {
    const result = await moveWindow(tile.query, tile.bounds);
    windows.push({
      query: tile.query,
      app: result.app,
      title: result.title,
      requestedBounds: tile.bounds,
      actualBounds: result.bounds
    });
  }
  return {
    preset: plan.length === 2 ? "two-up" : plan.length === 3 ? "three-up" : "grid",
    requestedAt: new Date().toISOString(),
    desktopBounds,
    windows
  };
}

export function buildLayoutConfig(options) {
  return {
    queries: normalizeTileQueries(options.tileQueries || options.queries),
    preset: options.preset || "auto",
    margin: Number(options.margin ?? 24),
    gap: Number(options.gap ?? 16),
    intervalMs: Math.max(250, Number(options.intervalMs || 750)),
    statePath: options.statePath
  };
}

export async function readLayoutState(statePath) {
  if (!statePath) {
    return null;
  }
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeLayoutState(statePath, state) {
  if (!statePath) {
    return;
  }
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function readDesktopBounds() {
  const output = await runOsascript(`tell application "Finder" to get bounds of window of desktop`);
  const numbers = output.trim().split(/[^0-9.-]+/).filter(Boolean).map(Number);
  if (numbers.length < 4 || numbers.some((number) => !Number.isFinite(number))) {
    throw new Error(`Could not read desktop bounds from Finder output: ${output}`);
  }
  const [left, top, right, bottom] = numbers;
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };
}

async function moveWindow(query, bounds) {
  const script = `
set q to ${appleScriptString(query)}
set targetX to ${Math.round(bounds.x)}
set targetY to ${Math.round(bounds.y)}
set targetW to ${Math.round(bounds.width)}
set targetH to ${Math.round(bounds.height)}

tell application "System Events"
  repeat with p in application processes
    set procName to name of p as text
    try
      repeat with w in windows of p
        set winName to name of w as text
        ignoring case
          if procName contains q or winName contains q then
            set frontmost of p to true
            set position of w to {targetX, targetY}
            set size of w to {targetW, targetH}
            delay 0.05
            set actualPos to position of w
            set actualSize to size of w
            return procName & tab & winName & tab & (item 1 of actualPos as text) & tab & (item 2 of actualPos as text) & tab & (item 1 of actualSize as text) & tab & (item 2 of actualSize as text)
          end if
        end ignoring
      end repeat
    end try
  end repeat
end tell

return "__NOT_FOUND__" & tab & q
`;
  const output = await runOsascript(script);
  const parts = output.trim().split("\t");
  if (parts[0] === "__NOT_FOUND__") {
    throw new Error(`No accessibility window matched tile query: ${query}`);
  }
  if (parts.length < 6) {
    throw new Error(`Unexpected osascript window layout output: ${output}`);
  }
  return {
    app: parts[0],
    title: parts[1],
    bounds: {
      x: Number(parts[2]),
      y: Number(parts[3]),
      width: Number(parts[4]),
      height: Number(parts[5])
    }
  };
}

function runOsascript(script) {
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
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
        resolve(stdout);
      } else {
        reject(new Error(`osascript exited with code ${code}${stderr ? `\n${stderr}` : ""}`));
      }
    });
  });
}

function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function normalizeBounds(bounds) {
  return {
    x: Number(bounds?.x || 0),
    y: Number(bounds?.y || 0),
    width: Math.max(1, Number(bounds?.width || 1)),
    height: Math.max(1, Number(bounds?.height || 1))
  };
}

function roundBounds(bounds) {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  };
}
