import { PublicKey } from "@solana/web3.js";
import { readChainTime } from "./clock";
import { loadConfig } from "./config";
import type { GatewayConfig } from "./config";
import { MandateLoadError, connectionFetcher, getMandateStatus, loadMandate } from "./mandate";
import type { AccountFetcher, MandateErrorCode, RawAccount } from "./mandate";
import { isPlainMint, parseTokenAccount } from "./tokenAccounts";
import { TOKEN_2022_PROGRAM_ID, decodeTransaction } from "./transaction";
import type {
  AuthorityChangeSummary,
  DecodedTransaction,
  DecodedTransfer,
  EvaluateTransactionInput,
  NormalizedMandate,
  PolicyAuthorityChange,
  PolicyDecision,
  RiskFlag,
  TransactionSummary,
  TransferSummary,
} from "./types";

export interface EvaluateOptions {
  /** Unix seconds. For tests only: production reads the chain's Clock sysvar. Never taken from the request. */
  nowSeconds?: bigint;
  fetchAccount?: AccountFetcher;
  config?: GatewayConfig;
}

interface Finding {
  flag: RiskFlag;
  reason: string;
}

interface Resolved {
  owner: string;
  mint: string;
}

type AccountGetter = (address: string) => Promise<RawAccount | null>;

const MANDATE_FLAGS: Record<MandateErrorCode, RiskFlag> = {
  INVALID_ADDRESS: "INVALID_MANDATE_ADDRESS",
  NOT_FOUND: "MANDATE_NOT_FOUND",
  RPC_ERROR: "MANDATE_RPC_ERROR",
  WRONG_OWNER: "MANDATE_WRONG_OWNER",
  MALFORMED_DATA: "MANDATE_CORRUPT",
  PDA_MISMATCH: "MANDATE_CORRUPT",
  CORRUPT_STATE: "MANDATE_CORRUPT",
};

// Decoder error codes that are not listed map to MALFORMED_TRANSACTION.
const DECODE_FLAGS: Record<string, RiskFlag> = {
  EMPTY_INPUT: "INVALID_BASE64",
  INVALID_BASE64: "INVALID_BASE64",
  ADDRESS_LOOKUP_TABLES_UNSUPPORTED: "LOOKUP_TABLE_UNRESOLVED",
};

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/**
 * Evaluates a serialized transaction against a mandate. FAILS CLOSED: it never throws, and every
 * path that is not a fully established ALLOW is a DENY. It does not sign, submit or simulate.
 *
 * Only `mandateAddress` and `transactionBase64` are read from `input`. The clock comes from the
 * chain (or `options.nowSeconds` in tests), never from the request.
 */
