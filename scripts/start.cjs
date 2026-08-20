const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const root = process.cwd();
const distIndex = path.join(root, "dist", "index.html");
const distServer = path.join(root, "dist", "server.cjs");

function buildIfNeeded() {
  if (fs.existsSync(distIndex) && fs.existsSync(distServer)) return;

  console.log("Production build is missing. Running npm run build before startup...");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["run", "build"], {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    console.error("Could not start the application because the build command failed to start:", result.error);
    process.exit(1);
  }

  if (result.status !== 0 || !fs.existsSync(distIndex) || !fs.existsSync(distServer)) {
    console.error("Production build did not create the required files:");
    console.error(`- ${distIndex}`);
    console.error(`- ${distServer}`);
    process.exit(result.status || 1);
  }
}

buildIfNeeded();

const child = spawn(process.execPath, [distServer], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

child.on("error", (error) => {
  console.error("Failed to start production server:", error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
