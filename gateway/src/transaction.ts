import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import type {
  AuthorityChangeSummary,
  DecodedInstruction,
  DecodedTransaction,
  DecodedTransfer,
  InstructionClass,
  TransactionKind,
  UnrecognizedInstructionSummary,
} from "./types";

// Program IDs are hardcoded (no spl-token runtime dependency). A test checks them against the libraries.
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";

/** Solana's maximum serialized transaction size. Anything larger is rejected before parsing. */
export const MAX_TRANSACTION_BYTES = 1232;
const MAX_BASE64_LENGTH = Math.ceil(MAX_TRANSACTION_BYTES / 3) * 4;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

class DecodeFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DecodeFailure";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/**
 * Decodes a base64 serialized transaction into a structured summary of what it actually contains.
 *
 * FAILS CLOSED and NEVER THROWS: any problem yields `valid: false`, an error code and empty lists.
 * It does not sign, submit, simulate or approve anything, and it says nothing about whether the
 * transaction is allowed: that is the policy engine's job (Milestone 3D).
 */
export async function decodeTransaction(transactionBase64: string): Promise<DecodedTransaction> {
  let kind: TransactionKind = "unknown";
  try {
    const bytes = decodeBase64Strict(transactionBase64);
    const tx = parseTransaction(bytes);
    kind = tx.version === "legacy" ? "legacy" : "versioned";
    return analyze(tx, kind);
  } catch (e) {
    if (e instanceof DecodeFailure) return invalid(kind, e.code, e.message);
    return invalid(kind, "INTERNAL_ERROR", "Transaction could not be analyzed");
  }
}

// ---------------------------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------------------------

function invalid(transactionType: TransactionKind, code: string, message: string): DecodedTransaction {
  return {
    valid: false,
    fullyRecognized: false,
    transactionType,
    signers: [],
    programIds: [],
    instructions: [],
    transfers: [],
    authorityChanges: [],
    unrecognizedInstructions: [],
    errors: [`${code}: ${message}`],
  };
}

/**
 * Node's Buffer.from(s, "base64") silently skips junk characters, accepts URL-safe characters and
 * unpadded input, so canonical base64 is enforced explicitly: character set, padding, length, and a
 * re-encode round trip.
 */
function decodeBase64Strict(input: unknown): Buffer {
  if (typeof input !== "string") {
    throw new DecodeFailure("INVALID_BASE64", "Transaction must be a base64 string");
  }
  if (input.length === 0) throw new DecodeFailure("EMPTY_INPUT", "Transaction is empty");
  if (input.length > MAX_BASE64_LENGTH) {
    throw new DecodeFailure("TOO_LARGE", "Transaction exceeds the maximum size");
  }
  if (input.length % 4 !== 0 || !BASE64_PATTERN.test(input)) {
    throw new DecodeFailure("INVALID_BASE64", "Input is not canonical base64");
  }
  const bytes = Buffer.from(input, "base64");
  if (bytes.toString("base64") !== input) {
    throw new DecodeFailure("INVALID_BASE64", "Input is not canonical base64");
  }
  if (bytes.length > MAX_TRANSACTION_BYTES) {
    throw new DecodeFailure("TOO_LARGE", "Transaction exceeds the maximum size");
  }
  return bytes;
}

/**
 * Parses legacy and versioned transactions, then re-serializes and compares: the parser accepts
 * trailing bytes, so without this check we could analyze bytes the runtime would not parse the same way.
 */
function parseTransaction(bytes: Buffer): VersionedTransaction {
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(bytes);
  } catch {
    throw new DecodeFailure("MALFORMED_TRANSACTION", "Bytes are not a valid Solana transaction");
  }
  let reserialized: Uint8Array;
  try {
    reserialized = tx.serialize();
  } catch {
    throw new DecodeFailure("MALFORMED_TRANSACTION", "Bytes are not a valid Solana transaction");
  }
  if (Buffer.compare(Buffer.from(reserialized), bytes) !== 0) {
    throw new DecodeFailure(
      "NON_CANONICAL_ENCODING",
      "Transaction has trailing bytes or a non-canonical encoding"
    );
  }
  return tx;
}

