// The one HTTP server: a control API for the CLI, and a reverse proxy that wakes apps on demand.
//   http://<domain>:<port>/__pc/api/...   control API (admin token)
//   http://<app>.<domain>:<port>/         the app (private apps need an invite cookie)
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { extname, join, normalize, resolve, sep } from "node:path";
import { MAX_UPLOAD, unpack } from "./archive.ts";
import { detect } from "./detect.ts";
import { Manager, tailLog } from "./manager.ts";
import { pickRunner } from "./runner.ts";
import type { Runner } from "./runner.ts";
import {
  NAME_RE, appDir, codeDir, listApps, loadConfig, logFile, newToken, readApp, readInvites, sha256, writeApp, writeInvites,
} from "./store.ts";
import type { Access, AppConfig } from "./store.ts";

export interface ServerOptions {
  root: string;
  port?: number;
  host?: string;
  domain?: string; // apps live at <name>.<domain>
  scheme?: "http" | "https"; // what the public URL looks like (set https when behind a TLS proxy)
  runner?: Runner;
  idleCheckMs?: number;
  startTimeoutMs?: number;
}

export interface Running {
  server: http.Server;
  manager: Manager;
  port: number;
  adminToken: string;
  domain: string;
  close(): Promise<void>;
}

const COOKIE = "pc_session";
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2", ".wasm": "application/wasm",
};

function esc(s: string): string { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!); }

