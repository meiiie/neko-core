/** Host-owned per-turn capability planning. The planner consumes only the raw turn envelope and
 * trusted user/built-in routing metadata; prompt/context/tool output never grants capabilities. */
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  explicitProjectSkillRequest,
  explicitSkillRequest,
  isGenericMicrotaskSkill,
  listSkills,
  matchNonProjectSkills,
  singleFileMicrotaskPath,
} from "./skills.ts";

export const EXACT_FILE_TURN_TOOLS = Object.freeze(["read_file", "edit", "bash"] as const);

export type TurnCapabilitySource = "user" | "delegated" | "controller";

export interface TurnCapabilityInput {
  /** Exact human/delegated text before @file expansion, vision captions, memory, or project context. */
  rawUserText: string;
  source: TurnCapabilitySource;
  imageCount: number;
  attachmentCount: number;
  root: string;
  home: string;
}

export interface TurnCapabilityPlan {
  profile: "full" | "exact-file-edit";
  /** Undefined means the configured/role-restricted registry surface; a list only subtracts. */
  allowedTools?: readonly string[];
  allowBackgroundBash: boolean;
  target?: string;
  editTarget?: string;
  bashPolicy?: "foreground-validator-only";
  reason: string;
}

const FULL = (reason: string): TurnCapabilityPlan => ({
  profile: "full",
  allowBackgroundBash: true,
  reason,
});

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Resolve only a direct, project-relative regular file. Textual dot aliases and filesystem links do
 * not qualify for the narrow profile: ambiguity falls back to the existing full surface. */
function canonicalExistingTarget(root: string, rawPath: string): string | null {
  const normalized = rawPath.replaceAll("\\", "/");
  if (!normalized || isAbsolute(normalized) || /^(?:[a-z]:|\/\/)/i.test(normalized)) return null;
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  try {
    const requestedRoot = resolve(root);
    const rootStat = lstatSync(requestedRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    const rootPath = realpathSync(requestedRoot);
    const candidate = resolve(rootPath, ...segments);
    if (!inside(rootPath, candidate)) return null;
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return null;
    const real = realpathSync(candidate);
    if (!inside(rootPath, real)) return null;
    if (relative(candidate, real) !== "") return null;
    return relative(rootPath, real).split(sep).join("/");
  } catch {
    return null;
  }
}

/** Conservative optimization: FULL is the default. Narrowing needs the existing proof-grade natural
 * language predicate, a canonical existing target, no attachments, and no trusted domain route.
 * Project skill metadata is deliberately excluded; only an explicit raw-user skill name can widen. */
export function planTurnCapabilities(input: TurnCapabilityInput): TurnCapabilityPlan {
  const raw = String(input.rawUserText ?? "");
  if (input.source !== "user" && input.source !== "delegated") {
    return FULL("controller or unknown text is not user capability authority");
  }
  if (input.imageCount !== 0 || input.attachmentCount !== 0) {
    return FULL("attachments require the configured capability surface");
  }

  const namedTarget = singleFileMicrotaskPath(raw);
  if (!namedTarget) return FULL("turn is not a proof-grade exact-file microtask");
  const target = canonicalExistingTarget(input.root, namedTarget);
  if (!target) return FULL("the named target is not a canonical existing regular file inside the project");

  try {
    const installed = listSkills(input.root, input.home);
    if (installed.some((skill) => skill.source === "project"
      ? explicitProjectSkillRequest(raw, skill.name)
      : explicitSkillRequest(raw, skill.name))) {
      return FULL("the user explicitly requested an installed skill");
    }
    const hasTrustedDomainRoute = matchNonProjectSkills(raw, Number.MAX_SAFE_INTEGER, input.root, input.home)
      .some((skill) => !isGenericMicrotaskSkill(skill.name));
    if (hasTrustedDomainRoute) return FULL("a user-global or built-in domain skill matches the turn");
  } catch {
    return FULL("trusted capability routing is unavailable");
  }

  return {
    profile: "exact-file-edit",
    allowedTools: EXACT_FILE_TURN_TOOLS,
    allowBackgroundBash: false,
    target,
    editTarget: target,
    bashPolicy: "foreground-validator-only",
    reason: "canonical exact-file inspect/edit/foreground-verify microtask",
  };
}