// ---------------------------------------------------------------------------------------------
// Instruction analysis
// ---------------------------------------------------------------------------------------------

type Analysis =
  | { kind: "transfer"; classification: InstructionClass; transfer: DecodedTransfer }
  | { kind: "authority"; classification: InstructionClass; change: AuthorityChangeSummary }
  | { kind: "benign"; classification: InstructionClass }
  | { kind: "unrecognized"; reason: string; knownProgram: boolean };

interface InstructionContext {
  index: number;
  programId: string;
  accounts: string[];
  data: Buffer;
}

/** Account counts are checked before use, so a missing entry is an internal bug; it throws and fails closed. */
function at<T>(items: readonly T[], i: number): T {
  const value = items[i];
  if (value === undefined) throw new Error("internal: index out of range");
  return value;
}

function unrecognizedResult(reason: string, knownProgram: boolean): Analysis {
  return { kind: "unrecognized", reason, knownProgram };
}

function malformed(what: string): Analysis {
  return unrecognizedResult(`Malformed ${what}: unexpected data length or account count`, true);
}

function analyzeInstruction(ctx: InstructionContext): Analysis {
  switch (ctx.programId) {
    case SYSTEM_PROGRAM_ID:
      return analyzeSystem(ctx);
    case TOKEN_PROGRAM_ID:
    case TOKEN_2022_PROGRAM_ID:
      return analyzeToken(ctx);
    case COMPUTE_BUDGET_PROGRAM_ID:
      // Recognized, but its data (limits, priority fees) is not analyzed.
      return { kind: "benign", classification: "COMPUTE_BUDGET" };
    case ASSOCIATED_TOKEN_PROGRAM_ID:
      return unrecognizedResult("Associated Token Program instruction not analyzed", true);
    default:
      return unrecognizedResult("Unknown program", false);
  }
}

/** System Program instruction data starts with a u32 little-endian opcode. */
function analyzeSystem(ctx: InstructionContext): Analysis {
  const { data, accounts } = ctx;
  if (data.length < 4) return malformed("System Program instruction");
  const opcode = data.readUInt32LE(0);

  if (opcode === 2) {
    // Transfer: [opcode u32][lamports u64], accounts: [from, to]
    if (data.length !== 12 || accounts.length !== 2) return malformed("System transfer");
    return {
      kind: "transfer",
      classification: "SYSTEM_TRANSFER",
      transfer: {
        kind: "SOL",
        instructionIndex: ctx.index,
        programId: ctx.programId,
        source: at(accounts, 0),
        destination: at(accounts, 1),
        amount: data.readBigUInt64LE(4),
        additionalSigners: [],
        destinationIsTokenAccount: false,
        unresolved: [],
      },
    };
  }

  if (opcode === 1) {
    // Assign: [opcode u32][new owner program, 32 bytes], accounts: [account]
    if (data.length !== 36 || accounts.length !== 1) return malformed("System assign");
    return {
      kind: "authority",
      classification: "SYSTEM_ASSIGN",
      change: {
        kind: "SYSTEM_ASSIGN",
        instructionIndex: ctx.index,
        programId: ctx.programId,
        securitySensitive: true,
        account: at(accounts, 0),
        newOwnerProgram: new PublicKey(data.subarray(4, 36)).toBase58(),
        additionalSigners: [],
        unresolved: [],
      },
    };
  }

  return unrecognizedResult(`System Program instruction not analyzed (opcode ${opcode})`, true);
}

/**
 * Token and Token-2022 share these base layouts (observed with spl-token 0.4.15). Account counts are
 * minimums: multisig authorities append signer accounts after the fixed ones.
 * Token-2022 extension effects (transfer fees, hooks, confidential transfers) are NOT evaluated.
 */
