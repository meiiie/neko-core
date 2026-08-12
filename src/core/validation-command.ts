/** Commands whose exit status is direct acceptance evidence, not an incidental shell probe. Keep
 * this intentionally narrow: a failed `git status`, `pwd`, package lookup, or exploratory read must
 * not make an otherwise completed headless run fail. `rtk` is Neko's ordinary command wrapper. */
export function isValidationBashCommand(raw: string): boolean {
  const validators = new Set(["test", "tests", "typecheck", "lint", "check", "build", "verify"]);
  const validatorScript = (value: string) => validators.has(value.split(":", 1)[0] ?? "");
  const leaf = (value: string) => {
    const normalized = value.replace(/^["']+|["']+$/g, "").replace(/\\/g, "/");
    return normalized.slice(normalized.lastIndexOf("/") + 1).replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
  };
  for (const segment of String(raw).split(/\r?\n|&&|\|\||;/)) {
    const words = segment.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    while (words.length && /^[A-Za-z_]\w*=/.test(words[0] ?? "")) words.shift();
    if (leaf(words[0] ?? "") === "rtk") words.shift();
    let exe = leaf(words.shift() ?? "");
    if (["npx", "bunx"].includes(exe) && words.length) exe = leaf(words.shift()!);
    const args = words.map((word) => word.replace(/^["']+|["']+$/g, "").toLowerCase());
    if (["bun", "npm", "pnpm", "yarn"].includes(exe)) {
      if (args[0] === "run") args.shift();
      if (validatorScript(args[0] ?? "")) return true;
    } else if (["pytest", "py.test", "vitest", "jest", "mocha", "ava", "tsc"].includes(exe)) {
      return true;
    } else if (exe === "cargo" && ["test", "check", "clippy", "build"].includes(args[0] ?? "")) {
      return true;
    } else if (exe === "go" && args[0] === "test") {
      return true;
    } else if (exe === "dotnet" && ["test", "build"].includes(args[0] ?? "")) {
      return true;
    } else if (["mvn", "mvnw", "gradle", "gradlew", "make"].includes(exe)
      && args.some((arg) => validators.has(arg.replace(/^[-:]+/, "")))) {
      return true;
    }
  }
  return false;
}

/** A shell's aggregate zero is validator evidence only when composition cannot mask the validator's
 * failure. `&&` preserves failure; pipes, `||`, sequencing, redirection, and background execution do not. */
export function hasAuthoritativeValidatorExit(raw: string, args?: Record<string, any>): boolean {
  if (args?.run_in_background === true) return false;
  const command = String(raw);
  if (/\|\||[|;\r\n<>]/.test(command)) return false;
  return !command.replace(/&&/g, "").includes("&");
}

const VALIDATOR_SCRIPT_NAMES = new Set(["test", "tests", "typecheck", "lint", "check", "build", "verify"]);

/** Validator CLIs commonly expose convenience flags/scripts that also rewrite source or snapshots.
 * Those are useful in an ordinary full-capability turn, but they are not verification-only authority. */
function hasMutatingValidatorArgument(segment: string): boolean {
  const words = segment.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const args = words.map((word) => word.replace(/^["']+|["']+$/g, "").toLowerCase());
  return args.some((arg) => {
    const script = arg.split(":");
    if (VALIDATOR_SCRIPT_NAMES.has(script[0] ?? "")
      && script.slice(1).some((part) => /^(?:fix|write|update|snapshot)(?:$|[-_])/.test(part))) return true;
    return /^(?:-u|-w|--fix(?:$|[=_-])|--write(?:$|=)|--update(?:$|[=_-])|--update[-_]?snapshots?(?:$|=)|--updatesnapshot(?:s)?(?:$|=)|--snapshot[-_]?update(?:$|=))/.test(arg);
  });
}

/** Build targets produce project artifacts by design. They remain useful validation evidence in a
 * full turn, but an exact-file lease cannot grant output-producing build authority. */
function isBuildValidatorSegment(segment: string): boolean {
  const words = segment.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  while (words.length && /^[A-Za-z_]\w*=/.test(words[0] ?? "")) words.shift();
  const leaf = (value: string) => {
    const normalized = value.replace(/^["']+|["']+$/g, "").replace(/\\/g, "/");
    return normalized.slice(normalized.lastIndexOf("/") + 1).replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
  };
  if (leaf(words[0] ?? "") === "rtk") words.shift();
  let exe = leaf(words.shift() ?? "");
  if (["npx", "bunx"].includes(exe) && words.length) exe = leaf(words.shift()!);
  const args = words.map((word) => word.replace(/^["']+|["']+$/g, "").toLowerCase());
  if (["bun", "npm", "pnpm", "yarn"].includes(exe) && args[0] === "run") args.shift();
  if (["bun", "npm", "pnpm", "yarn"].includes(exe)) return (args[0] ?? "").split(":", 1)[0] === "build";
  if (["cargo", "dotnet"].includes(exe)) return args[0] === "build";
  return ["mvn", "mvnw", "gradle", "gradlew", "make"].includes(exe)
    && args.some((arg) => arg.replace(/^[-:]+/, "").split(":", 1)[0] === "build");
}

/** Exact-file turns may run validators, never a validator followed by a hidden mutation. Every `&&`
 * segment must independently be a non-mutating validator, and command/process substitution is refused. */
export function isForegroundValidatorOnlyCommand(raw: string, args?: Record<string, any>): boolean {
  const command = String(raw).trim();
  if (!command || !hasAuthoritativeValidatorExit(command, args)) return false;
  if (/\$\(|@\(|`|<\(|>\(/.test(command)) return false;
  return command.split("&&").every((segment) => segment.trim() !== ""
    && isValidationBashCommand(segment)
    && !isBuildValidatorSegment(segment)
    && !hasMutatingValidatorArgument(segment));
}
