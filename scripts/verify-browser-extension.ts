import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

function isResourcePath(value: string | Record<string, string> | undefined): value is string {
  return typeof value === "string";
}

/** Validate local resources used by this extension, without executing its JavaScript. */
export async function verifyBrowserExtension(root: string): Promise<void> {
  root = resolve(root);
  const seen = new Set<string>();
  async function resource(reference: string, from = "manifest.json"): Promise<void> {
    if (/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(reference)) return;
    const file = resolve(root, dirname(from), reference.split(/[?#]/)[0]!);
    const name = relative(root, file);
    if (name === ".." || name.startsWith(`..${sep}`) || !file.startsWith(root + sep)) {
      throw new Error(`extension resource escapes package: ${reference} in ${from}`);
    }
    if (seen.has(file)) return;
    seen.add(file);
    if (!(await stat(file).catch(() => null))?.isFile()) {
      throw new Error(`missing extension resource: ${reference} (from ${from})`);
    }
    if (/\.html$/i.test(file)) {
      const html = (await readFile(file, "utf8")).replace(/<!--[\s\S]*?-->/g, "");
      for (const tag of html.matchAll(/<(?:script|link|img|iframe|source)\b[^>]*>/gi)) {
        for (const attr of tag[0].matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) await resource(attr[1]!, name);
      }
    } else if (/\.css$/i.test(file)) {
      const css = await readFile(file, "utf8");
      for (const match of css.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)|@import\s+["']([^"']+)["']/g)) await resource(match[1] ?? match[2]!, name);
    } else if (/\.js$/i.test(file)) {
      const js = await readFile(file, "utf8");
      // Static module imports and the literal chrome.scripting files used by this extension.
      for (const match of js.matchAll(/\b(?:from\s*|import\s*[\(]?\s*)["'](\.[^"']+)["']/g)) await resource(match[1]!, name);
      for (const list of js.matchAll(/\bfiles\s*:\s*\[([^\]]*)\]/g)) {
        for (const match of list[1]!.matchAll(/["']([^"']+)["']/g)) await resource(match[1]!);
      }
    }
  }
  const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
  const paths: Array<string | undefined> = [manifest.background?.service_worker, manifest.side_panel?.default_path,
    manifest.action?.default_popup, manifest.options_page, manifest.options_ui?.page,
    ...Object.values(manifest.icons ?? {}), ...Object.values(manifest.chrome_url_overrides ?? {})];
  const icon = manifest.action?.default_icon;
  paths.push(...(isResourcePath(icon) ? [icon] : Object.values(icon ?? {})));
  for (const entry of manifest.content_scripts ?? []) paths.push(...(entry.js ?? []), ...(entry.css ?? []));
  for (const path of paths) if (isResourcePath(path)) await resource(path);
  // Scan every packaged HTML/CSS/JS file, including resources loaded dynamically by the worker.
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(?:html|css|js)$/i.test(entry.name)) await resource(relative(root, path));
    }
  }
  await walk(root);
}
