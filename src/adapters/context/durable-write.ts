/** Atomic durable publication for opt-in structured task checkpoints. */
import {randomUUID} from "node:crypto";
import {closeSync, constants, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync} from "node:fs";
import {dirname} from "node:path";

export class StructuredCheckpointPublishedError extends Error {
  readonly published = true;
  constructor(cause: unknown) {
    super("Structured checkpoint was published but its final durability check failed; inspect the saved session before retrying", {cause});
  }
}

export function writeStructuredCheckpoint(path: string, text: string): void {
  const temporary = `${path}.tmp-${randomUUID()}`;
  let published = false;
  try {
    const output = openSync(temporary, "wx", 0o600);
    try { writeFileSync(output, text, "utf8"); fsyncSync(output); }
    finally { closeSync(output); }
    renameSync(temporary, path); published = true;
    if (process.platform !== "win32") {
      const directory = openSync(dirname(path), constants.O_RDONLY);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } catch (cause) {
    if (published) throw new StructuredCheckpointPublishedError(cause);
    try { unlinkSync(temporary); } catch { /* never replace the prior parent after failure */ }
    throw cause;
  }
}
