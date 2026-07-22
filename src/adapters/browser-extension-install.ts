import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { openBrowser } from "./chatgpt-auth.ts";
import { NEKO_BROWSER_EXTENSION_ID } from "./browser-bridge.ts";
import { homeDir } from "../shared/home.ts";
import { VERSION } from "../shared/version.ts";

const REPOSITORY = "meiiie/neko-core";
const MAX_ASSET_BYTES = 2_000_000;
const ASSETS = [
  "manifest.json",
  "service-worker.js",
  "control-indicator.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
] as const;

export interface PrepareBrowserExtensionOptions {
  destination?: string;
  fetchImpl?: typeof fetch;
  force?: boolean;
  sourceRoot?: string;
  version?: string;
}

export interface BrowserExtensionSetup {
  mode: "store" | "unpacked";
  opened: boolean;
  path?: string;
  url?: string;
}

/** Honest setup copy: having the files is not the same as Chrome installing the extension.
 * `opts.pathOnClipboard` = the caller put the unpacked folder path on the clipboard (paste it into
 * the Load-unpacked dialog). `opts.profilePicker` = Chrome has multiple profiles, so a "Who's using
 * Chrome?" picker is likely - tell the user to pick their profile FIRST and do the steps there. */
export function browserExtensionSetupMessage(
  setup: BrowserExtensionSetup,
  opts: { pathOnClipboard?: boolean; profilePicker?: boolean } = {},
): string {
  if (setup.mode === "store") {
    return [
      setup.opened
        ? "Neko Browser Extension opened in the Chrome Web Store."
        : "Neko could not open Chrome automatically.",
      "Opening the listing does NOT prove the extension is installed. Choose 'Add to Chrome' once.",
      setup.url ? `listing: ${setup.url}` : "",
      "Then open the extension on the target tab and choose 'Attach this tab to Neko'.",
      "Neko continues automatically once the extension connects and a tab is attached.",
    ].filter(Boolean).join("\n");
  }
  return [
    "Neko Browser needs a ONE-TIME manual install in Chrome. Chrome does not let any app install an",
    "extension for you - the steps below are yours to do, and choosing a profile alone does nothing.",
    opts.profilePicker
      ? "If Chrome shows \"Who's using Chrome?\", pick the profile you want Neko to control, then do ALL of this IN THAT profile:"
      : "In Chrome:",
    "  1. Open  chrome://extensions",
    `  2. Turn ON 'Developer mode' (top-right toggle).`,
    `  3. Click 'Load unpacked' (top-left) and select this folder:`,
    `       ${setup.path}${opts.pathOnClipboard ? "   (already on your clipboard - paste it in the folder dialog)" : ""}`,
    "  4. Open a NORMAL website tab - any http/https page (NOT chrome://extensions itself).",
    "That's it - Neko attaches that tab automatically and continues. (If you ever want to pick the tab",
    "yourself, click the Neko Browser Bridge icon and choose 'Attach this tab to Neko'.)",
    setup.opened ? "" : "No supported Chromium browser was detected; open chrome://extensions manually.",
  ].filter(Boolean).join("\n");
}

/** Best-effort: does the user's Chrome have more than one profile? Then launching Chrome likely
 * shows the "Who's using Chrome?" picker, so the setup copy tells the user to choose a profile
 * FIRST and do the manual steps in it. Reads Chrome's Local State; false when it can't tell. */
export function chromeHasMultipleProfiles(): boolean {
  try {
    const path = process.platform === "win32"
      ? join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "User Data", "Local State")
      : process.platform === "darwin"
        ? join(homeDir(), "Library", "Application Support", "Google", "Chrome", "Local State")
        : join(homeDir(), ".config", "google-chrome", "Local State");
    if (!existsSync(path)) return false;
    const info = JSON.parse(readFileSync(path, "utf8"))?.profile?.info_cache;
    return !!info && typeof info === "object" && Object.keys(info).length > 1;
  } catch {
    return false;
  }
}

function extensionId(key: string): string {
  return [...createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 15])
    .map((nibble) => String.fromCharCode(97 + nibble))
    .join("");
}

async function validExtensionDirectory(path: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
    if (manifest.manifest_version !== 3 || typeof manifest.key !== "string") return false;
    if (extensionId(manifest.key) !== NEKO_BROWSER_EXTENSION_ID) return false;
    return ASSETS.every((asset) => existsSync(join(path, asset)));
  } catch {
    return false;
  }
}

/** The owner adds this explicit id after the first Chrome Web Store upload. */
export function browserStoreUrl(id: string): string | null {
  if (!/^[a-p]{32}$/.test(id)) return null;
  return id ? `https://chromewebstore.google.com/detail/${id}` : null;
}

/**
 * Return an auditable unpacked extension directory. Source checkouts use their local files; a released
 * single binary downloads the ten fixed assets from its exact versioned Git tag into the user's Neko home.
 */
