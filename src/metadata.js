import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function safeSlug(input) {
  return String(input || "recording")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "recording";
}

export function isoStamp(date = new Date()) {
  return date.toISOString().replace(/[:]/g, "-");
}

export function createRunId(name, date = new Date()) {
  return `${safeSlug(name)}-${isoStamp(date)}`;
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

export async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function relativeTo(baseDir, filePath) {
  return path.relative(baseDir, filePath).split(path.sep).join("/");
}

