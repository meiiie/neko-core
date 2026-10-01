/** Task identity is supplied by the runtime, never by model tool arguments. */
import { createHash, randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const taskScopes = new WeakSet<object>();

export interface TaskScope {
  readonly id: string;
  readonly canonicalRoot: string;
  readonly storageKey: string;
  readonly activationEpoch: number;
  readonly activationId: string;
  readonly executionAuthorityId?: string;
}

export interface TaskActivationIdentity {
  readonly activationEpoch: number;
  readonly activationId: string;
  readonly executionAuthorityId?: string;
}

/** The host owns the id and root. A task id has no authority to grant filesystem access. */
export function createTaskScope(id: string, root: string, activation?: TaskActivationIdentity): TaskScope {
  const identity = activation ?? { activationEpoch: 1, activationId: randomBytes(16).toString("hex") };
  if (!Number.isSafeInteger(identity.activationEpoch) || identity.activationEpoch < 1
    || !/^[a-f0-9]{32}$/.test(identity.activationId)
    || (identity.executionAuthorityId !== undefined && !/^[a-f0-9]{64}$/.test(identity.executionAuthorityId))) {
    throw new Error("Invalid runtime task activation");
  }
  // Validate the exported JavaScript boundary before regex/path APIs can coerce a foreign value.
  if (id !== String(id) || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid task id");
  if (root !== String(root) || !isAbsolute(root)) throw new Error("Task root must be absolute");
  const physicalRoot = realpathSync.native(resolve(root));
  if (!statSync(physicalRoot).isDirectory()) throw new Error("Task root must be a directory");
  const canonicalRoot = process.platform === "win32" ? physicalRoot.toLowerCase() : physicalRoot;
  const scope = Object.freeze({
    id,
    canonicalRoot,
    storageKey: createHash("sha256").update(id).digest("hex"),
    activationEpoch: identity.activationEpoch,
    activationId: identity.activationId,
    ...(identity.executionAuthorityId ? { executionAuthorityId: identity.executionAuthorityId } : undefined),
  });
  taskScopes.add(scope);
  return scope;
}

/** Reject a JSON/model-provided object that merely looks like a runtime scope. */
export function assertTaskScope(scope: TaskScope): void {
  if (!taskScopeIsActive(scope)) throw new Error("Task scope must come from the active runtime");
}

export function taskScopeIsActive(scope: TaskScope): boolean {
  return Boolean(scope && taskScopes.has(scope));
}

/** A committed switch/close retires the old runtime; retaining its object cannot retain authority. */
export function revokeTaskScope(scope: TaskScope): void {
  taskScopes.delete(scope);
}
