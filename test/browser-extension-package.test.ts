import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dir, "..");
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "neko-extension-package-test-"));
  await cp(join(root, "scripts"), join(dir, "scripts"), { recursive: true });
  await cp(join(root, "browser-extension"), join(dir, "browser-extension"), { recursive: true });
  return dir;
}
async function pack(dir: string, extra: string[] = []) {
  const p = Bun.spawn([process.execPath, join(dir, "scripts/package-browser-extension.ts"), "--output", join(dir, "release.zip"), ...extra], { stdout: "pipe", stderr: "pipe" });
  return { code: await p.exited, error: await new Response(p.stderr).text() };
}
for (const missing of ["sidepanel.html", "sidepanel.js", "popup.css", "icons/icon-32.png", "control-indicator.js"]) {
  test(`packaging refuses missing referenced resource ${missing}`, async () => {
    const dir = await fixture();
    try {
      await rm(join(dir, "browser-extension", missing));
      const result = await pack(dir);
      expect(result.code).not.toBe(0);
      expect(result.error).toContain(missing);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
for (const mode of [[], ["--store-first-upload"]]) {
  test(`real ZIP contains the complete extension in ${mode.length ? "store" : "developer"} mode`, async () => {
    const dir = await fixture();
    try {
      const result = await pack(dir, mode);
      expect(result).toEqual({ code: 0, error: "" });
      const output = join(dir, "release.zip");
      const unpack = join(dir, "unpacked");
      const proc = process.platform === "win32"
        ? Bun.spawn(["powershell", "-NoProfile", "-Command", `Expand-Archive -LiteralPath '${output.replaceAll("'", "''")}' -DestinationPath '${unpack.replaceAll("'", "''")}'`], { stdout: "pipe", stderr: "pipe" })
        : Bun.spawn(["unzip", "-q", output, "-d", unpack], { stdout: "pipe", stderr: "pipe" });
      expect(await proc.exited).toBe(0);
      const manifest = JSON.parse(await readFile(join(unpack, "manifest.json"), "utf8"));
      expect(Boolean(manifest.key)).toBe(mode.length === 0);
      for (const file of [manifest.side_panel.default_path, "sidepanel.js", "control-indicator.js", "popup.css", "popup.js", "service-worker.js", "icons/icon-32.png"]) {
        expect(await readFile(join(unpack, file))).toEqual(await readFile(join(dir, "browser-extension", file)));
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 30_000);
}

// Execute the release workflow's actual packaging command: reverting it to an incomplete
// hand-written ZIP list must fail this regression even if the standalone packager stays correct.
test("release workflow emits the complete browser ZIP", async () => {
  const dir = await fixture();
  try {
    // SAFETY: this fixture reads the tracked release workflow, whose job/step shape is checked below.
    const workflow = Bun.YAML.parse(await readFile(join(root, ".github/workflows/release.yml"), "utf8")) as {
      jobs: { release: { steps: Array<{ name?: string; run?: string }> } };
    };
    const command = workflow.jobs.release.steps.find(step => step.name === "package the auditable unpacked browser extension")?.run;
    expect(command).toBeDefined();
    const result = Bun.spawn(["bash", "-c", command!], {
      cwd: dir, env: { ...process.env, GITHUB_REF_NAME: "v-package-test" }, stdout: "pipe", stderr: "pipe",
    });
    expect(await result.exited).toBe(0);
    const zip = join(dir, "neko-browser-extension-v-package-test.zip");
    const unpack = join(dir, "release-unpacked");
    const p = process.platform === "win32"
      ? Bun.spawn(["powershell", "-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip.replaceAll("'", "''")}' -DestinationPath '${unpack.replaceAll("'", "''")}'`], { stdout: "pipe", stderr: "pipe" })
      : Bun.spawn(["unzip", "-q", zip, "-d", unpack], { stdout: "pipe", stderr: "pipe" });
    expect(await p.exited).toBe(0);
    expect(await readFile(join(unpack, "sidepanel.html"))).toEqual(await readFile(join(dir, "browser-extension/sidepanel.html")));
    expect(await readFile(join(unpack, "sidepanel.js"))).toEqual(await readFile(join(dir, "browser-extension/sidepanel.js")));
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);
