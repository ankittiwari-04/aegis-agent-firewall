import { createHash } from "crypto";
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { GatewayConfig } from "./config";
import type { AccountChange, DecodedTransaction, SimulationResult } from "./types";

// Simulation never signs or submits anything. The transaction is simulated unsigned, with its
// blockhash replaced, and account state is compared before and after.

/** An account as the simulation compares it. Lamports are bigint: never a JS number. */
export interface AccountSnapshot {
  lamports: bigint;
  owner: string;
  executable: boolean;
  data: Buffer;
}

export interface RawSimulatedAccount {
  lamports: number;
  owner: string;
  executable: boolean;
  dataBase64: string;
}

export interface RawSimulation {
  /** null means the simulated transaction succeeded. Anything else is a failure. */
  err: unknown;
  logs: string[] | null;
  unitsConsumed?: number;
  accounts: Array<RawSimulatedAccount | null> | null;
}

export interface SimulationBackend {
  /** Current state of the accounts, in order. null means the account does not exist. */
  getAccounts(addresses: string[]): Promise<Array<AccountSnapshot | null>>;
  /** Simulates the unsigned transaction and returns the post-state of the given accounts, in order. */
  simulate(transactionBase64: string, addresses: string[]): Promise<RawSimulation>;
}

/** Largest fee-payer lamport decrease treated as an expected fee (0.001 SOL). */
export const DEFAULT_MAX_FEE_LAMPORTS = 1_000_000n;

const MAX_LOG_LINES = 200;
const MAX_LOG_LINE_LENGTH = 500;
const MAX_ACCOUNTS = 64;
const TOKEN_AMOUNT_OFFSET = 64;
const TOKEN_AMOUNT_END = 72;

/** Backend over the configured RPC (localnet or devnet only: the config enforces it), at confirmed commitment. */
export function connectionSimulationBackend(config: GatewayConfig): SimulationBackend {
  const connection = new Connection(config.rpcUrl, "confirmed");
  return {
    async getAccounts(addresses) {
      const infos = await connection.getMultipleAccountsInfo(
        addresses.map((a) => new PublicKey(a)),
        "confirmed"
      );
      return infos.map((info) => {
        if (info === null) return null;
        if (!Number.isSafeInteger(info.lamports)) throw new Error("lamports out of the safe range");
        return {
          lamports: BigInt(info.lamports),
          owner: info.owner.toBase58(),
          executable: info.executable,
          data: Buffer.from(info.data),
        };
      });
    },
    async simulate(transactionBase64, addresses) {
      const tx = VersionedTransaction.deserialize(Buffer.from(transactionBase64, "base64"));
      const { value } = await connection.simulateTransaction(tx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "confirmed",
        accounts: { encoding: "base64", addresses },
      });
      return {
        err: value.err,
        logs: value.logs,
        unitsConsumed: value.unitsConsumed,
        accounts:
          value.accounts === null || value.accounts === undefined
            ? null
            : value.accounts.map((a) => {
                if (a === null) return null;
                const first = a.data[0];
                if (typeof first !== "string") throw new Error("unexpected account data encoding");
                return { lamports: a.lamports, owner: a.owner, executable: a.executable, dataBase64: first };
              }),
      };
    },
  };
}

export interface RunSimulationArgs {
  transactionBase64: string;
  decoded: DecodedTransaction;
  backend: SimulationBackend;
  maxFeeLamports: bigint;
}

/**
 * Simulates the transaction and checks every account it touches. Only SUCCESS means: the simulation
 * ran without error and the only account changes are the token amounts of the decoded transfers
 * (exact amounts) and the fee payer paying a fee. Anything else is reported, never ignored.
 * Never throws; error text from the backend is not echoed (it could contain URLs).
 */
export async function runSimulation(args: RunSimulationArgs): Promise<SimulationResult> {
  try {
    return await simulateAndCheck(args);
  } catch {
    return result("UNAVAILABLE", "Simulation could not be completed");
  }
}

function result(
  status: SimulationResult["status"],
  error: string | null,
  rest: Partial<SimulationResult> = {}
): SimulationResult {
  return {
    status,
    error,
    logs: [],
    logsTruncated: false,
    unitsConsumed: null,
    accountsChecked: 0,
    accountChanges: [],
    unexpectedChanges: [],
    ...rest,
  };
}

