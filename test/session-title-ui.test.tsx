import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Provider, ProviderResponse } from "../src/adapters/providers.ts";
import { loadSession } from "../src/adapters/session.ts";
import { ChatApp } from "../src/ui/chat.tsx";

const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

class Echo implements Provider {
  async complete(): Promise<ProviderResponse> {
    return { content: "ok", tool_calls: [] };
  }
}

test("/title survives the next session persist, including before the first turn", async () => {
  const saved = { up: process.env.USERPROFILE, home: process.env.HOME };
  const home = mkdtempSync(join(tmpdir(), "neko-title-home-"));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    const c = render(<ChatApp fullscreen={false} yolo provider={new Echo()} sessionId="title-persist" />);
    await tick();
    c.stdin.write("/title A deliberately long persistent session title");
    await tick(20);
    c.stdin.write("\r");
    await tick();
    c.stdin.write("first real turn");
    await tick(20);
    c.stdin.write("\r");
    let title = "";
    for (let i = 0; i < 80; i++) {
      title = loadSession("title-persist")?.title ?? "";
      if (title) break;
      await tick(25);
    }
    expect(title).toBe("A deliberately long persistent session title");
    c.unmount();
  } finally {
    if (saved.up === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.up;
    if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
    rmSync(home, { recursive: true, force: true });
  }
});
