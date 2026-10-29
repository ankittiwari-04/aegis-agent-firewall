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
