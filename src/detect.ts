// Works out how to run an uploaded folder. A pocketcloud.json can override everything.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Stack } from "./store.ts";

export interface Detected { stack: Stack; command?: string; install?: string[] }

export function detect(dir: string): Detected {
  const manifest = join(dir, "pocketcloud.json");
  if (existsSync(manifest)) {
    const m = JSON.parse(readFileSync(manifest, "utf8")) as { run?: string; static?: boolean };
    if (m.static) return { stack: "static" };
    if (typeof m.run === "string" && m.run.trim()) return { stack: "custom", command: m.run };
  }
  const pj = join(dir, "package.json");
  if (existsSync(pj)) {
    const p = JSON.parse(readFileSync(pj, "utf8")) as { scripts?: Record<string, string>; main?: string; dependencies?: Record<string, string> };
    const needsInstall = !!p.dependencies && Object.keys(p.dependencies).length > 0 && !existsSync(join(dir, "node_modules"));
    const install = needsInstall ? ["npm", "install", "--omit=dev", "--no-audit", "--no-fund"] : undefined;
    if (p.scripts?.start) return { stack: "node", command: "npm start", install };
    if (p.main && existsSync(join(dir, p.main))) return { stack: "node", command: `node ${JSON.stringify(p.main)}`, install };
  }
  for (const f of ["server.js", "index.js", "app.js", "server.mjs", "index.mjs"]) {
    if (existsSync(join(dir, f))) {
      const hasDeps = existsSync(pj) && Object.keys((JSON.parse(readFileSync(pj, "utf8")) as { dependencies?: object }).dependencies ?? {}).length > 0 && !existsSync(join(dir, "node_modules"));
      return { stack: "node", command: `node ${f}`, install: hasDeps ? ["npm", "install", "--omit=dev", "--no-audit", "--no-fund"] : undefined };
    }
  }
  for (const f of ["app.py", "main.py", "server.py"]) {
    if (existsSync(join(dir, f))) {
      const install = existsSync(join(dir, "requirements.txt")) ? ["python3", "-m", "pip", "install", "-r", "requirements.txt", "--target", ".pc_deps", "--quiet"] : undefined;
      return { stack: "python", command: `python3 ${f}`, install };
    }
  }
  if (existsSync(join(dir, "index.html"))) return { stack: "static" };
  throw new Error("Could not tell how to run this folder. Add a package.json with a start script, an app.py, an index.html, or a pocketcloud.json with { \"run\": \"<command>\" }.");
}
