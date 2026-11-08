import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pack, unpack, unsafeEntry } from "../src/archive.ts";
import { detect } from "../src/detect.ts";
import { folder } from "./helpers.ts";

test("unsafe archive paths are caught", () => {
  assert.ok(unsafeEntry(["../evil"]));
  assert.ok(unsafeEntry(["a/../../evil"]));
  assert.ok(unsafeEntry(["/etc/passwd"]));
  assert.ok(unsafeEntry(["C:\\x"]));
  assert.equal(unsafeEntry(["./a/b.txt", "c"]), undefined);
});

test("unpack refuses archives that hold links", () => {
  const src = mkdtempSync(join(tmpdir(), "pc-link-"));
  writeFileSync(join(src, "a.txt"), "a");
  symlinkSync("/etc", join(src, "out"));
  const tgz = execFileSync("tar", ["-czf", "-", "-C", src, "."], { maxBuffer: 1 << 20 });
  const target = join(mkdtempSync(join(tmpdir(), "pc-t-")), "x");
  assert.throws(() => unpack(tgz, target), /links are not accepted/);
});

test("pack leaves out node_modules and .git, unpack restores the rest", () => {
  const dir = folder({ "index.js": "1", "node_modules/x/y.js": "2", ".git/HEAD": "3", "lib/z.js": "4" });
  const target = join(mkdtempSync(join(tmpdir(), "pc-u-")), "code");
  unpack(pack(dir), target);
  assert.ok(existsSync(join(target, "index.js")) && existsSync(join(target, "lib/z.js")));
  assert.ok(!existsSync(join(target, "node_modules")) && !existsSync(join(target, ".git")));
  mkdirSync(join(target, "more"), { recursive: true });
});

test("detect picks a start command for each kind of folder", () => {
  assert.deepEqual(detect(folder({ "package.json": '{"scripts":{"start":"node a.js"}}' })), { stack: "node", command: "npm start", install: undefined });
  assert.equal(detect(folder({ "package.json": '{"main":"main.js"}', "main.js": "" })).command, 'node "main.js"');
  assert.deepEqual(detect(folder({ "server.js": "" })).stack, "node");
  assert.equal(detect(folder({ "app.py": "" })).command, "python3 app.py");
  assert.equal(detect(folder({ "index.html": "" })).stack, "static");
  assert.equal(detect(folder({ "x": "", "pocketcloud.json": '{"run":"./serve --port $PORT"}' })).command, "./serve --port $PORT");
  assert.deepEqual(detect(folder({ "package.json": '{"dependencies":{"left-pad":"1"},"main":"i.js"}', "i.js": "" })).install, ["npm", "install", "--omit=dev", "--no-audit", "--no-fund"]);
  assert.throws(() => detect(folder({ "notes.txt": "" })), /Could not tell/);
});
