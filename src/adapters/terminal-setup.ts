/**
 * `neko setup terminal` — write a Shift+Enter -> ESC+CR keybinding into Windows Terminal's
 * settings.json (Claude Code's /terminal-setup affordance, for the one terminal it never covers).
 * TextInput turns the resulting ESC+CR into a newline (return+meta in Ink), so Shift+Enter starts
 * a new input line instead of submitting. Kitty-protocol terminals don't need this at all — Neko
 * pushes the kitty "disambiguate" flag in fullscreen and Shift+Enter arrives distinct natively.
 *
 * Safety posture: parse-or-refuse. The file is JSONC (comments + trailing commas tolerated by WT);
 * we strip those STRING-AWARELY, and if the result still doesn't parse we leave the file alone.
 * Every write is preceded by a sibling `.neko-bak` copy. A rewrite does not preserve comments —
 * the user is told, and the backup keeps the original.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ESC (0x1b) + CR (0x0d). Ink parses that to return+meta, which TextInput maps to a newline.
// Built from char codes so the source carries no raw control byte and no ambiguous escape.
export const SHIFT_ENTER_INPUT = String.fromCharCode(0x1b, 0x0d);
export const SHIFT_ENTER_BINDING = {
  keys: "shift+enter",
  command: { action: "sendInput", input: SHIFT_ENTER_INPUT },
};

/** Windows Terminal settings.json locations: Store stable, Store preview, unpackaged/portable. */
function candidatePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const local = env.LOCALAPPDATA;
  if (!local) return [];
  return [
    join(local, "Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState", "settings.json"),
    join(local, "Packages", "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe", "LocalState", "settings.json"),
    join(local, "Microsoft", "Windows Terminal", "settings.json"),
  ];
}

/** Strip JSONC comments and trailing commas so JSON.parse accepts a WT settings file. String-aware
 * on every pass: `//` or `,}` INSIDE a string value must survive untouched. Pure. */
export function stripJsonc(src: string): string {
  // Pass 1: drop // and /* */ comments outside strings.
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < src.length) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === "\\") { out += src[i + 1] ?? ""; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    out += c;
    i++;
  }
  // Pass 2: drop a comma whose next non-whitespace is } or ] — outside strings only.
  let res = "";
  i = 0;
  inStr = false;
  while (i < out.length) {
    const c = out[i];
    if (inStr) {
      res += c;
      if (c === "\\") { res += out[i + 1] ?? ""; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; res += c; i++; continue; }
    if (c === ",") {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] === "}" || out[j] === "]") { i++; continue; } // trailing comma - drop it
    }
    res += c;
    i++;
  }
  return res;
}

/** Compute the patched settings text, or explain why the file is left untouched. Pure. */
export function patchSettings(raw: string): { out?: string; note: string } {
  if (/shift\+enter/i.test(raw)) return { note: "a shift+enter binding already exists - left untouched" };
  let obj: any;
  try {
    obj = JSON.parse(stripJsonc(raw));
  } catch (e) {
    return { note: `could not parse it (${e instanceof Error ? e.message : String(e)}) - left untouched` };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { note: "unexpected settings shape - left untouched" };
  // Legacy inline {keys, command} in "actions" is accepted by every WT that also knows the newer
  // actions/keybindings split (WT migrates it) - one form covers all versions.
  const actions = Array.isArray(obj.actions) ? obj.actions : (obj.actions = []);
  actions.push(SHIFT_ENTER_BINDING);
  return { out: JSON.stringify(obj, null, 4) + "\n", note: "added Shift+Enter -> newline" };
}

/** Apply the binding to every Windows Terminal settings file present. */
export function setupTerminal(log: (m: string) => void): void {
  if (process.platform !== "win32") {
    log("setup terminal targets Windows Terminal (win32). On kitty-protocol terminals (kitty, WezTerm, foot, recent VS Code) Neko already receives Shift+Enter natively.");
    return;
  }
  const found = candidatePaths().filter((p) => existsSync(p));
  if (!found.length) {
    log("No Windows Terminal settings.json found (Store stable/preview or portable). Nothing changed.");
    return;
  }
  for (const path of found) {
    const raw = readFileSync(path, "utf-8");
    const patch = patchSettings(raw);
    if (!patch.out) {
      log(`${path}: ${patch.note}.`);
      continue;
    }
    copyFileSync(path, path + ".neko-bak");
    writeFileSync(path, patch.out);
    log(`${path}: ${patch.note} (backup: settings.json.neko-bak).`);
    if (/\/\/|\/\*/.test(raw)) log("  note: the rewrite does not preserve comments - the backup keeps the original.");
  }
  log("Done. Open a new Windows Terminal tab, then Shift+Enter inserts a newline in neko (plain Enter submits).");
}
