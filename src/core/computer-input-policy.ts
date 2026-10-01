/** Trusted policy for Neko's local computer helpers; approval never widens it. */
export type ComputerInputPolicy = "background" | "foreground";
export const COMPUTER_INPUT_POLICY_CAPABILITY = "neko-computer-input-policy-v1";
export class ComputerInputPolicyCapabilityError extends Error {
  name = "ComputerInputPolicyCapabilityError";
}

export function parseComputerInputPolicy(value: string | undefined): ComputerInputPolicy {
  const policy = String(value === undefined ? "background" : value).trim().toLowerCase();
  if (policy === "background" || policy === "foreground") return policy;
  throw new Error("computer_use_input_policy must be background or foreground");
}

const PHYSICAL_ACTIONS = new Set(["activate", "ocr", "open", "click", "stroke", "type", "key", "scroll"]);

export function computerNeedsInteraction(action: string, policy: ComputerInputPolicy): string | undefined {
  if (policy === "foreground" || !PHYSICAL_ACTIONS.has(action)) return undefined;
  return `Error: computer needs_interaction: '${action}' requires foreground desktop interaction. ` +
    "The user can select computer_use_input_policy=foreground in global configuration or " +
    "NEKO_COMPUTER_USE_INPUT_POLICY before starting Neko; approval mode does not change this policy.";
}
