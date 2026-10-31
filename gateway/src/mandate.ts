import { BorshAccountsCoder } from "@anchor-lang/core";
import { Connection, PublicKey } from "@solana/web3.js";
import { loadConfig } from "./config";
import type { GatewayConfig } from "./config";
import * as fs from "fs";
import * as path from "path";
import type { NormalizedMandate } from "./types";

export type MandateErrorCode =
  | "INVALID_ADDRESS"
  | "NOT_FOUND"
  | "RPC_ERROR"
  | "WRONG_OWNER"
  | "MALFORMED_DATA"
  | "PDA_MISMATCH"
  | "CORRUPT_STATE";

export type MandateStatus = "ACTIVE" | "REVOKED" | "EXPIRED";

/** Every failure to load a trustworthy mandate. Callers must treat any throw as DENY. */
export class MandateLoadError extends Error {
  readonly code: MandateErrorCode;
  constructor(code: MandateErrorCode, message: string) {
    super(message);
    this.name = "MandateLoadError";
    this.code = code;
  }
}

export interface RawAccount {
  owner: PublicKey;
  data: Uint8Array;
}
export type AccountFetcher = (address: PublicKey) => Promise<RawAccount | null>;
export interface LoadMandateOptions {
  config?: GatewayConfig;
  fetchAccount?: AccountFetcher;
}

// Layout of the AgentMandate account (programs/aegis/src/state.rs). The program always allocates
// the full size: 8-byte discriminator + INIT_SPACE 342 = 350 (checked by a Rust unit test).
// TODO (Milestone 3D): confirm 350 against a real account on a live validator.
export const ACCOUNT_NAME = "AgentMandate";
export const ACCOUNT_SIZE = 350;
export const MAX_ALLOWED_RECIPIENTS = 5;
const REVOKED_OFFSET = 168; // bool, 1 byte
const VEC_LEN_OFFSET = 169; // u32 length of allowed_recipients
const PUBKEY_LEN = 32;
const TAIL_LEN = 17; // created_at (8) + updated_at (8) + bump (1)
const MANDATE_SEED = Buffer.from("mandate"); // must match MANDATE_SEED in the program

const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

// Read with fs, not a JSON import: Mocha 9 on Node 24 loads .ts files through a native import()
// first, which rejects JSON imports that carry no `with { type: "json" }` attribute.
// The build script copies src/idl/aegis.json to dist/idl/.
const idl: ConstructorParameters<typeof BorshAccountsCoder>[0] = JSON.parse(
  fs.readFileSync(path.join(__dirname, "idl", "aegis.json"), "utf8")
);
const coder = new BorshAccountsCoder(idl);

function malformed(message: string): MandateLoadError {
  return new MandateLoadError("MALFORMED_DATA", message);
}

function parseAddress(address: unknown): PublicKey {
  const invalid = new MandateLoadError("INVALID_ADDRESS", "Mandate address is not a valid public key");
  if (typeof address !== "string" || address.length < 32 || address.length > 44) throw invalid;
  let key: PublicKey;
  try {
    key = new PublicKey(address);
  } catch {
    throw invalid;
  }
  if (key.toBase58() !== address) throw invalid; // reject non-canonical encodings
  return key;
}

function connectionFetcher(config: GatewayConfig): AccountFetcher {
  const connection = new Connection(config.rpcUrl, "confirmed");
  return (address) => connection.getAccountInfo(address, "confirmed");
}

/**
 * The coder is lenient (it accepts padding garbage, any bool byte, and unchecked discriminators
 * elsewhere), so these structural checks run BEFORE decoding and are not optional.
 */
