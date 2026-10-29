import type { EvaluateTransactionInput, PolicyDecision } from "./types";

/**
 * Milestone 3A scaffold. FAILS CLOSED: every transaction is denied until the policy engine
 * exists. Still to implement:
 *   3B: load and validate the AgentMandate account (fail closed if missing or malformed)
 *   3C: decode the serialized transaction into transfers and program IDs
 *   3D: enforce revoked / expired / recipient allowlist / per-tx cap / remaining allowance
 */
export async function evaluateTransaction(input: EvaluateTransactionInput): Promise<PolicyDecision> {
  return {
    decision: "DENY",
    reason: "Policy engine not implemented yet; denying by default",
    riskFlags: ["NOT_IMPLEMENTED"],
    mandateAddress: input.mandateAddress,
    checkedAt: new Date().toISOString(),
    transactionSummary: { transfers: [], programIds: [] },
  };
}
