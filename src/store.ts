// On-disk state: one folder per app (code, data, log, settings, invites) plus a config with the admin token.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Access = "private" | "public";
export type Stack = "node" | "python" | "static" | "custom";

export interface AppConfig {
  name: string;
  access: Access;
  idleSeconds: number;
  memoryMb: number;
  stack: Stack;
  command?: string;
  deployedAt: string;
}

export interface Invite { id: string; label: string; hash: string; createdAt: string }
export interface Config { adminToken: string }

export const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;

export function defaultHome(): string {
  return process.env.POCKETCLOUD_HOME || join(homedir(), ".pocketcloud");
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

export function loadConfig(root: string): Config {
  mkdirSync(root, { recursive: true });
  const file = join(root, "config.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as Config;
  const cfg: Config = { adminToken: newToken() };
  writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return cfg;
}

export function appDir(root: string, name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`Invalid app name "${name}". Use 2 to 31 characters: lowercase letters, digits and dashes, starting with a letter.`);
  return join(root, "apps", name);
}
export const codeDir = (root: string, name: string) => join(appDir(root, name), "code");
export const dataDir = (root: string, name: string) => join(appDir(root, name), "data");
export const logFile = (root: string, name: string) => join(appDir(root, name), "app.log");

export function readApp(root: string, name: string): AppConfig | undefined {
  const file = join(appDir(root, name), "app.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as AppConfig) : undefined;
}

export function writeApp(root: string, app: AppConfig): void {
  mkdirSync(dataDir(root, app.name), { recursive: true });
  writeFileSync(join(appDir(root, app.name), "app.json"), JSON.stringify(app, null, 2));
}

export function listApps(root: string): AppConfig[] {
  const dir = join(root, "apps");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => NAME_RE.test(n)).map((n) => readApp(root, n)).filter((a): a is AppConfig => !!a);
}

export function readInvites(root: string, name: string): Invite[] {
  const file = join(appDir(root, name), "invites.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Invite[]) : [];
}

export function writeInvites(root: string, name: string, invites: Invite[]): void {
  writeFileSync(join(appDir(root, name), "invites.json"), JSON.stringify(invites, null, 2), { mode: 0o600 });
}
