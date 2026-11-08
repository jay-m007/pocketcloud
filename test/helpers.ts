import http from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pack } from "../src/archive.ts";
import { startServer } from "../src/server.ts";
import type { Running, ServerOptions } from "../src/server.ts";

export async function boot(opts: Partial<ServerOptions> = {}): Promise<Running> {
  const root = mkdtempSync(join(tmpdir(), "pocketcloud-test-"));
  return startServer({ root, port: 0, idleCheckMs: 100, ...opts });
}

export function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pocketcloud-app-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

export interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

export function request(port: number, host: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: { host: `${host}:${port}`, ...init.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(init.body);
  });
}

export async function deploy(s: Running, name: string, dir: string, query = ""): Promise<Reply> {
  return request(s.port, "localhost", `/__pc/api/deploy?name=${name}${query}`, { method: "POST", headers: { authorization: `Bearer ${s.adminToken}` }, body: pack(dir) });
}

export async function admin(s: Running, method: string, path: string, body?: unknown): Promise<Reply> {
  return request(s.port, "localhost", path, { method, headers: { authorization: `Bearer ${s.adminToken}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const NODE_APP = `
import http from "node:http";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const file = process.env.DATA_DIR + "/count.txt";
const n = (existsSync(file) ? Number(readFileSync(file, "utf8")) : 0) + 1;
writeFileSync(file, String(n));
http.createServer((req, res) => { res.end("hello from " + process.env.POCKETCLOUD_APP + " start #" + n + " cookie=" + (req.headers.cookie ?? "") + " auth=" + (req.headers.authorization ?? "")); }).listen(Number(process.env.PORT));
`;
