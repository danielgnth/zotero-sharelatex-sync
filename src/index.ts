#!/usr/bin/env bun
// Entrypoint. Commands:
//   (none) | daemon     long-running, event-driven sync (default; what the container runs)
//   once                run one full sync and exit (0 = success)
//   healthcheck         exit 0 if the daemon reports healthy (Docker HEALTHCHECK / k8s probe)
//   git-credential OP   git credential helper used internally by the git subprocesses

import { ConfigError, healthFilePath, loadConfig } from "./config.ts";
import { errorMessage, log, registerSecret, setLogLevel } from "./log.ts";

async function main(): Promise<void> {
  const [command = "daemon", arg] = process.argv.slice(2);

  if (command === "git-credential") {
    const { runCredentialHelper } = await import("./git-credential.ts");
    await runCredentialHelper(arg);
    return;
  }

  if (command === "healthcheck") {
    const { checkHealthFile } = await import("./health.ts");
    const result = await checkHealthFile(healthFilePath());
    if (!result.ok) console.error(`unhealthy: ${result.message}`);
    process.exit(result.ok ? 0 : 1);
  }

  if (command !== "daemon" && command !== "once") {
    console.error(`Unknown command "${command}". Use: daemon | once | healthcheck`);
    process.exit(2);
  }

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error("Invalid configuration", { err: err.message });
      process.exit(2);
    }
    throw err;
  }
  setLogLevel(config.logLevel);
  registerSecret(config.zotero.apiKey);
  registerSecret(config.sharelatex.gitToken, config.sharelatex.gitUsername);

  process.on("unhandledRejection", (err) => {
    log.error("Unhandled rejection, exiting", { err: errorMessage(err) });
    process.exit(1);
  });

  const { runDaemon, runOnce } = await import("./app.ts");
  if (command === "once") {
    try {
      await runOnce(config);
    } catch (err) {
      log.error("Sync failed", { err: errorMessage(err) });
      process.exit(1);
    }
    return;
  }
  await runDaemon(config);
}

await main();
