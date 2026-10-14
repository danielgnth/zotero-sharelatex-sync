// git credential helper (https://git-scm.com/docs/gitcredentials). git runs
// `bun src/index.ts git-credential <get|store|erase>` and passes request attributes on stdin.
// We answer `get` only, and only for the configured ShareLaTeX host, so the token can never be
// handed to a different host (e.g. after a redirect).

export function parseAttributes(input: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const line of input.split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) attrs.set(line.slice(0, idx), line.slice(idx + 1));
  }
  return attrs;
}

export function credentialResponse(
  operation: string | undefined,
  input: string,
  env: Record<string, string | undefined>,
): string {
  if (operation !== "get") return "";
  const { ZSS_GIT_HOST: host, ZSS_GIT_USERNAME: username, ZSS_GIT_TOKEN: token } = env;
  if (!host || !username || !token) return "";
  const attrs = parseAttributes(input);
  if (attrs.get("host") !== host) return "";
  if (!["https", "http"].includes(attrs.get("protocol") ?? "")) return "";
  return `username=${username}\npassword=${token}\n`;
}

export async function runCredentialHelper(operation: string | undefined): Promise<void> {
  const input = await Bun.stdin.text();
  process.stdout.write(credentialResponse(operation, input, process.env));
}