function analyzeToken(ctx: InstructionContext): Analysis {
  const { data, accounts, programId } = ctx;
  if (data.length < 1) return malformed("Token instruction");
  const opcode = data.readUInt8(0);
  const ext = programId === TOKEN_2022_PROGRAM_ID ? ["TOKEN_2022_EXTENSIONS_UNRESOLVED"] : [];

  switch (opcode) {
    case 3: {
      // Transfer: [3][amount u64]; accounts: [source, destination, authority, ...multisig signers]
      // No mint in the instruction: it is not invented here.
      if (data.length !== 9 || accounts.length < 3) return malformed("Token transfer");
      return {
        kind: "transfer",
        classification: "TOKEN_TRANSFER",
        transfer: {
          kind: "SPL_TOKEN",
          instructionIndex: ctx.index,
          programId,
          source: at(accounts, 0),
          destination: at(accounts, 1),
          amount: data.readBigUInt64LE(1),
          authority: at(accounts, 2),
          additionalSigners: accounts.slice(3),
          destinationIsTokenAccount: true,
          unresolved: ["MINT_UNRESOLVED", "DESTINATION_OWNER_UNRESOLVED", ...ext],
        },
      };
    }
    case 12: {
      // TransferChecked: [12][amount u64][decimals u8]; accounts: [source, mint, destination, authority, ...signers]
      if (data.length !== 10 || accounts.length < 4) return malformed("Token transfer-checked");
      return {
        kind: "transfer",
        classification: "TOKEN_TRANSFER_CHECKED",
        transfer: {
          kind: "SPL_TOKEN",
          instructionIndex: ctx.index,
          programId,
          source: at(accounts, 0),
          destination: at(accounts, 2),
          amount: data.readBigUInt64LE(1),
          mint: at(accounts, 1),
          decimals: data.readUInt8(9),
          authority: at(accounts, 3),
          additionalSigners: accounts.slice(4),
          destinationIsTokenAccount: true,
          unresolved: ["DESTINATION_OWNER_UNRESOLVED", ...ext],
        },
      };
    }
    case 4: {
      // Approve: [4][amount u64]; accounts: [source, delegate, owner, ...signers]
      if (data.length !== 9 || accounts.length < 3) return malformed("Token approve");
      return {
        kind: "authority",
        classification: "TOKEN_APPROVE",
        change: {
          kind: "TOKEN_APPROVE",
          instructionIndex: ctx.index,
          programId,
          securitySensitive: true,
          account: at(accounts, 0),
          delegate: at(accounts, 1),
          authority: at(accounts, 2),
          additionalSigners: accounts.slice(3),
          amount: data.readBigUInt64LE(1),
          unresolved: [...ext],
        },
      };
    }
    case 13: {
      // ApproveChecked: [13][amount u64][decimals u8]; accounts: [source, mint, delegate, owner, ...signers]
      if (data.length !== 10 || accounts.length < 4) return malformed("Token approve-checked");
      return {
        kind: "authority",
        classification: "TOKEN_APPROVE_CHECKED",
        change: {
          kind: "TOKEN_APPROVE",
          instructionIndex: ctx.index,
          programId,
          securitySensitive: true,
          account: at(accounts, 0),
          mint: at(accounts, 1),
          delegate: at(accounts, 2),
          authority: at(accounts, 3),
          additionalSigners: accounts.slice(4),
          amount: data.readBigUInt64LE(1),
          decimals: data.readUInt8(9),
          unresolved: [...ext],
        },
      };
    }
    case 6: {
      // SetAuthority: [6][authority type u8][0] (clear, 3 bytes) or [6][type u8][1][new authority, 32 bytes] (35 bytes)
      // accounts: [account, current authority, ...signers]
      if ((data.length !== 3 && data.length !== 35) || accounts.length < 2) {
        return malformed("Token set-authority");
      }
      const flag = data.readUInt8(2);
      const shapeOk = (data.length === 3 && flag === 0) || (data.length === 35 && flag === 1);
      if (!shapeOk) return malformed("Token set-authority");
      return {
        kind: "authority",
        classification: "TOKEN_SET_AUTHORITY",
        change: {
          kind: "TOKEN_SET_AUTHORITY",
          instructionIndex: ctx.index,
          programId,
          securitySensitive: true,
          account: at(accounts, 0),
          authority: at(accounts, 1),
          additionalSigners: accounts.slice(2),
          authorityType: data.readUInt8(1),
          newAuthority: data.length === 35 ? new PublicKey(data.subarray(3, 35)).toBase58() : null,
          unresolved: [...ext],
        },
      };
    }
    default:
      return unrecognizedResult(`Token Program instruction not analyzed (opcode ${opcode})`, true);
  }
}

