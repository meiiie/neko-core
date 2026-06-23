/**
 * Interactive OAuth 2.1 for remote (HTTP) MCP servers that require login. A file-backed
 * OAuthClientProvider (dynamic client registration + PKCE + token storage/refresh, all via the
 * SDK) plus a loopback callback server + browser open. Opt-in per server (`"oauth": true`).
 *
 * Note: static-token servers don't need this — just set `headers`. This is for servers that
 * REQUIRE a browser login. The automated parts (storage, loopback, transport dance) are tested;
 * the browser-login leg itself runs on the user's machine.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

function authDir(server: string): string {
  return join(homedir(), ".neko-core", "mcp-auth", server.replace(/[^a-z0-9_-]/gi, "_"));
}

export function openBrowser(url: string): void {
  const win = process.platform === "win32";
  const cmd = win ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = win ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* user can open the URL manually (it's logged) */
  }
}

/** File-backed OAuth client provider (client registration, tokens, PKCE verifier persisted). */
export class NekoOAuthProvider implements OAuthClientProvider {
  private dir: string;
  constructor(server: string, private port: number) {
    this.dir = authDir(server);
    mkdirSync(this.dir, { recursive: true });
  }
  get redirectUrl(): string {
    return `http://localhost:${this.port}/callback`;
  }
  get clientMetadata(): any {
    return {
      client_name: "Neko Code",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  private read(file: string): any {
    const p = join(this.dir, file);
    if (!existsSync(p)) return undefined;
    try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return undefined; }
  }
  private save(file: string, value: any): void {
    writeFileSync(join(this.dir, file), JSON.stringify(value), "utf-8");
  }
  clientInformation() { return this.read("client.json"); }
  saveClientInformation(info: any) { this.save("client.json", info); }
  tokens() { return this.read("tokens.json"); }
  saveTokens(tokens: any) { this.save("tokens.json", tokens); }
  saveCodeVerifier(verifier: string) { this.save("verifier.json", { verifier }); }
  codeVerifier(): string {
    const v = this.read("verifier.json");
    if (!v?.verifier) throw new Error("no PKCE code verifier saved");
    return v.verifier;
  }
  redirectToAuthorization(url: URL): void {
    openBrowser(url.toString());
  }
}

const CALLBACK_PORT = 41789;

/** Connect a Client to an OAuth-protected MCP server, running the browser login if needed. */
export async function connectWithOAuth(client: Client, server: string, url: string): Promise<any> {
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const provider = new NekoOAuthProvider(server, CALLBACK_PORT);

  let resolveCode!: (c: string) => void;
  let rejectCode!: (e: Error) => void;
  const codePromise = new Promise<string>((res, rej) => { resolveCode = res; rejectCode = rej; });
  const httpServer = createServer((req, res) => {
    const code = new URL(req.url ?? "/", `http://localhost:${CALLBACK_PORT}`).searchParams.get("code");
    res.end(code ? "Neko Code: login complete - you can close this tab." : "Neko Code: waiting for login...");
    if (code) resolveCode(code);
  });
  const timeout = setTimeout(() => rejectCode(new Error("OAuth login timed out (2 min)")), 120_000);

  try {
    await new Promise<void>((r) => httpServer.listen(CALLBACK_PORT, r));
    let transport = new StreamableHTTPClientTransport(new URL(url), { authProvider: provider });
    try {
      await client.connect(transport); // works if we already have a valid/refreshable token
      return transport;
    } catch {
      // redirectToAuthorization opened the browser; wait for the loopback code, then finish.
      console.error(`neko: '${server}' needs login - a browser window should open (callback on :${CALLBACK_PORT}).`);
      const code = await codePromise;
      await transport.finishAuth(code);
      transport = new StreamableHTTPClientTransport(new URL(url), { authProvider: provider });
      await client.connect(transport);
      return transport;
    }
  } finally {
    clearTimeout(timeout);
    httpServer.close();
  }
}
