import { describe, expect, test } from "bun:test";
import { ConfigError, type Env, loadConfig, readSecret } from "../src/config.ts";

const base: Env = {
  ZOTERO_API_KEY: "zotero-key",
  ZOTERO_LIBRARY_ID: "123456",
  SHARELATEX_GIT_URL: "https://latex.example.edu/git/abc123",
  SHARELATEX_GIT_TOKEN: "git-token",
};

const noFiles = (path: string): string => {
  throw new Error(`unexpected read of ${path}`);
};

describe("readSecret", () => {
  test("reads the variable directly", () => {
    expect(readSecret({ FOO: "bar" }, "FOO", noFiles)).toBe("bar");
  });

  test("reads and trims a _FILE secret", () => {
    const files: Record<string, string> = { "/run/secrets/foo": "s3cret\n" };
    expect(readSecret({ FOO_FILE: "/run/secrets/foo" }, "FOO", (p) => files[p] ?? "")).toBe(
      "s3cret",
    );
  });

  test("rejects both forms at once", () => {
    expect(() => readSecret({ FOO: "a", FOO_FILE: "/x" }, "FOO", noFiles)).toThrow(ConfigError);
  });

  test("rejects missing and empty secrets", () => {
    expect(() => readSecret({}, "FOO", noFiles)).toThrow("FOO or FOO_FILE is required");
    expect(() => readSecret({ FOO_FILE: "/x" }, "FOO", () => "  \n")).toThrow("is empty");
    expect(() =>
      readSecret({ FOO_FILE: "/x" }, "FOO", () => {
        throw new Error("ENOENT");
      }),
    ).toThrow("Cannot read FOO_FILE");
  });
});

describe("loadConfig", () => {
  test("applies defaults", () => {
    const config = loadConfig(base, noFiles);
    expect(config.zotero).toMatchObject({
      libraryType: "user",
      libraryId: "123456",
      collectionKey: undefined,
      includeSubcollections: true,
      format: "bibtex",
      apiUrl: "https://api.zotero.org",
    });
    expect(config.sharelatex).toMatchObject({
      gitUsername: "git",
      branch: "master",
      bibPath: "references.bib",
      allowedProtocols: "https",
    });
    expect(config.sync.debounceMs).toBe(30_000);
    expect(config.sync.staleAfterMs).toBe(3 * 3600_000);
  });

  test("parses a group collection in biblatex format", () => {
    const config = loadConfig(
      {
        ...base,
        ZOTERO_LIBRARY_TYPE: "group",
        ZOTERO_COLLECTION_KEY: "ABCD2345",
        ZOTERO_INCLUDE_SUBCOLLECTIONS: "false",
        BIB_FORMAT: "BibLaTeX",
        SHARELATEX_BIB_PATH: "./bib/refs.bib",
      },
      noFiles,
    );
    expect(config.zotero.libraryType).toBe("group");
    expect(config.zotero.collectionKey).toBe("ABCD2345");
    expect(config.zotero.includeSubcollections).toBe(false);
    expect(config.zotero.format).toBe("biblatex");
    expect(config.sharelatex.bibPath).toBe("bib/refs.bib");
  });

  test("rejects credentials embedded in the git URL", () => {
    expect(() =>
      loadConfig({ ...base, SHARELATEX_GIT_URL: "https://git:tok@latex.example.edu/git/x" }),
    ).toThrow("must not contain credentials");
  });

  test("requires https unless explicitly allowed", () => {
    const env = { ...base, SHARELATEX_GIT_URL: "http://latex.local/git/x" };
    expect(() => loadConfig(env, noFiles)).toThrow("must use https://");
    const config = loadConfig({ ...env, SHARELATEX_ALLOW_INSECURE_HTTP: "true" }, noFiles);
    expect(config.sharelatex.allowedProtocols).toBe("https:http");
  });

  test.each(["../outside.bib", "/etc/passwd", ".git/config", "a/../../b.bib"])(
    "rejects unsafe bib path %s",
    (path) => {
      expect(() => loadConfig({ ...base, SHARELATEX_BIB_PATH: path }, noFiles)).toThrow(
        ConfigError,
      );
    },
  );

  test("validates enums, numbers and keys", () => {
    expect(() => loadConfig({ ...base, BIB_FORMAT: "ris" }, noFiles)).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, ZOTERO_LIBRARY_ID: "abc" }, noFiles)).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, ZOTERO_COLLECTION_KEY: "short" }, noFiles)).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...base, SYNC_DEBOUNCE_SECONDS: "1.5" }, noFiles)).toThrow(
      ConfigError,
    );
    expect(() =>
      loadConfig({ ...base, SYNC_DEBOUNCE_SECONDS: "600", SYNC_MAX_DEBOUNCE_SECONDS: "60" }),
    ).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, LOG_LEVEL: "loud" }, noFiles)).toThrow(ConfigError);
  });
});
