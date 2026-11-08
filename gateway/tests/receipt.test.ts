import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { JsonlReceiptStore, MemoryReceiptStore, POLICY_VERSION, buildReceipt, canonicalJson, hashSummary } from "../src";
import type { DecisionReceipt, PolicyDecision, TransactionSummary } from "../src";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MANDATE = { sponsor: "SponsorKey111", agent: "AgentKey111" };

const summary = (amount = "5"): TransactionSummary => ({
  transactionType: "legacy",
  programIds: ["Prog1"],
  transfers: [{ kind: "SPL_TOKEN", destination: "Dest1", amount, instructionIndex: 0 }],
  authorityChanges: [],
  unrecognizedInstructions: [],
});

function decision(overrides: Partial<PolicyDecision> = {}): PolicyDecision {
  return {
    decision: "DENY",
    reason: "Mandate has been revoked",
    riskFlags: ["MANDATE_REVOKED"],
    mandateAddress: "MandateAddr111",
    checkedAt: "2026-11-07T10:00:00.000Z",
    transactionSummary: summary(),
    ...overrides,
  };
}

describe("canonicalJson and hashSummary", () => {
  it("sorts keys, drops undefined and encodes bigint deterministically", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] })).to.equal('{"a":[2,{"d":1}],"b":1}');
    expect(canonicalJson({ x: 5n })).to.equal('{"x":"5n"}');
    expect(canonicalJson({ s: 'a"b' })).to.equal('{"s":"a\\"b"}');
    expect(canonicalJson([undefined, null])).to.equal("[null,null]");
  });

  it("hashes the same summary identically whatever the key order, and different summaries differently", () => {
    const a = summary("5");
    const reordered = JSON.parse(
      '{"unrecognizedInstructions":[],"authorityChanges":[],"transfers":[{"instructionIndex":0,"amount":"5","destination":"Dest1","kind":"SPL_TOKEN"}],"programIds":["Prog1"],"transactionType":"legacy"}'
    ) as TransactionSummary;
    expect(hashSummary(a)).to.match(/^[0-9a-f]{64}$/);
    expect(hashSummary(reordered)).to.equal(hashSummary(a));
    expect(hashSummary(summary("6"))).to.not.equal(hashSummary(a));
  });
});

describe("buildReceipt", () => {
  it("has exactly the documented fields", () => {
    const d = decision();
    const r = buildReceipt(d, MANDATE);
    expect(Object.keys(r).sort()).to.deep.equal([
      "agent", "checkedAt", "decision", "mandateAddress", "policyVersion", "reason",
      "receiptId", "receiptVersion", "riskFlags", "simulation", "sponsor", "transactionSummaryHash",
    ]);
    expect(r).to.include({
      receiptVersion: 1, policyVersion: POLICY_VERSION, mandateAddress: "MandateAddr111",
      sponsor: "SponsorKey111", agent: "AgentKey111", decision: "DENY",
      reason: "Mandate has been revoked", checkedAt: "2026-11-07T10:00:00.000Z",
    });
    expect(r.riskFlags).to.deep.equal(["MANDATE_REVOKED"]);
    expect(r.transactionSummaryHash).to.equal(hashSummary(d.transactionSummary));
    expect(r.receiptId).to.match(UUID);
    expect(r.simulation.status).to.equal("NOT_RUN");
    expect(JSON.parse(JSON.stringify(r))).to.deep.equal(r);
  });

  it("gives every receipt a new id and does not share arrays with the decision", () => {
    const d = decision();
    const a = buildReceipt(d, MANDATE);
    const b = buildReceipt(d, MANDATE);
    expect(a.receiptId).to.not.equal(b.receiptId);
    expect(a.riskFlags).to.not.equal(d.riskFlags);
  });

  it("records null sponsor and agent when no mandate was loaded", () => {
    const r = buildReceipt(decision(), null);
    expect(r.sponsor).to.equal(null);
    expect(r.agent).to.equal(null);
  });

  it("embeds the simulation result when there is one", () => {
    const simulation = {
      status: "SUCCESS" as const, error: null, logs: ["Program log: ok"], logsTruncated: false,
      unitsConsumed: "4321", accountsChecked: 5, accountChanges: [], unexpectedChanges: [],
    };
    const r = buildReceipt(decision({ decision: "ALLOW", riskFlags: [], simulation }), MANDATE);
    expect(r.simulation).to.deep.equal(simulation);
    expect(r.simulation).to.not.equal(simulation);
  });
});

describe("receipt stores", () => {
  const receipt = (n: number): DecisionReceipt => buildReceipt(decision({ reason: `reason ${n}` }), MANDATE);

  it("MemoryReceiptStore keeps receipts in order and returns copies", () => {
    const store = new MemoryReceiptStore();
    const a = receipt(1);
    const b = receipt(2);
    store.append(a);
    store.append(b);
    expect(store.list()).to.deep.equal([a, b]);
    const listed = store.list();
    const first = listed[0];
    if (first === undefined) throw new Error("expected a receipt");
    first.reason = "tampered";
    expect(store.list()[0]?.reason).to.equal("reason 1");
  });

  describe("JsonlReceiptStore", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-receipts-"));
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("appends one JSON line per receipt, creates missing folders, and reads them back", () => {
      const file = path.join(dir, "nested", "receipts.jsonl");
      const store = new JsonlReceiptStore(file);
      expect(store.list()).to.deep.equal([]);
      const a = receipt(1);
      const b = receipt(2);
      store.append(a);
      store.append(b);
      const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
      expect(lines).to.have.length(2);
      expect(JSON.parse(lines[0] ?? "")).to.deep.equal(a);
      expect(store.list()).to.deep.equal([a, b]);
    });

    it("rejects an empty path", () => {
      expect(() => new JsonlReceiptStore("")).to.throw(/path is required/);
    });
  });
});
