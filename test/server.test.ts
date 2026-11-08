import { test } from "node:test";
import assert from "node:assert/strict";
import { admin, boot, deploy, folder, NODE_APP, request, sleep } from "./helpers.ts";

test("deploys a node app, keeps it private, and an invite link lets one person in", async () => {
  const s = await boot();
  try {
    const r = await deploy(s, "hello", folder({ "server.js": NODE_APP, "package.json": '{"name":"x","main":"server.js"}' }));
    assert.equal(r.status, 200, r.body);
    assert.equal(JSON.parse(r.body).access, "private");

    const blocked = await request(s.port, "hello.localhost", "/");
    assert.equal(blocked.status, 401);
    assert.equal(s.manager.state("hello").status, "stopped", "an unauthorised request must not start the app");

    const inv = JSON.parse((await admin(s, "POST", "/__pc/api/apps/hello/invites", { label: "ana" })).body);
    const token = new URL(inv.url).searchParams.get("t")!;
    const join = await request(s.port, "hello.localhost", `/__pc/join?t=${token}`);
    assert.equal(join.status, 302);
    const cookie = String(join.headers["set-cookie"]).split(";")[0];

    const ok = await request(s.port, "hello.localhost", "/", { headers: { cookie: `${cookie}; theme=dark`, authorization: "Bearer leak" } });
    assert.equal(ok.status, 200);
    assert.match(ok.body, /hello from hello start #1/);
    assert.match(ok.body, /theme=dark/, "other cookies reach the app");
    assert.doesNotMatch(ok.body, /pc_session/, "the session cookie is not passed to the app");
    assert.match(ok.body, /auth= *$/, "authorization headers are not passed to the app");

    const bad = await request(s.port, "hello.localhost", "/__pc/join?t=nope");
    assert.equal(bad.status, 401);

    const id = inv.id as string;
    assert.equal((await admin(s, "DELETE", `/__pc/api/apps/hello/invites/${id}`)).status, 200);
    assert.equal((await request(s.port, "hello.localhost", "/", { headers: { cookie } })).status, 401, "a revoked invite stops working");
  } finally { await s.close(); }
});

test("an app sleeps when idle, wakes on the next request, and keeps its data", async () => {
  const s = await boot();
  try {
    await deploy(s, "nap", folder({ "server.js": NODE_APP, "package.json": '{"main":"server.js"}' }), "&public=1&access=public&idle=1");
    const first = await request(s.port, "nap.localhost", "/");
    assert.match(first.body, /start #1/);
    assert.equal(s.manager.state("nap").status, "running");

    for (let i = 0; i < 40 && s.manager.state("nap").status !== "stopped"; i++) await sleep(100);
    assert.equal(s.manager.state("nap").status, "stopped", "should sleep after 1 s idle");

    const second = await request(s.port, "nap.localhost", "/");
    assert.match(second.body, /start #2/, "data in DATA_DIR survives sleep");
    assert.equal(s.manager.state("nap").coldStartsMs.length, 2);
  } finally { await s.close(); }
});

test("simultaneous first requests share one start", async () => {
  const s = await boot();
  try {
    await deploy(s, "burst", folder({ "server.js": NODE_APP, "package.json": '{"main":"server.js"}' }), "&access=public");
    const replies = await Promise.all(Array.from({ length: 8 }, () => request(s.port, "burst.localhost", "/")));
    assert.ok(replies.every((r) => r.status === 200));
    assert.ok(replies.every((r) => /start #1/.test(r.body)), "only one process was started");
  } finally { await s.close(); }
});

test("static sites are served without a process, with a single-page fallback and no path escape", async () => {
  const s = await boot();
  try {
    await deploy(s, "site", folder({ "index.html": "<h1>hi</h1>", "app.js": "1", "secret/.env": "x", "pocketcloud.json": '{"static":true}' }), "&access=public");
    assert.equal((await request(s.port, "site.localhost", "/")).body, "<h1>hi</h1>");
    assert.equal((await request(s.port, "site.localhost", "/app.js")).status, 200);
    assert.equal((await request(s.port, "site.localhost", "/some/route")).body, "<h1>hi</h1>");
    assert.equal((await request(s.port, "site.localhost", "/missing.png")).status, 404);
    assert.equal((await request(s.port, "site.localhost", "/secret/.env")).status, 404, "dotfiles are not served");
    assert.equal((await request(s.port, "site.localhost", "/pocketcloud.json")).status, 404);
    assert.equal((await request(s.port, "site.localhost", "/..%2f..%2fapp.json")).status, 404);
    assert.equal(s.manager.state("site").status, "stopped");
  } finally { await s.close(); }
});

test("a crashing app gives a readable error with its log", async () => {
  const s = await boot({ startTimeoutMs: 5000 });
  try {
    await deploy(s, "boom", folder({ "server.js": 'console.log("about to fail"); process.exit(3);', "package.json": '{"main":"server.js"}' }), "&access=public");
    const r = await request(s.port, "boom.localhost", "/");
    assert.equal(r.status, 502);
    assert.match(r.body, /exited with code 3/);
    assert.match(r.body, /about to fail/);
  } finally { await s.close(); }
});

test("an app that grows past its memory limit is stopped", async () => {
  const s = await boot();
  try {
    const hog = `import http from "node:http"; const keep = []; for (let i = 0; i < 60; i++) keep.push(Buffer.alloc(5 * 1024 * 1024, 1));
http.createServer((q, r) => r.end("ok" + keep.length)).listen(Number(process.env.PORT));`;
    await deploy(s, "hog", folder({ "server.js": hog, "package.json": '{"main":"server.js"}' }), "&access=public&memory=100");
    assert.equal((await request(s.port, "hog.localhost", "/")).status, 200);
    await s.manager.sweep();
    assert.equal(s.manager.state("hog").status, "stopped");
    assert.match(String(s.manager.state("hog").lastError), /over the 100 MB limit/);
  } finally { await s.close(); }
});

test("the control API needs the admin token, and bad names and unknown stacks are refused", async () => {
  const s = await boot();
  try {
    assert.equal((await request(s.port, "localhost", "/__pc/api/apps")).status, 401);
    assert.equal((await request(s.port, "localhost", "/__pc/api/apps", { headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await deploy(s, "Bad_Name", folder({ "index.html": "x" }))).status, 400);
    const unknown = await deploy(s, "empty", folder({ "notes.txt": "x" }));
    assert.equal(unknown.status, 400);
    assert.match(unknown.body, /Could not tell how to run/);
    assert.equal(JSON.parse((await admin(s, "GET", "/__pc/api/apps")).body).length, 0, "a failed deploy leaves nothing behind");
    assert.equal((await request(s.port, "ghost.localhost", "/")).status, 404);
  } finally { await s.close(); }
});

test("redeploying replaces the code, and rm deletes the app and its data", async () => {
  const s = await boot();
  try {
    await deploy(s, "ver", folder({ "index.html": "one" }), "&access=public");
    assert.equal((await request(s.port, "ver.localhost", "/")).body, "one");
    await deploy(s, "ver", folder({ "index.html": "two" }));
    const got = await request(s.port, "ver.localhost", "/");
    assert.equal(got.body, "two");
    assert.equal(JSON.parse((await admin(s, "GET", "/__pc/api/apps")).body)[0].access, "public", "settings survive a redeploy");
    assert.equal((await admin(s, "DELETE", "/__pc/api/apps/ver")).status, 200);
    assert.equal((await request(s.port, "ver.localhost", "/")).status, 404);
  } finally { await s.close(); }
});
