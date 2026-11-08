import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { NormalizedMandate, PolicyDecision, SimulationResult, TransactionSummary } from "./types";

/** Bump when the policy rules change, so a receipt says which rules produced it. */
export const POLICY_VERSION = "aegis-policy-1";

/**
 * A record of one decision, ALLOW or DENY. The summary hash commits to what the transaction was
 * decoded to be. Receipts are plain JSON; this MVP does not sign or chain them, so they are
 * evidence of what the gateway decided, not tamper-proof.
 */
export interface DecisionReceipt {
  receiptVersion: 1;
  receiptId: string;
  policyVersion: string;
  mandateAddress: string;
  /** null when the mandate could not be loaded. */
  sponsor: string | null;
  agent: string | null;
  decision: "ALLOW" | "DENY";
  reason: string;
  riskFlags: string[];
  transactionSummaryHash: string;
  checkedAt: string;
  simulation: SimulationResult;
}

export interface ReceiptStore {
  append(receipt: DecisionReceipt): void | Promise<void>;
  list(): DecisionReceipt[];
}

/** Deterministic JSON: object keys sorted, undefined dropped, bigint as "<n>n". Safe to hash. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return JSON.stringify(`${value.toString()}n`);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    default:
      return "null";
  }
}

export function hashSummary(summary: TransactionSummary): string {
  return createHash("sha256").update(canonicalJson(summary)).digest("hex");
}

function notRunSimulation(): SimulationResult {
  return {
    status: "NOT_RUN",
    error: null,
    logs: [],
    logsTruncated: false,
    unitsConsumed: null,
    accountsChecked: 0,
    accountChanges: [],
    unexpectedChanges: [],
  };
}

export function buildReceipt(
  decision: PolicyDecision,
  mandate: Pick<NormalizedMandate, "sponsor" | "agent"> | null
): DecisionReceipt {
  return {
    receiptVersion: 1,
    receiptId: randomUUID(),
    policyVersion: POLICY_VERSION,
    mandateAddress: decision.mandateAddress,
    sponsor: mandate === null ? null : mandate.sponsor,
    agent: mandate === null ? null : mandate.agent,
    decision: decision.decision,
    reason: decision.reason,
    riskFlags: [...decision.riskFlags],
    transactionSummaryHash: hashSummary(decision.transactionSummary),
    checkedAt: decision.checkedAt,
    simulation:
      decision.simulation === undefined
        ? notRunSimulation()
        : (JSON.parse(JSON.stringify(decision.simulation)) as SimulationResult),
  };
}

export class MemoryReceiptStore implements ReceiptStore {
  #items: DecisionReceipt[] = [];

  append(receipt: DecisionReceipt): void {
    this.#items.push(JSON.parse(JSON.stringify(receipt)) as DecisionReceipt);
  }

  list(): DecisionReceipt[] {
    return this.#items.map((r) => JSON.parse(JSON.stringify(r)) as DecisionReceipt);
  }
}

/** Append-only JSON Lines file: one receipt per line. Keep it out of git (gateway/receipts/ is ignored). */
export class JsonlReceiptStore implements ReceiptStore {
  readonly filePath: string;

  constructor(filePath: string) {
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw new Error("A receipt file path is required");
    }
    this.filePath = path.resolve(filePath);
  }

  append(receipt: DecisionReceipt): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  list(): DecisionReceipt[] {
    if (!fs.existsSync(this.filePath)) return [];
    return fs
      .readFileSync(this.filePath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as DecisionReceipt);
  }
}
