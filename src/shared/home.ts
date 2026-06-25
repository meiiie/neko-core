import { homedir } from "node:os";

/**
 * The user's home directory — honors USERPROFILE/HOME before os.homedir().
 *
 * os.homedir() reads the OS passwd entry on Linux/macOS and ignores $HOME, which makes the
 * `~/.neko-core` path un-overridable (tests that point HOME at a temp dir silently hit the real
 * home). Reading the env first keeps it overridable and testable; USERPROFILE is checked first so a
 * Windows msys-style HOME ("/c/Users/...") never mangles the path. Resolves to the real home in
 * production on every platform.
 */
export function homeDir(): string {
  return process.env.USERPROFILE || process.env.HOME || homedir();
}