async function simulateAndCheck(args: RunSimulationArgs): Promise<SimulationResult> {
  const { transactionBase64, decoded, backend, maxFeeLamports } = args;
  const addresses = collectAddresses(decoded);
  const feePayer = decoded.signers[0];
  if (!decoded.valid || feePayer === undefined || addresses.length === 0 || addresses.length > MAX_ACCOUNTS) {
    return result("UNAVAILABLE", "Transaction cannot be simulated: unexpected account list");
  }

  let pre: Array<AccountSnapshot | null>;
  try {
    pre = await backend.getAccounts(addresses);
  } catch {
    return result("UNAVAILABLE", "Account state could not be read before simulation");
  }
  if (!validSnapshots(pre, addresses.length)) {
    return result("UNAVAILABLE", "Account state could not be read before simulation");
  }

  let sim: RawSimulation;
  try {
    sim = await backend.simulate(transactionBase64, addresses);
  } catch {
    return result("UNAVAILABLE", "The simulation request failed");
  }
  if (typeof sim !== "object" || sim === null || sim.err === undefined) {
    return result("UNAVAILABLE", "The simulation returned a malformed response");
  }

  const cleaned = cleanLogs(sim.logs);
  const base: Partial<SimulationResult> = {
    logs: cleaned.logs,
    logsTruncated: cleaned.truncated,
    unitsConsumed: safeUnits(sim.unitsConsumed),
    accountsChecked: addresses.length,
  };

  if (sim.err !== null) return result("FAILED", describeError(sim.err), base);
  if (!Array.isArray(sim.accounts) || sim.accounts.length !== addresses.length) {
    return result(
      "UNAVAILABLE",
      "The simulation returned no account state, so account changes cannot be checked",
      base
    );
  }
  let post: Array<AccountSnapshot | null>;
  try {
    post = sim.accounts.map((a) => toSnapshot(a));
  } catch {
    return result("UNAVAILABLE", "The simulation returned malformed account state", base);
  }

  const tracker: Tracker = { changes: [], unexpected: [] };
  const deltas = expectedDeltas(decoded);
  for (let i = 0; i < addresses.length; i++) {
    const address = addresses[i];
    if (address === undefined) continue;
    const before = pre[i] ?? null;
    const after = post[i] ?? null;
    const delta = deltas.get(address);
    if (delta !== undefined) {
      checkTokenAccount(tracker, address, before, after, delta);
    } else if (address === feePayer) {
      checkFeePayer(tracker, address, before, after, maxFeeLamports);
    } else {
      recordDifferences(tracker, address, before, after);
    }
  }

  return result(tracker.unexpected.length === 0 ? "SUCCESS" : "UNEXPECTED_MUTATION", null, {
    ...base,
    accountChanges: tracker.changes,
    unexpectedChanges: tracker.unexpected,
  });
}

// ---------------------------------------------------------------------------------------------
// Account comparison
// ---------------------------------------------------------------------------------------------

interface Tracker {
  changes: AccountChange[];
  unexpected: string[];
}

function record(
  t: Tracker,
  address: string,
  field: string,
  before: string,
  after: string,
  expected: boolean,
  note?: string
): void {
  t.changes.push({ address, field, before, after, expected });
  if (!expected) {
    t.unexpected.push(`${address}: ${field} changed (${before} -> ${after})${note !== undefined ? `; ${note}` : ""}`);
  }
}

function digest(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

/** Every difference between two states is unexpected. Used for accounts that must not change. */
function recordDifferences(
  t: Tracker,
  address: string,
  before: AccountSnapshot | null,
  after: AccountSnapshot | null
): void {
  if (before === null && after === null) return;
  if (before === null) {
    record(t, address, "account", "absent", "created", false);
    return;
  }
  if (after === null) {
    record(t, address, "account", "present", "closed", false);
    return;
  }
  if (before.lamports !== after.lamports) {
    record(t, address, "lamports", before.lamports.toString(), after.lamports.toString(), false);
  }
  if (before.owner !== after.owner) record(t, address, "owner", before.owner, after.owner, false);
  if (before.executable !== after.executable) {
    record(t, address, "executable", String(before.executable), String(after.executable), false);
  }
  if (!before.data.equals(after.data)) record(t, address, "data", digest(before.data), digest(after.data), false);
}

function tokenAmount(data: Buffer): bigint | null {
  return data.length >= TOKEN_AMOUNT_END ? data.readBigUInt64LE(TOKEN_AMOUNT_OFFSET) : null;
}

function sameExceptAmount(a: Buffer, b: Buffer): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  x.fill(0, TOKEN_AMOUNT_OFFSET, TOKEN_AMOUNT_END);
  y.fill(0, TOKEN_AMOUNT_OFFSET, TOKEN_AMOUNT_END);
  return x.equals(y);
}

/** A token account named by a decoded transfer may change in exactly one way: its amount, by exactly the net delta. */
function checkTokenAccount(
  t: Tracker,
  address: string,
  before: AccountSnapshot | null,
  after: AccountSnapshot | null,
  delta: bigint
): void {
  if (before === null || after === null) {
    recordDifferences(t, address, before, after);
    if (before === null && after === null) {
      record(t, address, "token account", "absent", "absent", false, "a token account named by the transaction does not exist");
    }
    return;
  }
  if (before.lamports !== after.lamports) {
    record(t, address, "lamports", before.lamports.toString(), after.lamports.toString(), false);
  }
  if (before.owner !== after.owner) record(t, address, "owner", before.owner, after.owner, false);
  if (before.executable !== after.executable) {
    record(t, address, "executable", String(before.executable), String(after.executable), false);
  }
  const beforeAmount = tokenAmount(before.data);
  const afterAmount = tokenAmount(after.data);
  if (beforeAmount === null || afterAmount === null || before.data.length !== after.data.length) {
    record(t, address, "data", `${before.data.length} bytes`, `${after.data.length} bytes`, false, "token account layout changed");
    return;
  }
  if (!sameExceptAmount(before.data, after.data)) {
    record(t, address, "data", digest(before.data), digest(after.data), false, "bytes outside the token amount changed");
  }
  if (afterAmount - beforeAmount !== delta) {
    record(
      t,
      address,
      "token amount",
      beforeAmount.toString(),
      afterAmount.toString(),
      false,
      `expected a change of ${delta.toString()}`
    );
  } else if (delta !== 0n) {
    record(t, address, "token amount", beforeAmount.toString(), afterAmount.toString(), true);
  }
}

