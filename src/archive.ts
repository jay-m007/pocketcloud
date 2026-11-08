// Packing and unpacking uploads with the system tar (no dependencies). Unpacking refuses unsafe paths.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_UPLOAD = 50 * 1024 * 1024;
const EXCLUDES = [".git", "node_modules", ".pc_deps", "__pycache__", ".DS_Store"];

export function pack(dir: string): Buffer {
  const args = ["-czf", "-", ...EXCLUDES.flatMap((e) => ["--exclude", e]), "-C", dir, "."];
  const r = spawnSync("tar", args, { maxBuffer: MAX_UPLOAD + 1024 });
  if (r.status !== 0) throw new Error(`tar failed: ${r.stderr?.toString() || r.error?.message}`);
  if (r.stdout.length > MAX_UPLOAD) throw new Error(`The folder packs to more than ${MAX_UPLOAD / 1024 / 1024} MB. Remove large files or build output.`);
  return r.stdout;
}

/** Returns an error message if any entry could escape the target folder, otherwise undefined. */
export function unsafeEntry(names: string[]): string | undefined {
  for (const raw of names) {
    const n = raw.replace(/\\/g, "/");
    if (n.startsWith("/") || /^[a-zA-Z]:/.test(n) || n.split("/").includes("..")) return `Unsafe path in archive: ${raw}`;
  }
  return undefined;
}

export function unpack(tgz: Buffer, target: string): void {
  const tmp = mkdtempSync(join(tmpdir(), "pocketcloud-up-"));
  try {
    const file = join(tmp, "up.tgz");
    writeFileSync(file, tgz);
    const names = execFileSync("tar", ["-tzf", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean);
    const bad = unsafeEntry(names);
    if (bad) throw new Error(bad);
    // Links can point outside the folder even with clean names, so list types too.
    const verbose = execFileSync("tar", ["-tvzf", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n");
    if (verbose.some((l) => /^[lh]/.test(l))) throw new Error("Archives with links are not accepted.");
    mkdirSync(target, { recursive: true });
    execFileSync("tar", ["-xzf", file, "-C", target, "--no-same-owner"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
