// Configuration is read exclusively from environment variables. Secrets may be given either
// directly (NAME) or as a path to a file containing them (NAME_FILE), which is how Docker and
// Kubernetes secrets are usually mounted. See docs/configuration.md for the full reference.

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { isLogLevel, type LogLevel } from "./log.ts";

export type LibraryType = "user" | "group";
export type BibFormat = "bibtex" | "biblatex";

export interface ZoteroConfig {
  apiKey: string;
  libraryType: LibraryType;
  libraryId: string;
  /** Root collection to export; undefined exports the whole library. */
  collectionKey?: string;
  includeSubcollections: boolean;
  format: BibFormat;
  apiUrl: string;
  streamUrl: string;
}

export interface ShareLatexConfig {
  gitUrl: string;
  gitUsername: string;
  gitToken: string;
  branch: string;
  bibPath: string;
  commitMessage: string;
  authorName: string;
  authorEmail: string;
  /** Value for GIT_ALLOW_PROTOCOL, restricting which transports git may use. */
  allowedProtocols: string;
}

export interface SyncConfig {
  debounceMs: number;
  maxDebounceMs: number;
  safetyIntervalMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  streamMaxDownMs: number;
  staleAfterMs: number;
  workDir: string;
  healthFile: string;
}

export interface Config {
  zotero: ZoteroConfig;
  sharelatex: ShareLatexConfig;
  sync: SyncConfig;
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export type Env = Record<string, string | undefined>;
export type FileReader = (path: string) => string;

const defaultReader: FileReader = (path) => readFileSync(path, "utf8");

function optional(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function required(env: Env, name: string): string {
  const value = optional(env, name);
  if (value === undefined) throw new ConfigError(`${name} is required`);
  return value;
}

/** Read a secret from NAME or from the file referenced by NAME_FILE (exactly one must be set). */
export function readSecret(env: Env, name: string, readFile: FileReader = defaultReader): string {
  const direct = optional(env, name);
  const file = optional(env, `${name}_FILE`);
  if (direct !== undefined && file !== undefined) {
    throw new ConfigError(`Set either ${name} or ${name}_FILE, not both`);
  }
  if (file !== undefined) {
    let content: string;
    try {
      content = readFile(file);
    } catch (err) {
      throw new ConfigError(`Cannot read ${name}_FILE (${file}): ${(err as Error).message}`);
    }
    const value = content.trim();
    if (value === "") throw new ConfigError(`${name}_FILE (${file}) is empty`);
    return value;
  }
  if (direct !== undefined) return direct;
  throw new ConfigError(`${name} or ${name}_FILE is required`);
}

function parseBool(env: Env, name: string, fallback: boolean): boolean {
  const value = optional(env, name)?.toLowerCase();
  if (value === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new ConfigError(`${name} must be a boolean (true/false), got "${value}"`);
}

function parseSeconds(env: Env, name: string, fallback: number, min = 0): number {
  const raw = optional(env, name);
  if (raw === undefined) return fallback * 1000;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be a whole number of seconds`);
  const value = Number(raw);
  if (value < min) throw new ConfigError(`${name} must be at least ${min}`);
  return value * 1000;
}

function parseEnum<T extends string>(
  env: Env,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = optional(env, name)?.toLowerCase() ?? fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ConfigError(`${name} must be one of ${allowed.join(", ")}, got "${value}"`);
  }
  return value as T;
}

function parseGitUrl(raw: string, allowHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("SHARELATEX_GIT_URL is not a valid URL");
  }
  if (url.username || url.password) {
    throw new ConfigError(
      "SHARELATEX_GIT_URL must not contain credentials; use SHARELATEX_GIT_TOKEN(_FILE) instead",
    );
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new ConfigError(
      "SHARELATEX_GIT_URL must use https:// (set SHARELATEX_ALLOW_INSECURE_HTTP=true to allow http://)",
    );
  }
  return url;
}

function parseBibPath(raw: string): string {
  const normalized = posix.normalize(raw.replaceAll("\\", "/"));
  if (
    normalized.startsWith("/") ||
    normalized === "." ||
    normalized.split("/").some((part) => part === ".." || part === ".git")
  ) {
    throw new ConfigError(`SHARELATEX_BIB_PATH must be a relative path inside the project`);
  }
  return normalized;
}

/** Resolved separately so the healthcheck command does not need any secrets. */
export function healthFilePath(env: Env = process.env): string {
  return optional(env, "HEALTH_FILE") ?? join(tmpdir(), "zotero-sharelatex-sync.health.json");
}

export function loadConfig(env: Env = process.env, readFile: FileReader = defaultReader): Config {
  const libraryId = required(env, "ZOTERO_LIBRARY_ID");
  if (!/^\d+$/.test(libraryId)) throw new ConfigError("ZOTERO_LIBRARY_ID must be numeric");

  const collectionKey = optional(env, "ZOTERO_COLLECTION_KEY");
  if (collectionKey !== undefined && !/^[A-Z0-9]{8}$/.test(collectionKey)) {
    throw new ConfigError("ZOTERO_COLLECTION_KEY must be an 8-character Zotero key");
  }

  const allowHttp = parseBool(env, "SHARELATEX_ALLOW_INSECURE_HTTP", false);
  const gitUrl = parseGitUrl(required(env, "SHARELATEX_GIT_URL"), allowHttp);

  const safetyIntervalMs = parseSeconds(env, "SYNC_SAFETY_INTERVAL_SECONDS", 3600, 60);
  const debounceMs = parseSeconds(env, "SYNC_DEBOUNCE_SECONDS", 30);
  const maxDebounceMs = parseSeconds(env, "SYNC_MAX_DEBOUNCE_SECONDS", 300);
  if (maxDebounceMs < debounceMs) {
    throw new ConfigError("SYNC_MAX_DEBOUNCE_SECONDS must be >= SYNC_DEBOUNCE_SECONDS");
  }

  const logLevel = optional(env, "LOG_LEVEL")?.toLowerCase() ?? "info";
  if (!isLogLevel(logLevel)) throw new ConfigError("LOG_LEVEL must be debug, info, warn or error");

  return {
    zotero: {
      apiKey: readSecret(env, "ZOTERO_API_KEY", readFile),
      libraryType: parseEnum(env, "ZOTERO_LIBRARY_TYPE", ["user", "group"] as const, "user"),
      libraryId,
      collectionKey,
      includeSubcollections: parseBool(env, "ZOTERO_INCLUDE_SUBCOLLECTIONS", true),
      format: parseEnum(env, "BIB_FORMAT", ["bibtex", "biblatex"] as const, "bibtex"),
      apiUrl: (optional(env, "ZOTERO_API_URL") ?? "https://api.zotero.org").replace(/\/+$/, ""),
      streamUrl: optional(env, "ZOTERO_STREAM_URL") ?? "wss://stream.zotero.org",
    },
    sharelatex: {
      gitUrl: gitUrl.href,
      gitUsername: optional(env, "SHARELATEX_GIT_USERNAME") ?? "git",
      gitToken: readSecret(env, "SHARELATEX_GIT_TOKEN", readFile),
      branch: optional(env, "SHARELATEX_GIT_BRANCH") ?? "master",
      bibPath: parseBibPath(optional(env, "SHARELATEX_BIB_PATH") ?? "references.bib"),
      commitMessage:
        optional(env, "SHARELATEX_COMMIT_MESSAGE") ?? "Update bibliography from Zotero",
      authorName: optional(env, "SHARELATEX_COMMIT_AUTHOR_NAME") ?? "Zotero Sync",
      authorEmail: optional(env, "SHARELATEX_COMMIT_AUTHOR_EMAIL") ?? "zotero-sync@localhost",
      allowedProtocols: allowHttp ? "https:http" : "https",
    },
    sync: {
      debounceMs,
      maxDebounceMs,
      safetyIntervalMs,
      retryBaseMs: parseSeconds(env, "SYNC_RETRY_BASE_SECONDS", 30, 1),
      retryMaxMs: parseSeconds(env, "SYNC_RETRY_MAX_SECONDS", 900, 1),
      streamMaxDownMs: parseSeconds(env, "WATCHDOG_STREAM_MAX_DOWN_SECONDS", 900, 60),
      staleAfterMs: parseSeconds(
        env,
        "WATCHDOG_STALE_AFTER_SECONDS",
        Math.round((safetyIntervalMs * 3) / 1000),
        120,
      ),
      workDir: optional(env, "WORK_DIR") ?? tmpdir(),
      healthFile: healthFilePath(env),
    },
    logLevel,
  };
}