/** The fee payer may only lose lamports, and no more than the fee limit. */
function checkFeePayer(
  t: Tracker,
  address: string,
  before: AccountSnapshot | null,
  after: AccountSnapshot | null,
  maxFeeLamports: bigint
): void {
  if (before === null || after === null) {
    recordDifferences(t, address, before, after);
    if (before === null && after === null) {
      record(t, address, "fee payer", "absent", "absent", false, "the fee payer does not exist");
    }
    return;
  }
  if (before.owner !== after.owner) record(t, address, "owner", before.owner, after.owner, false);
  if (before.executable !== after.executable) {
    record(t, address, "executable", String(before.executable), String(after.executable), false);
  }
  if (!before.data.equals(after.data)) record(t, address, "data", digest(before.data), digest(after.data), false);
  const drop = before.lamports - after.lamports;
  const b = before.lamports.toString();
  const a = after.lamports.toString();
  if (drop < 0n) {
    record(t, address, "lamports", b, a, false, "the fee payer balance increased");
  } else if (drop > maxFeeLamports) {
    record(t, address, "lamports", b, a, false, `the fee payer lost more than the allowed fee of ${maxFeeLamports.toString()}`);
  } else if (drop > 0n) {
    record(t, address, "lamports", b, a, true);
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function collectAddresses(d: DecodedTransaction): string[] {
  const set = new Set<string>();
  for (const s of d.signers) set.add(s);
  for (const p of d.programIds) set.add(p);
  for (const ix of d.instructions) for (const a of ix.accounts) set.add(a);
  return [...set];
}

/** Net token-amount change expected per account from the decoded transfers. */
function expectedDeltas(decoded: DecodedTransaction): Map<string, bigint> {
  const deltas = new Map<string, bigint>();
  const add = (address: string, delta: bigint) => deltas.set(address, (deltas.get(address) ?? 0n) + delta);
  for (const t of decoded.transfers) {
    if (t.kind !== "SPL_TOKEN") continue;
    add(t.source, -t.amount);
    add(t.destination, t.amount);
  }
  return deltas;
}

function validSnapshots(items: unknown, expectedLength: number): items is Array<AccountSnapshot | null> {
  return (
    Array.isArray(items) &&
    items.length === expectedLength &&
    items.every(
      (a) =>
        a === null ||
        (typeof a === "object" &&
          typeof a.lamports === "bigint" &&
          typeof a.owner === "string" &&
          typeof a.executable === "boolean" &&
          Buffer.isBuffer(a.data))
    )
  );
}

function toSnapshot(raw: RawSimulatedAccount | null): AccountSnapshot | null {
  if (raw === null) return null;
  if (
    typeof raw !== "object" ||
    typeof raw.owner !== "string" ||
    typeof raw.executable !== "boolean" ||
    typeof raw.dataBase64 !== "string" ||
    !Number.isSafeInteger(raw.lamports) ||
    raw.lamports < 0
  ) {
    throw new Error("malformed simulated account");
  }
  const data = Buffer.from(raw.dataBase64, "base64");
  if (data.toString("base64") !== raw.dataBase64) throw new Error("malformed simulated account data");
  return { lamports: BigInt(raw.lamports), owner: raw.owner, executable: raw.executable, data };
}

function cleanLogs(logs: unknown): { logs: string[]; truncated: boolean } {
  if (!Array.isArray(logs)) return { logs: [], truncated: false };
  let truncated = logs.length > MAX_LOG_LINES;
  const out: string[] = [];
  for (const line of logs.slice(0, MAX_LOG_LINES)) {
    const text = typeof line === "string" ? line : "";
    if (text.length > MAX_LOG_LINE_LENGTH) truncated = true;
    out.push(text.slice(0, MAX_LOG_LINE_LENGTH));
  }
  return { logs: out, truncated };
}

function safeUnits(units: unknown): string | null {
  return typeof units === "number" && Number.isSafeInteger(units) && units >= 0 ? String(units) : null;
}

function describeError(err: unknown): string {
  if (typeof err === "string") return err.slice(0, 300);
  try {
    return (JSON.stringify(err) ?? "unknown error").slice(0, 300);
  } catch {
    return "unknown error";
  }
}
