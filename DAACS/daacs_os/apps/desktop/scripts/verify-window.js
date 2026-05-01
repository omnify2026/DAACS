const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const appBundle =
  process.env.DAACS_DESKTOP_APP_BUNDLE ||
  path.resolve(__dirname, "../../../../target/release/bundle/macos/DAACS OS.app");

const swiftSource = `
import CoreGraphics
import Foundation

func number(_ value: Any?) -> Double {
  if let value = value as? NSNumber { return value.doubleValue }
  if let value = value as? Double { return value }
  if let value = value as? Int { return Double(value) }
  return 0
}

let windows = (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]]) ?? []
var matches: [[String: Any]] = []

for window in windows {
  let owner = window[kCGWindowOwnerName as String] as? String ?? ""
  let name = window[kCGWindowName as String] as? String ?? ""
  let onscreenValue = window[kCGWindowIsOnscreen as String]
  let onscreen = (onscreenValue as? NSNumber)?.intValue == 1 || (onscreenValue as? Bool) == true
  let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
  let width = number(bounds["Width"])
  let height = number(bounds["Height"])

  if (owner == "DAACS OS" || owner == "daacs_desktop") && name == "DAACS OS" && onscreen && width > 100 && height > 100 {
    matches.append([
      "owner": owner,
      "name": name,
      "pid": number(window[kCGWindowOwnerPID as String]),
      "windowId": number(window[kCGWindowNumber as String]),
      "x": number(bounds["X"]),
      "y": number(bounds["Y"]),
      "width": width,
      "height": height
    ])
  }
}

let data = try JSONSerialization.data(withJSONObject: ["windows": matches], options: [])
print(String(data: data, encoding: .utf8)!)
`;

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    shell: false,
    ...options,
  });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function listRunningPids() {
  const result = run("pgrep", ["-x", "daacs_desktop"]);
  if (result.status !== 0 || !result.stdout.trim()) {
    return new Set();
  }

  return new Set(
    result.stdout
      .trim()
      .split(/\s+/)
      .map((pid) => Number.parseInt(pid, 10))
      .filter(Number.isFinite),
  );
}

function findDesktopWindows() {
  const result = run("swift", ["-"], { input: swiftSource });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Swift CoreGraphics probe failed.");
  }

  const output = result.stdout.trim();
  if (!output) {
    return [];
  }

  const parsed = JSON.parse(output);
  return Array.isArray(parsed.windows) ? parsed.windows : [];
}

if (process.platform !== "darwin") {
  console.log("DAACS desktop window smoke is macOS-only. Skipping.");
  process.exit(0);
}

if (!fs.existsSync(appBundle)) {
  console.error(`Missing DAACS app bundle: ${appBundle}`);
  console.error("Run `npm run build` from DAACS_OS/apps/desktop first.");
  process.exit(1);
}

const existingPids = listRunningPids();
const openResult = run("open", [appBundle]);
if (openResult.status !== 0) {
  console.error(openResult.stderr.trim() || `Failed to open ${appBundle}`);
  process.exit(openResult.status ?? 1);
}

let windows = [];
let probeError = null;
const deadline = Date.now() + 15_000;

while (Date.now() < deadline) {
  try {
    windows = findDesktopWindows();
    if (windows.length > 0) {
      break;
    }
  } catch (error) {
    probeError = error;
  }
  sleep(500);
}

if (windows.length === 0) {
  if (probeError) {
    console.error(`Window probe failed: ${probeError.message}`);
  }
  console.error("DAACS OS did not expose an onscreen CoreGraphics window in time.");
  process.exit(1);
}

const window = windows[0];
console.log(
  `DAACS desktop window detected: pid=${Math.round(window.pid)} window=${Math.round(
    window.windowId,
  )} bounds=${Math.round(window.width)}x${Math.round(window.height)}+${Math.round(
    window.x,
  )}+${Math.round(window.y)}`,
);

if (process.env.DAACS_KEEP_DESKTOP_APP !== "1") {
  const pid = Math.round(window.pid);
  if (Number.isFinite(pid) && pid > 0 && !existingPids.has(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Best-effort cleanup only. A failed kill should not invalidate the smoke.
    }
  }
}
