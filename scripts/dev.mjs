// Starts api, worker and web together, prefixing each line with the app name.
// Needs PostgreSQL and Redis first: `npm run db:up`.
import { spawn } from "node:child_process";

const apps = ["api", "worker", "web"];
const children = [];
let stopping = false;

function pipe(stream, name, target) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) target.write(`[${name}] ${line}\n`);
  });
}

function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (process.platform === "win32") {
      // `shell: true` wraps npm in cmd.exe; kill the whole process tree.
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill();
    }
  }
  setTimeout(() => process.exit(code), 500);
}

for (const name of apps) {
  const child = spawn("npm", ["run", "dev", "-w", `@ai-pr-review/${name}`], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });
  pipe(child.stdout, name, process.stdout);
  pipe(child.stderr, name, process.stderr);
  child.on("exit", (code) => {
    if (!stopping) {
      console.error(`[dev] ${name} exited with code ${code}; stopping the others.`);
      stopAll(code ?? 1);
    }
  });
  children.push(child);
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
