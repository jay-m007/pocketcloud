import { basename, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pack } from "./archive.ts";
import { startServer } from "./server.ts";
import { defaultHome, NAME_RE } from "./store.ts";

const HELP = `Pocketcloud: deploy small software for one person or one team.

Server
  pocketcloud serve [--port 8787] [--host 127.0.0.1] [--domain localhost] [--scheme http|https]
  pocketcloud token                       print the admin token (for deploying from another machine)

Apps
  pocketcloud deploy [dir] [--name app] [--public] [--idle 300] [--memory 256]
  pocketcloud ls
  pocketcloud logs <app> [--bytes 4000]
  pocketcloud invite <app> [--label ana]  make a private link for one person
  pocketcloud invites <app>               list invites
  pocketcloud revoke <app> <invite-id>
  pocketcloud stop <app>                  put it to sleep now
  pocketcloud rm <app>

Environment
  POCKETCLOUD_URL    server address (default http://localhost:8787)
  POCKETCLOUD_TOKEN  admin token (default: read from this machine's ~/.pocketcloud/config.json)
  POCKETCLOUD_HOME   where the server keeps its files (default ~/.pocketcloud)
  POCKETCLOUD_RUNNER "docker" to run apps in containers instead of local processes
`;

interface Parsed { cmd: string; pos: string[]; flags: Map<string, string | true> }

function parse(argv: string[]): Parsed {
  const [cmd = "", ...rest] = argv;
  const pos: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--") && !["public", "private"].includes(key)) { flags.set(key, next); i++; } else flags.set(key, true);
    } else pos.push(a);
  }
  return { cmd, pos, flags };
}

function adminToken(): string {
  if (process.env.POCKETCLOUD_TOKEN) return process.env.POCKETCLOUD_TOKEN;
  const file = join(defaultHome(), "config.json");
  if (existsSync(file)) return (JSON.parse(readFileSync(file, "utf8")) as { adminToken: string }).adminToken;
  throw new Error("No admin token. Set POCKETCLOUD_TOKEN, or run this on the machine where `pocketcloud serve` runs.");
}

async function call(method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}): Promise<unknown> {
  const base = (process.env.POCKETCLOUD_URL ?? "http://localhost:8787").replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetch(base + path, { method, body, headers: { authorization: `Bearer ${adminToken()}`, ...headers } });
  } catch {
    throw new Error(`Could not reach ${base}. Is \`pocketcloud serve\` running? Set POCKETCLOUD_URL if it lives elsewhere.`);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Server answered ${res.status}.`);
  return data;
}

function flag(p: Parsed, k: string): string | undefined { const v = p.flags.get(k); return typeof v === "string" ? v : undefined; }

async function main(): Promise<void> {
  const p = parse(process.argv.slice(2));
  if (!p.cmd || p.cmd === "-h" || p.cmd === "--help" || p.cmd === "help") { console.log(HELP); return; }
  if (p.cmd === "-v" || p.cmd === "--version") { console.log("0.1.0"); return; }

  if (p.cmd === "serve") {
    const s = await startServer({
      root: defaultHome(), port: Number(flag(p, "port") ?? 8787), host: flag(p, "host") ?? "127.0.0.1",
      domain: flag(p, "domain") ?? "localhost", scheme: (flag(p, "scheme") as "http" | "https" | undefined) ?? "http",
    });
    console.log(`Pocketcloud is running on port ${s.port}.`);
    console.log(`Apps open at http://<app>.${s.domain}:${s.port}`);
    console.log(`Files and the admin token live in ${defaultHome()}`);
    const stop = () => { void s.close().then(() => process.exit(0)); };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    return;
  }
  if (p.cmd === "token") { console.log(adminToken()); return; }

  if (p.cmd === "deploy") {
    const dir = resolve(p.pos[0] ?? ".");
    if (!existsSync(dir)) throw new Error(`${dir} does not exist.`);
    const name = flag(p, "name") ?? basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!NAME_RE.test(name)) throw new Error(`"${name}" is not a valid app name. Pass --name (2 to 31 characters: lowercase letters, digits, dashes; starts with a letter).`);
    const q = new URLSearchParams({ name });
    if (p.flags.has("public")) q.set("access", "public");
    if (p.flags.has("private")) q.set("access", "private");
    for (const k of ["idle", "memory"]) { const v = flag(p, k); if (v) q.set(k, v); }
    const body = pack(dir);
    console.log(`Uploading ${(body.length / 1024).toFixed(0)} KB…`);
    const r = (await call("POST", `/__pc/api/deploy?${q}`, new Uint8Array(body), { "content-type": "application/gzip" })) as { url: string; stack: string; access: string };
    console.log(`Deployed ${name} (${r.stack}, ${r.access}) at ${r.url}`);
    if (r.access === "private") console.log(`It is private. Share it with: pocketcloud invite ${name} --label "their name"`);
    return;
  }
  if (p.cmd === "ls") {
    const apps = (await call("GET", "/__pc/api/apps")) as { name: string; status: string; stack: string; access: string; url: string; lastColdStartMs: number | null }[];
    if (!apps.length) { console.log("Nothing deployed yet. Try: pocketcloud deploy ./my-app"); return; }
    for (const a of apps) console.log(`${a.name.padEnd(20)} ${a.status.padEnd(9)} ${a.stack.padEnd(7)} ${a.access.padEnd(8)} ${a.url}${a.lastColdStartMs !== null ? `  (last wake ${a.lastColdStartMs} ms)` : ""}`);
    return;
  }
  const app = p.pos[0];
  if (!app) throw new Error(`Usage: pocketcloud ${p.cmd} <app>. Run \`pocketcloud --help\`.`);
  if (p.cmd === "logs") { const r = (await call("GET", `/__pc/api/apps/${app}/logs?bytes=${flag(p, "bytes") ?? 4000}`)) as { log: string }; console.log(r.log || "(no output yet)"); return; }
  if (p.cmd === "invite") {
    const r = (await call("POST", `/__pc/api/apps/${app}/invites`, JSON.stringify({ label: flag(p, "label") ?? "guest" }), { "content-type": "application/json" })) as { id: string; url: string };
    console.log(`Invite ${r.id} for ${flag(p, "label") ?? "guest"}. Send them this link (it works as a sign-in, keep it private):\n${r.url}`);
    return;
  }
  if (p.cmd === "invites") { for (const i of (await call("GET", `/__pc/api/apps/${app}/invites`)) as { id: string; label: string; createdAt: string }[]) console.log(`${i.id}  ${i.label}  ${i.createdAt}`); return; }
  if (p.cmd === "revoke") { if (!p.pos[1]) throw new Error("Usage: pocketcloud revoke <app> <invite-id>"); await call("DELETE", `/__pc/api/apps/${app}/invites/${p.pos[1]}`); console.log("Revoked."); return; }
  if (p.cmd === "stop") { await call("POST", `/__pc/api/apps/${app}/stop`); console.log(`${app} is asleep. It wakes on the next request.`); return; }
  if (p.cmd === "rm") { await call("DELETE", `/__pc/api/apps/${app}`); console.log(`Removed ${app} and its data.`); return; }
  throw new Error(`Unknown command "${p.cmd}". Run \`pocketcloud --help\`.`);
}

main().catch((e: Error) => { console.error(e.message); process.exit(1); });
