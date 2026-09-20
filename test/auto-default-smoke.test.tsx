import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { ToolRegistry } from "../src/core/tool-runtime.ts";
import { loadConfig } from "../src/adapters/config.ts";
import { ChatApp } from "../src/ui/chat.tsx";
import { decide } from "../src/core/permissions.ts";
import { resolveTool } from "../src/core/tools.ts";

function strip(s: string | undefined) {
  return (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");
}

test("lived product default: omitted mode is auto; write_file silent; computer allows; TUI shows auto", async () => {
  const prev = process.env.NEKO_MODE;
  delete process.env.NEKO_MODE;
  const home = mkdtempSync(join(tmpdir(), "neko-auto-home-"));
  const root = mkdtempSync(join(tmpdir(), "neko-auto-root-"));
  try {
    writeFileSync(join(home, "neko.json"), "{}", "utf8");
    const cfg = loadConfig({ cwd: home, home });
    expect(cfg.mode).toBe("auto");

    let prompts = 0;
    const reg = new ToolRegistry(root);
    reg.prompt = () => {
      prompts++;
      return true;
    };
    expect(reg.mode).toBe("auto");
    expect(await reg.execute("write_file", { path: "smoke.txt", content: "auto-default-ok" })).toContain("Wrote");
    expect(prompts).toBe(0);
    expect(readFileSync(join(root, "smoke.txt"), "utf8")).toBe("auto-default-ok");

    expect(decide("auto", resolveTool("computer"))).toBe("allow");

    class Echo {
      async complete() {
        return { content: "hi", tool_calls: [] };
      }
    }
    const c = render(<ChatApp fullscreen={false} provider={new Echo() as any} />);
    await Bun.sleep(80);
    const frame = strip(c.lastFrame());
    expect(frame).toContain("auto");
    c.unmount();
  } finally {
    if (prev === undefined) delete process.env.NEKO_MODE;
    else process.env.NEKO_MODE = prev;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