function checkLayout(data: Buffer): void {
  if (data.length !== ACCOUNT_SIZE) throw malformed("Unexpected account size");
  const revoked = data[REVOKED_OFFSET];
  if (revoked !== 0 && revoked !== 1) throw malformed("Invalid revoked flag");
  const count = data.readUInt32LE(VEC_LEN_OFFSET);
  if (count > MAX_ALLOWED_RECIPIENTS) throw malformed("Recipient list too long");
  const end = VEC_LEN_OFFSET + 4 + count * PUBKEY_LEN + TAIL_LEN;
  for (let i = end; i < data.length; i++) {
    if (data[i] !== 0) throw malformed("Non-zero bytes after the account data");
  }
}

function decodeAccount(data: Buffer): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = coder.decode(ACCOUNT_NAME, data); // decode(), never decodeUnchecked(): checks the discriminator
  } catch {
    throw malformed("Account data could not be decoded");
  }
  if (typeof decoded !== "object" || decoded === null) throw malformed("Account data could not be decoded");
  return decoded as Record<string, unknown>;
}

function toKey(value: unknown, field: string): PublicKey {
  if (!(value instanceof PublicKey)) throw malformed(`Invalid field: ${field}`);
  return value;
}

/** u64/i64 arrive as BN. Convert through a decimal string so no precision is ever lost. */
function toBigInt(value: unknown, field: string, min: bigint, max: bigint): bigint {
  if (typeof value !== "object" || value === null) throw malformed(`Invalid field: ${field}`);
  const toStr = (value as { toString?: unknown }).toString;
  if (typeof toStr !== "function") throw malformed(`Invalid field: ${field}`);
  const text = String((value as { toString: (base: number) => string }).toString(10));
  if (!/^-?\d+$/.test(text)) throw malformed(`Invalid field: ${field}`);
  const n = BigInt(text);
  if (n < min || n > max) throw malformed(`Field out of range: ${field}`);
  return n;
}

interface ParsedMandate {
  sponsor: PublicKey;
  agent: PublicKey;
  mandateId: bigint;
  usdcMint: PublicKey;
  maxPerTx: bigint;
  maxTotal: bigint;
  totalSpent: bigint;
  expiresAt: bigint;
  revoked: boolean;
  recipients: PublicKey[];
  createdAt: bigint;
  updatedAt: bigint;
  bump: number;
}

function parseFields(raw: Record<string, unknown>): ParsedMandate {
  const recipients = raw.allowed_recipients;
  if (!Array.isArray(recipients)) throw malformed("Invalid field: allowed_recipients");
  if (typeof raw.revoked !== "boolean") throw malformed("Invalid field: revoked");
  const bump = raw.bump;
  if (typeof bump !== "number" || !Number.isInteger(bump) || bump < 0 || bump > 255) {
    throw malformed("Invalid field: bump");
  }
  return {
    sponsor: toKey(raw.sponsor, "sponsor"),
    agent: toKey(raw.agent, "agent"),
    mandateId: toBigInt(raw.mandate_id, "mandate_id", 0n, U64_MAX),
    usdcMint: toKey(raw.usdc_mint, "usdc_mint"),
    maxPerTx: toBigInt(raw.max_per_tx, "max_per_tx", 0n, U64_MAX),
    maxTotal: toBigInt(raw.max_total, "max_total", 0n, U64_MAX),
    totalSpent: toBigInt(raw.total_spent, "total_spent", 0n, U64_MAX),
    expiresAt: toBigInt(raw.expires_at, "expires_at", I64_MIN, I64_MAX),
    revoked: raw.revoked,
    recipients: recipients.map((r: unknown) => toKey(r, "allowed_recipients")),
    createdAt: toBigInt(raw.created_at, "created_at", I64_MIN, I64_MAX),
    updatedAt: toBigInt(raw.updated_at, "updated_at", I64_MIN, I64_MAX),
    bump,
  };
}

/** The address must be exactly the PDA Aegis derives for this sponsor and mandate id, with the canonical bump. */
function checkDerivedAddress(address: PublicKey, p: ParsedMandate, programId: PublicKey): void {
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(p.mandateId);
  const [pda, bump] = PublicKey.findProgramAddressSync([MANDATE_SEED, p.sponsor.toBuffer(), id], programId);
  if (!pda.equals(address) || bump !== p.bump) {
    throw new MandateLoadError("PDA_MISMATCH", "Account is not the mandate PDA for its sponsor and id");
  }
}

