const { spawnSync } = require("node:child_process");

function run(cmd, args) {
  return spawnSync(cmd, args, { stdio: "inherit", shell: false });
}

const tauriResult = run("tauri", ["build"]);
if (tauriResult.status === 0) {
  process.exit(0);
}

if (tauriResult.error?.code !== "ENOENT") {
  process.exit(tauriResult.status ?? 1);
}

console.warn("tauri CLI not available. Falling back to cargo build for src-tauri.");
const cargoResult = run("cargo", ["build", "--manifest-path", "src-tauri/Cargo.toml"]);
process.exit(cargoResult.status ?? 1);
