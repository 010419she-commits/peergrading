// Launch the GUI directly on Windows, macOS and Linux, including from a Node-mode Electron parent.
const { spawn } = require("node:child_process");
const path = require("node:path");
const electron = require("electron");

const args = process.argv.slice(2);
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.toUpperCase() === "ELECTRON_RUN_AS_NODE") delete env[key];
}
if (args[0] === "--local-cloud") {
  args.shift();
  env.CLOUD_URL = "http://localhost:3001";
}
const child = spawn(electron, [path.resolve(__dirname, ".."), ...args], {
  env, stdio: "inherit", shell: false,
});
child.on("error", (error) => {
  console.error(`Unable to start PeerGrading: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