// ---------------------------------------------------------------------------------------------
// Whole-transaction analysis
// ---------------------------------------------------------------------------------------------

function analyze(tx: VersionedTransaction, kind: TransactionKind): DecodedTransaction {
  const message = tx.message;

  // Accounts loaded from lookup tables cannot be resolved without a network call. They could hide a
  // destination, so addresses are never guessed: the transaction is reported as unsupported.
  if (message.addressTableLookups.length > 0) {
    throw new DecodeFailure(
      "ADDRESS_LOOKUP_TABLES_UNSUPPORTED",
      "Transaction loads accounts from address lookup tables, which cannot be resolved here"
    );
  }

  const numSigners = message.header.numRequiredSignatures;
  if (
    numSigners < 1 ||
    tx.signatures.length !== numSigners ||
    message.staticAccountKeys.length < numSigners
  ) {
    throw new DecodeFailure("MALFORMED_TRANSACTION", "Signature header is inconsistent");
  }

  const keys = message.staticAccountKeys.map((k) => k.toBase58());
  const programIds: string[] = [];
  const instructions: DecodedInstruction[] = [];
  const transfers: DecodedTransfer[] = [];
  const authorityChanges: AuthorityChangeSummary[] = [];
  const unrecognizedInstructions: UnrecognizedInstructionSummary[] = [];

  for (const [index, ci] of message.compiledInstructions.entries()) {
    const programId = keys[ci.programIdIndex];
    if (programId === undefined) {
      throw new DecodeFailure(
        "INVALID_ACCOUNT_REFERENCE",
        `Instruction ${index} references a program outside the account list`
      );
    }
    const accounts = ci.accountKeyIndexes.map((i) => {
      const key = keys[i];
      if (key === undefined) {
        throw new DecodeFailure(
          "INVALID_ACCOUNT_REFERENCE",
          `Instruction ${index} references an account outside the account list`
        );
      }
      return key;
    });
    const data = Buffer.from(ci.data);
    const dataBase64 = data.toString("base64");

    if (!programIds.includes(programId)) programIds.push(programId);

    const analysis = analyzeInstruction({ index, programId, accounts, data });
    switch (analysis.kind) {
      case "transfer":
        transfers.push(analysis.transfer);
        break;
      case "authority":
        authorityChanges.push(analysis.change);
        break;
      case "benign":
        break;
      case "unrecognized":
        unrecognizedInstructions.push({
          instructionIndex: index,
          programId,
          accounts,
          dataBase64,
          reason: analysis.reason,
          knownProgram: analysis.knownProgram,
        });
        break;
    }

    instructions.push({
      index,
      programId,
      accounts,
      dataBase64,
      classification: analysis.kind === "unrecognized" ? "UNRECOGNIZED" : analysis.classification,
      recognized: analysis.kind !== "unrecognized",
    });
  }

  return {
    valid: true,
    fullyRecognized: unrecognizedInstructions.length === 0,
    transactionType: kind,
    signers: keys.slice(0, numSigners),
    programIds,
    instructions,
    transfers,
    authorityChanges,
    unrecognizedInstructions,
    errors: [],
  };
}