export async function evaluateTransaction(
  input: EvaluateTransactionInput,
  options: EvaluateOptions = {}
): Promise<PolicyDecision> {
  try {
    return await evaluate(input, options);
  } catch {
    return deny(
      echoAddress(input),
      [{ flag: "INTERNAL_ERROR", reason: "Policy evaluation failed unexpectedly; denying" }],
      emptySummary()
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------

async function evaluate(raw: unknown, options: EvaluateOptions): Promise<PolicyDecision> {
  const opts: EvaluateOptions = typeof options === "object" && options !== null ? options : {};

  if (typeof raw !== "object" || raw === null) {
    return deny("", [invalidInput("Input must be an object with mandateAddress and transactionBase64")], emptySummary());
  }
  const fields = raw as Record<string, unknown>;
  const mandateAddress = fields.mandateAddress;
  const transactionBase64 = fields.transactionBase64;
  if (typeof mandateAddress !== "string" || typeof transactionBase64 !== "string") {
    return deny(
      typeof mandateAddress === "string" ? mandateAddress : "",
      [invalidInput("mandateAddress and transactionBase64 must be strings")],
      emptySummary()
    );
  }
  if (opts.nowSeconds !== undefined && typeof opts.nowSeconds !== "bigint") {
    return deny(mandateAddress, [invalidInput("nowSeconds must be a bigint")], emptySummary());
  }

  const config = opts.config ?? loadConfig();
  const fetchAccount = opts.fetchAccount ?? connectionFetcher(config);

  // 1. The mandate.
  let mandate: NormalizedMandate;
  try {
    mandate = await loadMandate(mandateAddress, { config, fetchAccount });
  } catch (e) {
    if (e instanceof MandateLoadError) {
      return deny(
        mandateAddress,
        [{ flag: MANDATE_FLAGS[e.code], reason: `Mandate could not be loaded: ${e.message}` }],
        emptySummary()
      );
    }
    throw e;
  }
  if (mandate.revoked) {
    return deny(mandateAddress, [{ flag: "MANDATE_REVOKED", reason: "Mandate has been revoked" }], emptySummary());
  }

  // 2. The chain clock decides expiry.
  let now: bigint;
  if (opts.nowSeconds !== undefined) {
    now = opts.nowSeconds;
  } else {
    try {
      now = await readChainTime(fetchAccount);
    } catch {
      return deny(
        mandateAddress,
        [{ flag: "CLOCK_UNAVAILABLE", reason: "The chain clock could not be read, so expiry cannot be checked" }],
        emptySummary()
      );
    }
  }
  if (getMandateStatus(mandate, now) !== "ACTIVE") {
    return deny(mandateAddress, [{ flag: "MANDATE_EXPIRED", reason: "Mandate has expired" }], emptySummary());
  }

  // 3. The transaction.
  const decoded = await decodeTransaction(transactionBase64);
  if (!decoded.valid) {
    const message = decoded.errors[0] ?? "invalid transaction";
    const code = message.split(":")[0] ?? "";
    return deny(
      mandateAddress,
      [{ flag: DECODE_FLAGS[code] ?? "MALFORMED_TRANSACTION", reason: `Transaction rejected: ${message}` }],
      toSummary(decoded, [])
    );
  }

  // 4. Structural findings. These deny before any further network lookups.
  const findings: Finding[] = [];
  if (decoded.unrecognizedInstructions.length > 0) {
    findings.push({ flag: "UNRECOGNIZED_INSTRUCTION", reason: "Transaction contains an unrecognized instruction" });
  }
  if (decoded.authorityChanges.some((c) => c.kind !== "TOKEN_APPROVE")) {
    findings.push({ flag: "AUTHORITY_CHANGE_DETECTED", reason: "Transaction contains an authority change" });
  }
  if (decoded.authorityChanges.some((c) => c.kind === "TOKEN_APPROVE")) {
    findings.push({ flag: "APPROVAL_DETECTED", reason: "Transaction contains a token approval" });
  }
  if (decoded.transfers.length === 0) {
    findings.push({
      flag: "NO_POLICY_RELEVANT_TRANSFER",
      reason: "No policy-relevant transfer detected; refusing blanket approval",
    });
  }
  if (findings.length > 0) return deny(mandateAddress, findings, toSummary(decoded, []));

  // 5. Each transfer. Account lookups are cached, so each address is fetched at most once.
  const cache = new Map<string, Promise<RawAccount | null>>();
  const getAccount: AccountGetter = (address) => {
    let pending = cache.get(address);
    if (pending === undefined) {
      pending = fetchAccount(new PublicKey(address));
      cache.set(address, pending);
    }
    return pending;
  };
  let plainMint: Promise<boolean> | undefined;
  const mintIsPlain = (): Promise<boolean> => {
    plainMint ??= isPlainToken2022Mint(mandate.usdcMint, getAccount);
    return plainMint;
  };

  const resolved: Array<Resolved | undefined> = [];
  for (const t of decoded.transfers) {
    const n = t.instructionIndex;
    if (t.kind === "SOL") {
      findings.push({
        flag: "UNSUPPORTED_ASSET",
        reason: `Instruction ${n} transfers SOL; mandate limits are in token base units, so SOL transfers are not supported`,
      });
      resolved.push(undefined);
      continue;
    }

    if (t.authority !== mandate.agent || !decoded.signers.includes(mandate.agent)) {
      findings.push({ flag: "AGENT_MISMATCH", reason: `Instruction ${n} is not signed by the mandate's agent` });
    }
    if (t.mint !== undefined && t.mint !== mandate.usdcMint) {
      findings.push({ flag: "MINT_MISMATCH", reason: `Instruction ${n} moves a token other than the mandate's mint` });
    }

    const dest = await resolveDestination(t, getAccount);
    resolved.push(dest ?? undefined);
    if (dest === null) {
      findings.push({
        flag: "TOKEN_ACCOUNT_OWNER_UNRESOLVED",
        reason: `Instruction ${n}: the destination token account could not be resolved to an owner`,
      });
    } else {
      if (dest.mint !== mandate.usdcMint) {
        findings.push({
          flag: "MINT_MISMATCH",
          reason: `Instruction ${n}: the destination token account holds a different mint than the mandate`,
        });
      }
      if (!mandate.allowedRecipients.includes(dest.owner)) {
        findings.push({
          flag: "UNKNOWN_RECIPIENT",
          reason: `Instruction ${n}: recipient ${dest.owner} is not on the mandate allowlist`,
        });
      }
    }

    if (t.programId === TOKEN_2022_PROGRAM_ID && !(await mintIsPlain())) {
      findings.push({
        flag: "TOKEN_2022_EXTENSIONS_UNRESOLVED",
        reason: `Instruction ${n}: the Token-2022 mint could not be shown to have no extensions`,
      });
    }

    if (t.amount > mandate.maxAmountPerTx) {
      findings.push({
        flag: "AMOUNT_EXCEEDS_PER_TRANSACTION_LIMIT",
        reason: `Instruction ${n}: amount ${t.amount} exceeds the per-transaction limit ${mandate.maxAmountPerTx}`,
      });
    }
    if (t.amount > mandate.remainingAllowance) {
      findings.push({
        flag: "AMOUNT_EXCEEDS_REMAINING_ALLOWANCE",
        reason: `Instruction ${n}: amount ${t.amount} exceeds the remaining allowance ${mandate.remainingAllowance}`,
      });
    }
  }

  // 6. All transfers together. bigint cannot overflow, so the sum is exact.
  const splAmounts = decoded.transfers.filter((t) => t.kind === "SPL_TOKEN").map((t) => t.amount);
  if (splAmounts.length > 1) {
    const combined = splAmounts.reduce((a, b) => a + b, 0n);
    if (combined > mandate.maxAmountPerTx) {
      findings.push({
        flag: "COMBINED_EXCEEDS_PER_TRANSACTION_LIMIT",
        reason: `Transfers total ${combined}, above the per-transaction limit ${mandate.maxAmountPerTx}`,
      });
    }
    if (combined > mandate.remainingAllowance) {
      findings.push({
        flag: "COMBINED_EXCEEDS_REMAINING_ALLOWANCE",
        reason: `Transfers total ${combined}, above the remaining allowance ${mandate.remainingAllowance}`,
      });
    }
  }

  const summary = toSummary(decoded, resolved);
  if (findings.length > 0) return deny(mandateAddress, findings, summary);

  // ALLOW is built only here, and only after a final positive checklist.
  const everyTransferResolved =
    resolved.length === decoded.transfers.length && resolved.every((r) => r !== undefined);
  if (
    !decoded.valid ||
    !decoded.fullyRecognized ||
    decoded.transfers.length === 0 ||
    decoded.authorityChanges.length > 0 ||
    !everyTransferResolved
  ) {
    return deny(
      mandateAddress,
      [{ flag: "INTERNAL_ERROR", reason: "Not every allow condition was established; denying" }],
      summary
    );
  }
  return {
    decision: "ALLOW",
    reason: `All ${decoded.transfers.length} transfer(s) go to allowlisted recipients and are within the mandate limits`,
    riskFlags: [],
    mandateAddress,
    checkedAt: new Date().toISOString(),
    transactionSummary: summary,
  };
}

// ---------------------------------------------------------------------------------------------
// Token account resolution (never guesses: anything uncertain resolves to null)
// ---------------------------------------------------------------------------------------------

async function resolveDestination(t: DecodedTransfer, getAccount: AccountGetter): Promise<Resolved | null> {
  try {
    const account = await getAccount(t.destination);
    if (!account || !(account.owner instanceof PublicKey) || account.owner.toBase58() !== t.programId) {
      return null;
    }
    return parseTokenAccount(account.data, t.programId === TOKEN_2022_PROGRAM_ID);
  } catch {
    return null;
  }
}

async function isPlainToken2022Mint(mint: string, getAccount: AccountGetter): Promise<boolean> {
  try {
    const account = await getAccount(mint);
    if (!account || !(account.owner instanceof PublicKey) || account.owner.toBase58() !== TOKEN_2022_PROGRAM_ID) {
      return false;
    }
    return isPlainMint(account.data);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Decision building
// ---------------------------------------------------------------------------------------------

function invalidInput(reason: string): Finding {
  return { flag: "INVALID_INPUT", reason };
}

function echoAddress(input: unknown): string {
  try {
    if (typeof input === "object" && input !== null) {
      const address = (input as Record<string, unknown>).mandateAddress;
      if (typeof address === "string") return address;
    }
  } catch {
    // fall through
  }
  return "";
}

function emptySummary(): TransactionSummary {
  return { transactionType: "unknown", programIds: [], transfers: [], authorityChanges: [], unrecognizedInstructions: [] };
}

function deny(mandateAddress: string, findings: Finding[], summary: TransactionSummary): PolicyDecision {
  const riskFlags: RiskFlag[] = [];
  for (const f of findings) {
    if (!riskFlags.includes(f.flag)) riskFlags.push(f.flag);
  }
  return {
    decision: "DENY",
    reason: findings[0]?.reason ?? "Denied",
    riskFlags,
    mandateAddress,
    checkedAt: new Date().toISOString(),
    transactionSummary: summary,
  };
}

function toSummary(decoded: DecodedTransaction, resolved: Array<Resolved | undefined>): TransactionSummary {
  return {
    transactionType: decoded.transactionType,
    programIds: decoded.programIds,
    transfers: decoded.transfers.map((t, i) => toTransferSummary(t, resolved[i])),
    authorityChanges: decoded.authorityChanges.map(toAuthorityChange),
    unrecognizedInstructions: decoded.unrecognizedInstructions,
  };
}

/** The decision must survive JSON.stringify, which throws on bigint: amounts become decimal strings. */
function toTransferSummary(t: DecodedTransfer, resolved?: Resolved): TransferSummary {
  const summary: TransferSummary = {
    kind: t.kind,
    source: t.source,
    destination: t.destination,
    amount: t.amount.toString(),
    instructionIndex: t.instructionIndex,
    programId: t.programId,
  };
  const mint = t.mint ?? resolved?.mint;
  if (mint !== undefined) summary.mint = mint;
  if (t.authority !== undefined) summary.authority = t.authority;
  if (resolved !== undefined) summary.destinationOwner = resolved.owner;
  return summary;
}

function toAuthorityChange(c: AuthorityChangeSummary): PolicyAuthorityChange {
  const { amount, ...rest } = c;
  return amount === undefined ? rest : { ...rest, amount: amount.toString() };
}
