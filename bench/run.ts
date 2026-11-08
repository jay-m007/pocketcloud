// Measures what "sleeps when idle" buys: cold-start time, and memory with apps awake vs asleep.
// Usage: node bench/run.ts [apps=20]
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pack } from "../src/archive.ts";
import { freePort } from "../src/manager.ts";

const N = Number(process.argv[2] ?? 20);
const home = mkdtempSync(join(tmpdir(), "pc-bench-"));
const port = await freePort();
const server = spawn(process.execPath, [join(import.meta.dirname, "../src/cli.ts"), "serve", "--port", String(port)], { env: { ...process.env, POCKETCLOUD_HOME: home }, stdio: ["ignore", "pipe", "inherit"] });
await new Promise<void>((ok) => server.stdout!.on("data", (d: Buffer) => d.toString().includes("running") && ok()));
const token = (JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { adminToken: string }).adminToken;

function call(host: string, path: string, method = "GET", body?: Buffer): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path, method, headers: { host: `${host}:${port}`, authorization: `Bearer ${token}` } }, (res) => {
      const parts: Buffer[] = []; res.on("data", (c: Buffer) => parts.push(c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString() }));
    });
    r.on("error", reject); r.end(body);
  });
}
const rssMb = (pid: number) => Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0) / 1024;
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];

const app = 'import http from "node:http"; http.createServer((q, r) => r.end("ok")).listen(Number(process.env.PORT));';
const dir = mkdtempSync(join(tmpdir(), "pc-bench-app-"));
writeFileSync(join(dir, "server.js"), app);
writeFileSync(join(dir, "package.json"), '{"type":"module","main":"server.js"}');
mkdirSync(join(dir, "public"), { recursive: true });
const tgz = pack(dir);

const names = Array.from({ length: N }, (_, i) => `bench-${i}`);
for (const n of names) await call("localhost", `/__pc/api/deploy?name=${n}&access=public&idle=3600`, "POST", tgz);

const daemonIdle = rssMb(server.pid!);
const cold: number[] = [];
for (const n of names) { const t = Date.now(); const r = await call(`${n}.localhost`, "/"); if (r.status !== 200) throw new Error(`${n} answered ${r.status}`); cold.push(Date.now() - t); }
const warm: number[] = [];
for (let i = 0; i < 200; i++) { const t = performance.now(); await call(`${names[i % N]}.localhost`, "/"); warm.push(performance.now() - t); }
const apps = ((await call("localhost", "/__pc/api/apps")).body);
const awakeCount = (JSON.parse(apps) as { status: string }[]).filter((a) => a.status === "running").length;
const awakeTotal = (() => { // daemon + every child process of the daemon
  let total = rssMb(server.pid!);
  const kids = readFileSync(`/proc/${server.pid}/task/${server.pid}/children`, "utf8").split(/\s+/).filter(Boolean).map(Number);
  const walk = (pid: number): number[] => { try { return [pid, ...readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").split(/\s+/).filter(Boolean).map(Number).flatMap(walk)]; } catch { return [pid]; } };
  for (const k of kids) for (const p of walk(k)) total += rssMb(p);
  return total;
})();
for (const n of names) await call("localhost", `/__pc/api/apps/${n}/stop`, "POST");
const asleepTotal = rssMb(server.pid!);

const result = {
  apps: N, appsAwake: awakeCount,
  coldStartMs: { p50: pct(cold, 0.5), p95: pct(cold, 0.95), max: Math.max(...cold) },
  warmRequestMs: { p50: +pct(warm, 0.5).toFixed(2), p95: +pct(warm, 0.95).toFixed(2) },
  memoryMb: { daemonWithNoApps: +daemonIdle.toFixed(1), allAwake: +awakeTotal.toFixed(1), allAsleep: +asleepTotal.toFixed(1), perAwakeApp: +((awakeTotal - daemonIdle) / N).toFixed(1) },
  node: process.version, cpus: (await import("node:os")).cpus().length,
};
console.log(JSON.stringify(result, null, 2));
server.kill("SIGTERM");