export async function prepareBrowserExtension(options: PrepareBrowserExtensionOptions = {}): Promise<string> {
  const sources = options.sourceRoot
    ? [resolve(options.sourceRoot, "browser-extension")]
    : [resolve(process.cwd(), "browser-extension"), resolve(import.meta.dir, "..", "..", "browser-extension")];
  for (const source of [...new Set(sources)]) {
    if (await validExtensionDirectory(source)) return source;
  }

  const version = options.version ?? VERSION;
  const destination = resolve(options.destination ?? join(homeDir(), ".neko-core", "browser-extension"));
  const marker = join(destination, ".neko-version");
  if (!options.force && await validExtensionDirectory(destination)) {
    try {
      if ((await readFile(marker, "utf8")).trim() === version) return destination;
    } catch { /* refresh an unversioned developer install */ }
  }

  const parent = dirname(destination);
  const stage = join(parent, `.browser-extension-${randomUUID()}`);
  const backup = `${destination}.old`;
  const fetchImpl = options.fetchImpl ?? fetch;
  await mkdir(stage, { recursive: true, mode: 0o700 });
  try {
    for (const asset of ASSETS) {
      const url = `https://raw.githubusercontent.com/${REPOSITORY}/v${version}/browser-extension/${asset}`;
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`could not download ${asset} (HTTP ${response.status})`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_ASSET_BYTES) throw new Error(`invalid browser extension asset: ${asset}`);
      const output = join(stage, asset);
      await mkdir(dirname(output), { recursive: true, mode: 0o700 });
      await writeFile(output, bytes);
    }
    await writeFile(join(stage, ".neko-version"), `${version}\n`, "utf8");
    if (!await validExtensionDirectory(stage)) throw new Error("downloaded browser extension failed identity validation");

    await rm(backup, { recursive: true, force: true });
    if (existsSync(destination)) await rename(destination, backup);
    try {
      await rename(stage, destination);
    } catch (error) {
      if (!existsSync(destination) && existsSync(backup)) await rename(backup, destination);
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
    return destination;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

type Chromium = { executable: string; scheme: "chrome" | "edge" };

function chromiumExecutable(): Chromium | null {
  const candidates: Chromium[] = process.platform === "win32" ? [
    { executable: join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"), scheme: "chrome" },
    { executable: join(process.env.PROGRAMFILES ?? "", "Google", "Chrome", "Application", "chrome.exe"), scheme: "chrome" },
    { executable: join(process.env["PROGRAMFILES(X86)"] ?? "", "Google", "Chrome", "Application", "chrome.exe"), scheme: "chrome" },
    { executable: join(process.env.PROGRAMFILES ?? "", "Microsoft", "Edge", "Application", "msedge.exe"), scheme: "edge" },
    { executable: join(process.env.LOCALAPPDATA ?? "", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"), scheme: "chrome" },
  ] : process.platform === "darwin" ? [
    { executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", scheme: "chrome" },
    { executable: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", scheme: "edge" },
    { executable: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", scheme: "chrome" },
  ] : [];
  const absolute = candidates.find((candidate) => existsSync(candidate.executable));
  if (absolute) return absolute;
  if (process.platform === "win32" || process.platform === "darwin") return null;
  for (const [name, scheme] of [["google-chrome", "chrome"], ["google-chrome-stable", "chrome"], ["chromium", "chrome"], ["microsoft-edge", "edge"], ["brave-browser", "chrome"]] as const) {
    const found = spawnSync("which", [name], { encoding: "utf8", windowsHide: true });
    if (found.status === 0 && found.stdout.trim()) return { executable: found.stdout.trim().split(/\r?\n/, 1)[0], scheme };
  }
  return null;
}

export function openChromiumPage(url: string): boolean {
  const browser = chromiumExecutable();
  if (!browser) {
    if (!/^https?:/.test(url)) return false;
    openBrowser(url);
    return true;
  }
  const target = browser.scheme === "edge" && url === "chrome://extensions" ? "edge://extensions" : url;
  const child = spawn(browser.executable, [target], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
  return true;
}

export function revealBrowserExtension(path: string): void {
  const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [path], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}

/** Open the one user-consented browser-install surface. Store is preferred; unpacked is a dev fallback. */
export async function openBrowserExtensionSetup(options: {
  force?: boolean;
  storeId?: string;
} = {}): Promise<BrowserExtensionSetup> {
  const url = browserStoreUrl(options.storeId ?? "");
  if (url) return { mode: "store", opened: openChromiumPage(url), url };

  const path = await prepareBrowserExtension({ force: options.force });
  const opened = openChromiumPage("chrome://extensions");
  revealBrowserExtension(path);
  return { mode: "unpacked", opened, path };
}