/** Invariants the program guarantees at creation. A violation means the data is not what Aegis wrote. */
function checkInvariants(p: ParsedMandate): void {
  const corrupt = (m: string) => new MandateLoadError("CORRUPT_STATE", m);
  if (p.totalSpent > p.maxTotal) throw corrupt("Total spent exceeds the total limit");
  if (p.maxPerTx <= 0n) throw corrupt("Per-transaction limit must be positive");
  if (p.maxTotal <= 0n) throw corrupt("Total limit must be positive");
  if (p.maxPerTx > p.maxTotal) throw corrupt("Per-transaction limit exceeds the total limit");
  if (p.agent.equals(PublicKey.default) || p.agent.equals(p.sponsor)) throw corrupt("Invalid agent");
  if (p.usdcMint.equals(PublicKey.default)) throw corrupt("Invalid mint");
  if (p.recipients.some((r) => r.equals(PublicKey.default))) throw corrupt("Invalid recipient");
  if (new Set(p.recipients.map((r) => r.toBase58())).size !== p.recipients.length) {
    throw corrupt("Duplicate recipient");
  }
  if (p.expiresAt <= p.createdAt) throw corrupt("Expiry is not after creation");
}

/**
 * Loads and validates an AgentMandate. FAILS CLOSED: every problem throws a MandateLoadError
 * (and a config error throws a plain Error); there is no partial result. Callers must treat any
 * throw as DENY.
 */
export async function loadMandate(
  mandateAddress: string,
  options: LoadMandateOptions = {}
): Promise<NormalizedMandate> {
  const address = parseAddress(mandateAddress);
  const config = options.config ?? loadConfig();
  const fetchAccount = options.fetchAccount ?? connectionFetcher(config);

  let account: RawAccount | null;
  try {
    account = await fetchAccount(address);
  } catch {
    // The underlying error is dropped on purpose: it could contain the RPC URL.
    throw new MandateLoadError("RPC_ERROR", "Failed to fetch the mandate account");
  }
  if (account === null || account === undefined) {
    throw new MandateLoadError("NOT_FOUND", "Mandate account does not exist");
  }

  // Only the Aegis program can write to accounts it owns. Without this check, anyone could
  // deploy their own program and create a lookalike account with an identical layout.
  if (!(account.owner instanceof PublicKey) || !account.owner.equals(config.programId)) {
    throw new MandateLoadError("WRONG_OWNER", "Account is not owned by the Aegis program");
  }

  const data = Buffer.from(account.data);
  checkLayout(data);
  const parsed = parseFields(decodeAccount(data));
  checkDerivedAddress(address, parsed, config.programId);
  checkInvariants(parsed);

  return {
    address: address.toBase58(),
    sponsor: parsed.sponsor.toBase58(),
    agent: parsed.agent.toBase58(),
    usdcMint: parsed.usdcMint.toBase58(),
    maxAmountPerTx: parsed.maxPerTx,
    maxTotalSpend: parsed.maxTotal,
    totalSpent: parsed.totalSpent,
    remainingAllowance: parsed.maxTotal - parsed.totalSpent,
    expiry: parsed.expiresAt,
    revoked: parsed.revoked,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    allowedRecipients: parsed.recipients.map((r) => r.toBase58()),
  };
}

/**
 * Revoked takes precedence over expired, matching the program. Expired means now >= expiry:
 * the program treats a mandate as valid only strictly before expires_at.
 * `nowSeconds` should come from the chain's Clock sysvar (wired in at Milestone 3D).
 */
export function getMandateStatus(mandate: NormalizedMandate, nowSeconds: bigint): MandateStatus {
  if (mandate.revoked) return "REVOKED";
  if (nowSeconds >= mandate.expiry) return "EXPIRED";
  return "ACTIVE";
}
