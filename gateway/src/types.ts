export type Decision = "ALLOW" | "DENY";

export type TransferSummary = {
  kind: "SOL" | "SPL_TOKEN";
  source?: string;
  destination: string;
  /** Base units as a decimal string. Never a JS number: u64 amounts can exceed 2^53. */
  amount: string;
  mint?: string;
};

export type TransactionSummary = {
  transfers: TransferSummary[];
  programIds: string[];
};

export type PolicyDecision = {
  decision: Decision;
  reason: string;
  riskFlags: string[];
  mandateAddress: string;
  checkedAt: string;
  transactionSummary: TransactionSummary;
};

export type EvaluateTransactionInput = {
  mandateAddress: string;
  transactionBase64: string;
};

/**
 * An AgentMandate loaded from chain and validated. All amounts are base units of `usdcMint`
 * and all timestamps are unix seconds. Amounts are bigint, never number.
 * The daily cap fields exist onchain but are deliberately not exposed: nothing enforces them yet.
 */
export type NormalizedMandate = {
  address: string;
  sponsor: string;
  agent: string;
  usdcMint: string;
  maxAmountPerTx: bigint;
  maxTotalSpend: bigint;
  totalSpent: bigint;
  /** maxTotalSpend - totalSpent. Never negative: a mandate with totalSpent > maxTotalSpend is rejected. */
  remainingAllowance: bigint;
  expiry: bigint;
  revoked: boolean;
  createdAt: bigint;
  updatedAt: bigint;
  allowedRecipients: string[];
};
