import { isText } from "../shared/wire.ts";

/** Controller turns saved before `_neko_internal` existed. An explicit marker always wins, so a
 * current user can still begin a real message with one of these strings without being hidden. */
const LEGACY_INTERNAL_USER_PREFIXES = [
  "[Summary of earlier conversation]",
  "CLOSED-LOOP REVIEW (",
  "PLAN NOT COMPLETE:",
  "VALIDATION FAILED:",
  "VALIDATION REQUIRED:",
  "OUTCOME VERIFICATION REQUIRED:",
  "NO VERIFICATION EVIDENCE YET:",
  "VERIFY BEFORE FINISHING:",
  "[budget]",
  "[delivery]",
  "Step limit (",
  "Continue the task from where it was interrupted.",
];

export function isInternalUserMessage(message: any): boolean {
  if (message?._neko_internal === true) return true;
  if (message?._neko_internal === false || message?.role !== "user" || !isText(message.content)) return false;
  const content = message.content.trimStart();
  return LEGACY_INTERNAL_USER_PREFIXES.some((prefix) => content.startsWith(prefix));
}
