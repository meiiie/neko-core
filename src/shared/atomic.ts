/**
 * Atomic file write. Writes to a temp sibling, then renames it over the target. rename is atomic on the same
 * filesystem (libuv uses MoveFileEx + REPLACE_EXISTING on Windows), so a crash / kill / concurrent writer can
 * never observe a half-written file: the target is either the old bytes or the complete new bytes, never a
 * truncation. Use this for anything whose corruption means data LOSS — the session transcript, the user
 * config (which holds the API key), the NEKO.md memory. A plain writeFileSync truncates-then-writes, so an
 * interruption in that window leaves an unparseable file that loaders then silently drop.
 */
import { renameSync, rmSync, writeFileSync } from "node:fs";

let counter = 0;

export function atomicWriteFileSync(path: string, data: string, mode?: number): void {
  const tmp = `${path}.tmp-${process.pid}-${counter++}`;
  try {
    writeFileSync(tmp, data, { encoding: "utf-8", ...(mode === undefined ? {} : { mode }) });
    renameSync(tmp, path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort cleanup */ }
    throw err; // never leave the target corrupt: on failure the original bytes are still intact
  }
}
