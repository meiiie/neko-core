import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const roots: string[] = [];

afterAll(() => {
  const temp = resolve(tmpdir());
  for (const root of roots) {
    const target = resolve(root);
    if (target !== temp && target.startsWith(temp + sep)) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

async function cli(home: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = {
    HOME: home,
    USERPROFILE: home,
    NEKO_AUTO_UPDATE: "0",
    ...(process.env.PATH ? { PATH: process.env.PATH } : undefined),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : undefined),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : undefined),
    ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : undefined),
    ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : undefined),
    ...(process.env.TEMP ? { TEMP: process.env.TEMP } : undefined),
    ...(process.env.TMP ? { TMP: process.env.TMP } : undefined),
    ...(process.env.LOCALAPPDATA ? { LOCALAPPDATA: process.env.LOCALAPPDATA } : undefined),
  };
  const child = Bun.spawn([process.execPath, "bin/neko.ts", ...args], {
    cwd: resolve("."),
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test("CLI OpenRouter login and logout keep the key profile-scoped and never echo it", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-openrouter-cli-"));
  roots.push(home);
  const sentinel = "integration-sentinel-value";

  const login = await cli(home, "login", "openrouter", sentinel);
  expect(login.code).toBe(0);
  expect(login.stdout + login.stderr).not.toContain(sentinel);
  const configPath = join(home, ".neko-core", "config.json");
  expect(existsSync(configPath)).toBe(true);
  const saved = JSON.parse(readFileSync(configPath, "utf8"));
  expect(saved.active_profile).toBe("openrouter");
  expect(saved.profiles.openrouter.api_key).toBe(sentinel);
  expect(saved.api_key).toBeUndefined();

  const logout = await cli(home, "logout", "openrouter");
  expect(logout.code).toBe(0);
  expect(logout.stdout + logout.stderr).not.toContain(sentinel);
  const cleared = JSON.parse(readFileSync(configPath, "utf8"));
  expect(cleared.profiles.openrouter.api_key).toBeUndefined();
}, 15_000);
