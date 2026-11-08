// Starts and stops an app. Two runners: local processes (default) and Docker (opt-in, POCKETCLOUD_RUNNER=docker).
// The process runner limits memory and scrubs the environment. It is NOT a security sandbox.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFileSync, createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import type { AppConfig } from "./store.ts";

export interface StartSpec { app: AppConfig; codeDir: string; dataDir: string; logPath: string; port: number }
export interface Running {
  pid?: number;
  stop(): Promise<void>;
  exited: Promise<number | null>;
  rssMb(): number | undefined;
}
export interface Runner { name: string; start(spec: StartSpec): Running }

function openLog(path: string): WriteStream {
  const s = createWriteStream(path, { flags: "a" });
  s.write(`\n--- start ${new Date().toISOString()} ---\n`);
  return s;
}

function readRssMb(pid: number): number | undefined {
  // Linux only. Sums the process group's children is out of scope: the shell execs, so this is the app itself
  // except for npm-start style wrappers, which is why we also look at direct children.
  try {
    const kb = (p: number) => Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${p}/status`, "utf8"))?.[1] ?? 0);
    let total = kb(pid);
    try {
      for (const c of readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").split(/\s+/).filter(Boolean)) total += kb(Number(c));
    } catch { /* no children file */ }
    return total / 1024;
  } catch { return undefined; }
}

function kill(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); // whole group: npm start spawns node
    else child.kill(signal);
  } catch { /* already gone */ }
}

export class ProcessRunner implements Runner {
  name = "process";
  start(spec: StartSpec): Running {
    const { app } = spec;
    const log = openLog(spec.logPath);
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: spec.dataDir,
      PORT: String(spec.port),
      DATA_DIR: spec.dataDir,
      POCKETCLOUD_APP: app.name,
      NODE_ENV: "production",
      NODE_OPTIONS: `--max-old-space-size=${Math.max(32, Math.floor(app.memoryMb * 0.75))}`,
      PYTHONPATH: ".pc_deps",
      PYTHONUNBUFFERED: "1",
    };
    const child = spawn(app.command ?? "", { cwd: spec.codeDir, env, shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });
    const exited = new Promise<number | null>((resolve) => child.on("close", (code) => { log.write(`--- exit ${code} ---\n`); log.end(); resolve(code); }));
    child.on("error", (e) => log.write(`spawn error: ${e.message}\n`));
    return {
      pid: child.pid,
      exited,
      rssMb: () => (child.pid ? readRssMb(child.pid) : undefined),
      async stop() {
        kill(child, "SIGTERM");
        const t = setTimeout(() => kill(child, "SIGKILL"), 3000);
        await exited;
        clearTimeout(t);
      },
    };
  }
}

const IMAGES: Record<string, string> = { node: "node:22-alpine", python: "python:3.12-slim", custom: "node:22-alpine" };

/** Runs the app in a container. Written against the Docker CLI but not exercised in CI: needs a Docker daemon. */
export class DockerRunner implements Runner {
  name = "docker";
  start(spec: StartSpec): Running {
    const { app } = spec;
    const log = openLog(spec.logPath);
    const cname = `pocketcloud-${app.name}`;
    const args = [
      "run", "--rm", "--name", cname,
      "-p", `127.0.0.1:${spec.port}:3000`,
      "-v", `${spec.codeDir}:/app:ro`, "-v", `${spec.dataDir}:/data`, "-w", "/app",
      "--memory", `${app.memoryMb}m`, "--cpus", "1", "--pids-limit", "256", "--read-only", "--tmpfs", "/tmp",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "-e", "PORT=3000", "-e", "DATA_DIR=/data", "-e", `POCKETCLOUD_APP=${app.name}`, "-e", "HOME=/data", "-e", "PYTHONPATH=.pc_deps",
      IMAGES[app.stack] ?? IMAGES.node, "sh", "-c", app.command ?? "",
    ];
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });
    const exited = new Promise<number | null>((resolve) => child.on("close", (code) => { log.end(); resolve(code); }));
    return {
      pid: child.pid,
      exited,
      rssMb: () => undefined,
      async stop() {
        spawn("docker", ["stop", "-t", "3", cname], { stdio: "ignore" });
        await exited;
      },
    };
  }
}

export function pickRunner(): Runner {
  return process.env.POCKETCLOUD_RUNNER === "docker" ? new DockerRunner() : new ProcessRunner();
}
