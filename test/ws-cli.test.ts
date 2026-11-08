import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "../src/manager.ts";
import { admin, boot, deploy, folder, request, sleep } from "./helpers.ts";

test("upgrade requests (websockets) are proxied, and keep the app awake", async () => {
  const s = await boot();
  try {
    const app = `import http from "node:http";
const srv = http.createServer((q, r) => r.end("plain"));
srv.on("upgrade", (req, socket) => { socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: echo\\r\\nConnection: Upgrade\\r\\n\\r\\n"); socket.on("data", (d) => socket.write("echo:" + d)); });
srv.listen(Number(process.env.PORT));`;
    await deploy(s, "sock", folder({ "server.js": app, "package.json": '{"main":"server.js"}' }), "&access=public&idle=1");
    const c = connect(s.port, "127.0.0.1");
    let buf = "";
    const got = (needle: string) => new Promise<void>((ok, fail) => {
      const t = setTimeout(() => fail(new Error(`never saw ${needle}; got ${JSON.stringify(buf)}`)), 5000);
      const check = () => { if (buf.includes(needle)) { clearTimeout(t); c.off("data", check); ok(); } };
      c.on("data", check); check();
    });
    c.on("data", (d) => { buf += d.toString(); });
    c.write(`GET /ws HTTP/1.1\r\nHost: sock.localhost:${s.port}\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n`);
    await got("101 Switching Protocols");
    c.write("ping");
    await got("echo:ping");
    await sleep(1600);
    assert.equal(s.manager.state("sock").status, "running", "an open socket keeps the app awake past its 1 s idle time");
    c.destroy();
    for (let i = 0; i < 80 && s.manager.state("sock").status !== "stopped"; i++) await sleep(100);
    assert.equal(s.manager.state("sock").status, "stopped", "it sleeps once the socket closes");
  } finally { await s.close(); }
});

test("the CLI serves, deploys, lists, invites, stops and removes", async () => {
  const home = mkdtempSync(join(tmpdir(), "pc-cli-"));
  const port = await freePort();
  const env = { ...process.env, POCKETCLOUD_HOME: home, POCKETCLOUD_URL: `http://127.0.0.1:${port}` };
  const cli = join(import.meta.dirname, "../src/cli.ts");
  const srv = spawn(process.execPath, [cli, "serve", "--port", String(port)], { env, stdio: ["ignore", "pipe", "inherit"] });
  try {
    await new Promise<void>((ok, fail) => { srv.stdout!.on("data", (d: Buffer) => d.toString().includes("running") && ok()); srv.on("exit", () => fail(new Error("server exited"))); });
    const run = (...args: string[]) => execFileSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
    const dir = folder({ "index.html": "<p>cli</p>" });
    assert.match(run("deploy", dir, "--name", "clisite"), /Deployed clisite \(static, private\)/);
    assert.match(run("ls"), /clisite\s+static\s+static\s+private/);
    const invite = run("invite", "clisite", "--label", "ana");
    const url = invite.split("\n").find((l) => l.startsWith("http"))!;
    const joined = await request(port, "clisite.localhost", new URL(url).pathname + new URL(url).search);
    assert.equal(joined.status, 302);
    assert.match(run("invites", "clisite"), /ana/);
    assert.match(run("rm", "clisite"), /Removed clisite/);
    assert.match(run("ls"), /Nothing deployed/);
    assert.throws(() => run("logs", "ghost"), /No app called ghost/);
  } finally { srv.kill("SIGTERM"); }
});

const pythonMissing = (() => { try { execFileSync("python3", ["--version"]); return false; } catch { return true; } })();
test("python apps run too", { skip: pythonMissing ? "python3 not installed" : false }, async () => {
  const s = await boot();
  try {
    const py = `import os, http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b"py " + os.environ["POCKETCLOUD_APP"].encode())
http.server.HTTPServer(("127.0.0.1", int(os.environ["PORT"])), H).serve_forever()`;
    const r = await deploy(s, "pyapp", folder({ "app.py": py }), "&access=public");
    assert.equal(r.status, 200, r.body);
    assert.equal((await request(s.port, "pyapp.localhost", "/")).body, "py pyapp");
    assert.equal(JSON.parse((await admin(s, "GET", "/__pc/api/apps")).body)[0].stack, "python");
  } finally { await s.close(); }
});
