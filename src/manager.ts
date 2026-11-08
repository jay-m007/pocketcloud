// Keeps track of which apps are running. Starts an app on its first request, stops it after it has been idle,
// and kills it if it grows past its memory limit.
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { createServer, connect } from "node:net";
import { readApp, codeDir, dataDir, logFile } from "./store.ts";
import type { AppConfig } from "./store.ts";
import type { Runner, Running } from "./runner.ts";

export interface AppState {
  status: "stopped" | "starting" | "running";
  port?: number;
  running?: Running;
  config?: AppConfig;
  lastHit: number;
  inflight: number;
  coldStartsMs: number[];
  starting?: Promise<number>;
  lastError?: string;
}

export interface ManagerOptions { startTimeoutMs?: number; idleCheckMs?: number }

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const c = connect(port, "127.0.0.1");
    c.once("connect", () => { c.destroy(); resolve(true); });
    c.once("error", () => resolve(false));
  });
}

export function tailLog(path: string, bytes = 4000): string {
  if (!existsSync(path)) return "";
  const text = readFileSync(path, "utf8");
  return text.length > bytes ? text.slice(-bytes) : text;
}

export class Manager {
  root: string;
  runner: Runner;
  states = new Map<string, AppState>();
  private timer?: NodeJS.Timeout;
  private startTimeoutMs: number;

  constructor(root: string, runner: Runner, opts: ManagerOptions = {}) {
    this.root = root;
    this.runner = runner;
    this.startTimeoutMs = opts.startTimeoutMs ?? 30000;
    this.timer = setInterval(() => void this.sweep(), opts.idleCheckMs ?? 5000);
    this.timer.unref();
  }

  state(name: string): AppState {
    let s = this.states.get(name);
    if (!s) { s = { status: "stopped", lastHit: 0, inflight: 0, coldStartsMs: [] }; this.states.set(name, s); }
    return s;
  }

  begin(name: string): void { const s = this.state(name); s.inflight++; s.lastHit = Date.now(); }
  end(name: string): void { const s = this.state(name); s.inflight = Math.max(0, s.inflight - 1); s.lastHit = Date.now(); }

  /** Makes sure the app is running and returns its port. Concurrent callers share one start. */
  ensure(name: string): Promise<number> {
    const s = this.state(name);
    s.lastHit = Date.now();
    if (s.status === "running" && s.port) return Promise.resolve(s.port);
    if (s.starting) return s.starting;
    s.starting = this.startApp(name, s).finally(() => { s.starting = undefined; });
    return s.starting;
  }

  private async startApp(name: string, s: AppState): Promise<number> {
    const config = readApp(this.root, name);
    if (!config) throw new Error(`No app called ${name}.`);
    if (config.stack === "static" || !config.command) throw new Error(`${name} is a static site and has no process to start.`);
    const t0 = Date.now();
    const port = await freePort();
    const running = this.runner.start({ app: config, codeDir: codeDir(this.root, name), dataDir: dataDir(this.root, name), logPath: logFile(this.root, name), port });
    s.status = "starting"; s.running = running; s.port = port; s.config = config; s.lastError = undefined;
    let exitedEarly: number | null | undefined;
    let exitedFlag = false;
    void running.exited.then((code) => {
      exitedFlag = true; exitedEarly = code;
      if (s.running === running) { s.status = "stopped"; s.running = undefined; s.port = undefined; }
    });
    for (;;) {
      if (exitedFlag) {
        s.lastError = `The app exited with code ${exitedEarly} before it started listening on $PORT.`;
        throw new Error(s.lastError);
      }
      if (await canConnect(port)) break;
      if (Date.now() - t0 > this.startTimeoutMs) {
        await running.stop();
        s.lastError = `The app did not listen on $PORT (${port}) within ${this.startTimeoutMs / 1000} s.`;
        throw new Error(s.lastError);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    s.status = "running";
    s.coldStartsMs.push(Date.now() - t0);
    if (s.coldStartsMs.length > 50) s.coldStartsMs.shift();
    return port;
  }

  async stop(name: string): Promise<void> {
    const s = this.states.get(name);
    if (!s?.running) return;
    const r = s.running;
    s.running = undefined; s.status = "stopped"; s.port = undefined;
    await r.stop();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.states.keys()].map((n) => this.stop(n)));
  }

  dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    return this.stopAll();
  }

  /** One pass of the idle and memory checks. Exposed so tests can call it directly. */
  async sweep(): Promise<void> {
    const now = Date.now();
    for (const [name, s] of this.states) {
      if (s.status !== "running" || !s.running || !s.config) continue;
      const rss = s.running.rssMb();
      if (rss !== undefined && rss > s.config.memoryMb) {
        const msg = `Stopped: using ${Math.round(rss)} MB, over the ${s.config.memoryMb} MB limit.`;
        try { appendFileSync(logFile(this.root, name), `--- ${msg} ---\n`); } catch { /* log folder may be gone */ }
        s.lastError = msg;
        await this.stop(name);
        continue;
      }
      if (s.inflight === 0 && now - s.lastHit > s.config.idleSeconds * 1000) await this.stop(name);
    }
  }
}