function page(res: ServerResponse, status: number, title: string, body: string, extra: Record<string, string> = {}): void {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1rem;color:#222}pre{background:#f3f3f3;padding:.75rem;overflow:auto;font-size:13px;border-radius:6px}@media(prefers-color-scheme:dark){body{background:#151515;color:#ddd}pre{background:#222}}</style>
<h1>${esc(title)}</h1>${body}`;
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...extra });
  res.end(html);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error("Upload is too large.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieOf(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

export async function startServer(opts: ServerOptions): Promise<Running> {
  const root = resolve(opts.root);
  const domain = (opts.domain ?? "localhost").toLowerCase();
  const scheme = opts.scheme ?? "http";
  const cfg = loadConfig(root);
  const manager = new Manager(root, opts.runner ?? pickRunner(), { idleCheckMs: opts.idleCheckMs, startTimeoutMs: opts.startTimeoutMs });

  const isAdmin = (req: IncomingMessage): boolean => {
    const h = req.headers.authorization ?? "";
    return h.startsWith("Bearer ") && sameToken(h.slice(7), cfg.adminToken);
  };
  const hasInvite = (req: IncomingMessage, name: string): boolean => {
    const t = cookieOf(req, COOKIE);
    if (!t) return false;
    const h = sha256(t);
    return readInvites(root, name).some((i) => i.hash === h);
  };
  const hostOf = (req: IncomingMessage) => (req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
  const appNameOf = (req: IncomingMessage): string | undefined => {
    const host = hostOf(req);
    return host.endsWith("." + domain) ? host.slice(0, -(domain.length + 1)) : undefined;
  };
  const portSuffix = (req: IncomingMessage) => /:\d+$/.exec(req.headers.host ?? "")?.[0] ?? "";

  // ---- deploy ----
  function deploy(name: string, body: Buffer, params: URLSearchParams): Record<string, unknown> {
    const dir = appDir(root, name);
    const staging = join(dir, "code.new");
    mkdirSync(dir, { recursive: true });
    rmSync(staging, { recursive: true, force: true });
    try {
      unpack(body, staging);
      const d = detect(staging);
      if (d.install) {
        const [cmd, ...args] = d.install;
        const r = spawnSync(cmd, args, { cwd: staging, encoding: "utf8", timeout: 300000 });
        if (r.status !== 0) throw new Error(`Installing dependencies failed:\n${(r.stderr || r.stdout || String(r.error)).slice(-1500)}`);
      }
      const prev = readApp(root, name);
      const access = (params.get("access") ?? prev?.access ?? "private") as Access;
      if (access !== "private" && access !== "public") throw new Error('access must be "private" or "public".');
      const num = (key: string, fallback: number, min: number, max: number) => {
        const raw = params.get(key);
        if (raw === null) return fallback;
        const v = Number(raw);
        if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${key} must be a number from ${min} to ${max}.`);
        return v;
      };
      const app: AppConfig = {
        name, access, stack: d.stack, command: d.command,
        idleSeconds: num("idle", prev?.idleSeconds ?? 300, 1, 86400),
        memoryMb: num("memory", prev?.memoryMb ?? 256, 32, 8192),
        deployedAt: new Date().toISOString(),
      };
      return { app, swap: () => { rmSync(codeDir(root, name), { recursive: true, force: true }); renameSync(staging, codeDir(root, name)); writeApp(root, app); } };
    } catch (e) {
      rmSync(staging, { recursive: true, force: true });
      throw e;
    }
  }

  // ---- control API ----
  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!isAdmin(req)) return json(res, 401, { error: "Missing or wrong admin token." });
    const parts = url.pathname.replace(/^\/__pc\/api\/?/, "").split("/").filter(Boolean);
    const [kind, name, sub, id] = parts;
    const method = req.method ?? "GET";
    try {
      if (kind === "deploy" && method === "POST") {
        const target = url.searchParams.get("name") ?? "";
        if (!NAME_RE.test(target)) return json(res, 400, { error: `Invalid app name "${target}". Use 2 to 31 characters: lowercase letters, digits and dashes, starting with a letter.` });
        const body = await readBody(req, MAX_UPLOAD);
        const out = deploy(target, body, url.searchParams) as { app: AppConfig; swap: () => void };
        await manager.stop(target);
        out.swap();
        return json(res, 200, { name: target, url: `${scheme}://${target}.${domain}${portSuffix(req)}`, stack: out.app.stack, access: out.app.access, idleSeconds: out.app.idleSeconds, memoryMb: out.app.memoryMb });
      }
      if (kind === "apps" && !name && method === "GET") {
        return json(res, 200, listApps(root).map((a) => {
          const s = manager.state(a.name);
          const cs = s.coldStartsMs;
          return { ...a, status: a.stack === "static" ? "static" : s.status, url: `${scheme}://${a.name}.${domain}${portSuffix(req)}`, lastColdStartMs: cs[cs.length - 1] ?? null, lastError: s.lastError ?? null };
        }));
      }
      if (kind === "apps" && name && NAME_RE.test(name)) {
        if (!readApp(root, name)) return json(res, 404, { error: `No app called ${name}.` });
        if (!sub && method === "DELETE") {
          await manager.stop(name);
          rmSync(appDir(root, name), { recursive: true, force: true });
          manager.states.delete(name);
          return json(res, 200, { removed: name });
        }
        if (sub === "stop" && method === "POST") { await manager.stop(name); return json(res, 200, { stopped: name }); }
        if (sub === "logs" && method === "GET") return json(res, 200, { log: tailLog(logFile(root, name), Number(url.searchParams.get("bytes") ?? 4000)) });
        if (sub === "invites" && method === "GET") return json(res, 200, readInvites(root, name).map(({ hash: _h, ...rest }) => rest));
        if (sub === "invites" && method === "POST") {
          const raw = await readBody(req, 4096);
          const label = String((raw.length ? JSON.parse(raw.toString()) : {}).label ?? "guest").slice(0, 60);
          const token = newToken();
          const invite = { id: newToken().slice(0, 8), label, hash: sha256(token), createdAt: new Date().toISOString() };
          writeInvites(root, name, [...readInvites(root, name), invite]);
          return json(res, 200, { id: invite.id, label, url: `${scheme}://${name}.${domain}${portSuffix(req)}/__pc/join?t=${token}` });
        }
        if (sub === "invites" && id && method === "DELETE") {
          const all = readInvites(root, name);
          if (!all.some((i) => i.id === id)) return json(res, 404, { error: "No such invite." });
          writeInvites(root, name, all.filter((i) => i.id !== id));
          return json(res, 200, { revoked: id });
        }
      }
      return json(res, 404, { error: "Unknown endpoint." });
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
  }

  // ---- static sites ----
  function serveStatic(req: IncomingMessage, res: ServerResponse, name: string, pathname: string): void {
    const base = resolve(codeDir(root, name));
    let rel = decodeURIComponent(pathname);
    const send = (file: string): boolean => {
      const full = resolve(base, "." + normalize("/" + file));
      if (full !== base && !full.startsWith(base + sep)) return false;
      if (/(^|[\\/])\./.test(file) || file.endsWith("pocketcloud.json")) return false;
      if (!existsSync(full) || !statSync(full).isFile()) return false;
      res.writeHead(200, { "content-type": TYPES[extname(full).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-cache" });
      if (req.method === "HEAD") res.end(); else res.end(readFileSync(full));
      return true;
    };
    if (rel.endsWith("/")) rel += "index.html";
    if (send(rel)) return;
    if (rel.split("/").some((seg) => seg.startsWith("."))) return page(res, 404, "Not found", "<p>That page does not exist.</p>");
    if (!extname(rel) && send(rel + "/index.html")) return; // folder without trailing slash
    if (!extname(rel) && send("index.html")) return; // single-page app fallback
    page(res, 404, "Not found", "<p>That page does not exist.</p>");
  }

  // ---- proxy ----
  function forwardHeaders(req: IncomingMessage): http.OutgoingHttpHeaders {
    const h: http.OutgoingHttpHeaders = { ...req.headers };
    h["x-forwarded-for"] = req.socket.remoteAddress ?? "";
    h["x-forwarded-host"] = req.headers.host;
    h["x-forwarded-proto"] = scheme;
    delete h.authorization; // the admin token never reaches an app
    if (typeof h.cookie === "string") {
      const kept = h.cookie.split(";").map((c) => c.trim()).filter((c) => !c.startsWith(COOKIE + "="));
      if (kept.length) h.cookie = kept.join("; "); else delete h.cookie;
    }
    return h;
  }

  async function handleApp(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const app = NAME_RE.test(name) ? readApp(root, name) : undefined;
    if (!app) return page(res, 404, "No such app", `<p>Nothing is deployed at <b>${esc(name)}</b>.</p>`);

    if (url.pathname === "/__pc/join") {
      const t = url.searchParams.get("t") ?? "";
      const h = sha256(t);
      if (!t || !readInvites(root, name).some((i) => i.hash === h)) return page(res, 401, "Invite not valid", "<p>This invite link is wrong or has been revoked. Ask the owner for a new one.</p>");
      res.writeHead(302, { location: "/", "set-cookie": `${COOKIE}=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${scheme === "https" ? "; Secure" : ""}`, "cache-control": "no-store" });
      return void res.end();
    }
    if (app.access === "private" && !hasInvite(req, name) && !isAdmin(req)) {
      return page(res, 401, "This app is private", "<p>You need an invite link from the owner to open it.</p>");
    }
    if (app.stack === "static") return serveStatic(req, res, name, url.pathname);

    manager.begin(name);
    let ended = false;
    const done = () => { if (!ended) { ended = true; manager.end(name); } };
    res.on("close", done);
    let port: number;
    try {
      port = await manager.ensure(name);
    } catch (e) {
      done();
      return page(res, 502, "The app did not start", `<p>${esc((e as Error).message)}</p><pre>${esc(tailLog(logFile(root, name), 1500))}</pre>`);
    }
    const preq = http.request({ host: "127.0.0.1", port, method: req.method, path: req.url, headers: forwardHeaders(req) }, (pres) => {
      res.writeHead(pres.statusCode ?? 502, pres.headers);
      pres.pipe(res);
    });
    preq.on("error", () => { done(); if (!res.headersSent) page(res, 502, "The app is not answering", "<p>It may have crashed. Reload to start it again.</p>"); else res.destroy(); });
    req.pipe(preq);
  }

  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    const name = appNameOf(req);
    if (name !== undefined) { void handleApp(req, res, name).catch(() => { if (!res.headersSent) page(res, 500, "Something went wrong", "<p>Try again.</p>"); }); return; }
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname.startsWith("/__pc/api/")) { void api(req, res, url); return; }
    page(res, 200, "Pocketcloud", "<p>This server is running. Deploy with <code>pocketcloud deploy</code>.</p>");
  });

  server.on("connection", (sock: Socket) => { sockets.add(sock); sock.on("close", () => sockets.delete(sock)); });
  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    void (async () => {
      const name = appNameOf(req);
      const app = name && NAME_RE.test(name) ? readApp(root, name) : undefined;
      if (!name || !app || app.stack === "static") return void socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n");
      if (app.access === "private" && !hasInvite(req, name) && !isAdmin(req)) return void socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
      manager.begin(name);
      let ended = false;
      const done = () => { if (!ended) { ended = true; manager.end(name); } };
      socket.on("close", done);
      try {
        const port = await manager.ensure(name);
        const upstream = connect(port, "127.0.0.1", () => {
          const h = forwardHeaders(req);
          h.connection = "Upgrade"; h.upgrade = req.headers.upgrade;
          let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
          for (const [k, v] of Object.entries(h)) if (v !== undefined) raw += `${k}: ${Array.isArray(v) ? v.join(", ") : v}\r\n`;
          upstream.write(raw + "\r\n");
          if (head.length) upstream.write(head);
          upstream.pipe(socket); socket.pipe(upstream);
        });
        // Node's http sockets stay half-open after the peer ends; close both sides so the connection (and the idle timer) ends.
        socket.on("end", () => { upstream.destroy(); socket.destroy(); });
        upstream.on("end", () => { socket.destroy(); upstream.destroy(); });
        upstream.on("error", () => socket.destroy());
        socket.on("error", () => upstream.destroy());
        socket.on("close", () => upstream.destroy());
      } catch { done(); socket.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n"); }
    })();
  });

  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(opts.port ?? 8787, opts.host ?? "127.0.0.1", ok); });
  const port = (server.address() as { port: number }).port;
  return {
    server, manager, port, adminToken: cfg.adminToken, domain,
    async close() {
      server.closeAllConnections();
      for (const sock of sockets) sock.destroy(); // upgraded (websocket) connections are not covered above
      await new Promise<void>((ok) => server.close(() => ok()));
      await manager.dispose();
    },
  };
}
