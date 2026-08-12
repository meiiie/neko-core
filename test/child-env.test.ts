import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildMcpHub } from "../src/adapters/mcp.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";
import { scrubChildEnv } from "../src/shared/child-env.ts";

test("child env scrubber removes provider credentials case-insensitively and keeps ordinary values", () => {
  const scrubbed = scrubChildEnv({
    Path: "bin",
    openai_api_key: "sentinel",
    NeKo_TaViLy_ApI_KeY: "sentinel",
    CUSTOM_PROVIDER_KEY: "sentinel",
    EMPTY: undefined,
  }, ["custom_provider_key"]);
  expect(scrubbed).toEqual({ Path: "bin" });
});

test("bash cannot observe ambient Neko or configured provider keys", async () => {
  const prior = {
    NEKO_API_KEY: process.env.NEKO_API_KEY,
    CUSTOM_PROVIDER_KEY: process.env.CUSTOM_PROVIDER_KEY,
  };
  process.env.NEKO_API_KEY = "sentinel-never-print";
  process.env.CUSTOM_PROVIDER_KEY = "sentinel-never-print";
  try {
    const registry = new ToolRegistry(process.cwd(), "auto");
    registry.childSecretEnvNames = ["CUSTOM_PROVIDER_KEY"];
    const result = await registry.execute("bash", {
      command: "if [ -z \"$NEKO_API_KEY\" ] && [ -z \"$CUSTOM_PROVIDER_KEY\" ]; then printf child-env-absent; else printf child-env-present; fi",
    });
    expect(String(result)).toContain("child-env-absent");
    expect(String(result)).not.toContain("child-env-present");
  } finally {
    if (prior.NEKO_API_KEY === undefined) delete process.env.NEKO_API_KEY;
    else process.env.NEKO_API_KEY = prior.NEKO_API_KEY;
    if (prior.CUSTOM_PROVIDER_KEY === undefined) delete process.env.CUSTOM_PROVIDER_KEY;
    else process.env.CUSTOM_PROVIDER_KEY = prior.CUSTOM_PROVIDER_KEY;
  }
});

test("MCP receives no arbitrary ambient env and keeps only explicit per-server grants", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-child-env-"));
  const prior = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    NEKO_API_KEY: process.env.NEKO_API_KEY,
    CUSTOM_PROVIDER_KEY: process.env.CUSTOM_PROVIDER_KEY,
    ORDINARY_CHILD_VALUE: process.env.ORDINARY_CHILD_VALUE,
    EXPLICIT_SERVER_KEY: process.env.EXPLICIT_SERVER_KEY,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  };
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    NEKO_API_KEY: "sentinel-never-print",
    CUSTOM_PROVIDER_KEY: "sentinel-never-print",
    ORDINARY_CHILD_VALUE: "ordinary",
    EXPLICIT_SERVER_KEY: "ambient-sentinel-never-print",
    GITHUB_TOKEN: "ambient-github-never-print",
    AWS_SECRET_ACCESS_KEY: "ambient-aws-never-print",
  });
  try {
    const hub = await buildMcpHub({
      envtest: {
        command: process.execPath,
        args: [join(import.meta.dir, "fixtures", "mcp-env-server.ts")],
        env: { EXPLICIT_SERVER_KEY: "granted-explicitly" },
      },
    }, {}, false, ["CUSTOM_PROVIDER_KEY", "EXPLICIT_SERVER_KEY"]);
    try {
      const result = await hub.call("mcp__envtest__env_status", {
        names: ["NEKO_API_KEY", "CUSTOM_PROVIDER_KEY", "ORDINARY_CHILD_VALUE", "EXPLICIT_SERVER_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY"],
      });
      expect(JSON.parse(result)).toEqual({
        NEKO_API_KEY: false,
        CUSTOM_PROVIDER_KEY: false,
        ORDINARY_CHILD_VALUE: false,
        EXPLICIT_SERVER_KEY: true,
        GITHUB_TOKEN: false,
        AWS_SECRET_ACCESS_KEY: false,
      });
    } finally {
      await hub.close();
    }
  } finally {
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
