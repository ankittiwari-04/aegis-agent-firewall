export type Decision = "ALLOW" | "DENY";

export type TransferSummary = {
  kind: "SOL" | "SPL_TOKEN";
  source?: string;
  destination: string;
  /** Base units as a decimal string. Never a JS number: u64 amounts can exceed 2^53. */
  amount: string;
  mint?: string;
  instructionIndex?: number;
  programId?: string;
  /** The account that authorizes the transfer (owner, delegate or multisig for SPL transfers). */
  authority?: string;
  /** SPL transfers: the wallet that owns the destination token account, resolved from chain data. */
  destinationOwner?: string;
};

export type TransactionSummary = {
  transactionType: TransactionKind;
  programIds: string[];
  transfers: TransferSummary[];
  authorityChanges: PolicyAuthorityChange[];
  unrecognizedInstructions: UnrecognizedInstructionSummary[];
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

// ---------------------------------------------------------------------------------------------
// Transaction decoder (Milestone 3C)
//
// Three different questions, never to be conflated:
//   1. DECODED:    did the bytes parse into a transaction we can analyze?  -> DecodedTransaction.valid
//   2. RECOGNIZED: do we understand every instruction in it?               -> DecodedTransaction.fullyRecognized
//   3. AUTHORIZED: is it allowed under the mandate?                        -> decided by the policy engine (3D), never here
// ---------------------------------------------------------------------------------------------

export type TransactionKind = "legacy" | "versioned" | "unknown";

export type InstructionClass =
  | "SYSTEM_TRANSFER"
  | "SYSTEM_ASSIGN"
  | "TOKEN_TRANSFER"
  | "TOKEN_TRANSFER_CHECKED"
  | "TOKEN_APPROVE"
  | "TOKEN_APPROVE_CHECKED"
  | "TOKEN_SET_AUTHORITY"
  | "COMPUTE_BUDGET"
  | "UNRECOGNIZED";

/** A transfer found in the transaction. Amounts are bigint: never convert to number. */
export type DecodedTransfer = {
  kind: "SOL" | "SPL_TOKEN";
  /** Position of the instruction in the transaction (all instructions are counted). */
  instructionIndex: number;
  programId: string;
  /** SOL: the paying account. SPL: the SOURCE TOKEN ACCOUNT. */
  source: string;
  /** SOL: the receiving account. SPL: the DESTINATION TOKEN ACCOUNT, not the recipient's wallet. */
  destination: string;
  amount: bigint;
  /** Only present when the instruction itself names the mint (TransferChecked). */
  mint?: string;
  decimals?: number;
  /** SPL: the owner or delegate (or the multisig account) that authorizes the transfer. */
  authority?: string;
  /** SPL multisig: the extra signer accounts that follow the fixed accounts. */
  additionalSigners: string[];
  destinationIsTokenAccount: boolean;
  /**
   * Facts this decoder cannot determine from the transaction alone, for example MINT_UNRESOLVED,
   * DESTINATION_OWNER_UNRESOLVED, TOKEN_2022_EXTENSIONS_UNRESOLVED. Never ignore these.
   */
  unresolved: string[];
};

/** An instruction that approves a delegate, reassigns ownership, or changes an authority. */
export type AuthorityChangeSummary = {
  kind: "SYSTEM_ASSIGN" | "TOKEN_APPROVE" | "TOKEN_SET_AUTHORITY";
  instructionIndex: number;
  programId: string;
  securitySensitive: true;
  /** The account being modified. */
  account: string;
  /** The account that authorizes the change (token instructions). */
  authority?: string;
  additionalSigners: string[];
  /** SYSTEM_ASSIGN: the program that will own the account. */
  newOwnerProgram?: string;
  /** TOKEN_APPROVE: the delegate being approved. */
  delegate?: string;
  /** TOKEN_APPROVE: how much the delegate may move. */
  amount?: bigint;
  mint?: string;
  decimals?: number;
  /** TOKEN_SET_AUTHORITY: the numeric authority type from the instruction. */
  authorityType?: number;
  /** TOKEN_SET_AUTHORITY: the new authority, or null when the authority is cleared. */
  newAuthority?: string | null;
  unresolved: string[];
};

export type UnrecognizedInstructionSummary = {
  instructionIndex: number;
  programId: string;
  accounts: string[];
  dataBase64: string;
  reason: string;
  /** True when the program is one this decoder knows but the instruction is not analyzed or is malformed. */
  knownProgram: boolean;
};

export type DecodedInstruction = {
  index: number;
  programId: string;
  accounts: string[];
  dataBase64: string;
  classification: InstructionClass;
  recognized: boolean;
};

export type DecodedTransaction = {
  /** The bytes parsed into a transaction this decoder can fully analyze. Says nothing about whether it is allowed. */
  valid: boolean;
  /** valid, and every instruction is recognized. Says nothing about whether it is allowed. */
  fullyRecognized: boolean;
  transactionType: TransactionKind;
  /** The accounts that must sign (fee payer first). Signatures are not verified. */
  signers: string[];
  /** Unique program IDs, in order of first appearance. */
  programIds: string[];
  /** Every top-level instruction, in order. */
  instructions: DecodedInstruction[];
  transfers: DecodedTransfer[];
  authorityChanges: AuthorityChangeSummary[];
  unrecognizedInstructions: UnrecognizedInstructionSummary[];
  /** Empty when valid. Each entry starts with a machine-readable code, for example "INVALID_BASE64: ...". */
  errors: string[];
};

// ---------------------------------------------------------------------------------------------
// Policy engine (Milestone 3D)
// ---------------------------------------------------------------------------------------------

/** JSON-safe version of AuthorityChangeSummary: the approval amount is a decimal string, not a bigint. */
export type PolicyAuthorityChange = Omit<AuthorityChangeSummary, "amount"> & { amount?: string };

/** Machine-readable reasons for a DENY. An ALLOW decision has none. */
export type RiskFlag =
  | "INVALID_INPUT"
  | "INTERNAL_ERROR"
  | "INVALID_MANDATE_ADDRESS"
  | "MANDATE_NOT_FOUND"
  | "MANDATE_RPC_ERROR"
  | "MANDATE_WRONG_OWNER"
  | "MANDATE_CORRUPT"
  | "MANDATE_REVOKED"
  | "MANDATE_EXPIRED"
  | "CLOCK_UNAVAILABLE"
  | "INVALID_BASE64"
  | "MALFORMED_TRANSACTION"
  | "LOOKUP_TABLE_UNRESOLVED"
  | "UNRECOGNIZED_INSTRUCTION"
  | "AUTHORITY_CHANGE_DETECTED"
  | "APPROVAL_DETECTED"
  | "NO_POLICY_RELEVANT_TRANSFER"
  | "UNSUPPORTED_ASSET"
  | "AGENT_MISMATCH"
  | "MINT_MISMATCH"
  | "TOKEN_ACCOUNT_OWNER_UNRESOLVED"
  | "TOKEN_2022_EXTENSIONS_UNRESOLVED"
  | "UNKNOWN_RECIPIENT"
  | "AMOUNT_EXCEEDS_PER_TRANSACTION_LIMIT"
  | "AMOUNT_EXCEEDS_REMAINING_ALLOWANCE"
  | "COMBINED_EXCEEDS_PER_TRANSACTION_LIMIT"
  | "COMBINED_EXCEEDS_REMAINING_ALLOWANCE";
