import {
  buildSkuSourcePlan,
  formatCliError,
  serializePlan,
  type ProcurementCategory,
  type ProcurementIdentifierKind,
} from "../../skills/procurement/scripts/source-plan.ts";

export interface ProcurementSourcePlanCommandInput {
  identifier?: string;
  category?: string;
  kind?: string;
  domains?: readonly string[];
}

export interface ProcurementCommandResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export const PROCUREMENT_SOURCE_PLAN_USAGE =
  "usage: neko procurement source-plan <identifier> [--kind auto|sku|mpn|gtin] " +
  "[--category laptop|phone|pc|generic] [--domain example.vn ...]";

/** Standalone-binary surface for the deterministic procurement planner. */
export function procurementSourcePlanCommand(
  input: ProcurementSourcePlanCommandInput,
): ProcurementCommandResult {
  if (!input.identifier?.trim()) {
    return { exitCode: 2, stderr: PROCUREMENT_SOURCE_PLAN_USAGE };
  }

  try {
    const plan = buildSkuSourcePlan(
      input.identifier,
      // SAFETY: argument was just matched against the category list.
      (input.category ?? "generic") as ProcurementCategory,
      input.domains ?? [],
      // SAFETY: argument was just matched against the identifier-kind list.
      (input.kind ?? "auto") as ProcurementIdentifierKind,
    );
    return { exitCode: 0, stdout: serializePlan(plan) };
  } catch (error) {
    return { exitCode: 2, stderr: formatCliError(error) };
  }
}
