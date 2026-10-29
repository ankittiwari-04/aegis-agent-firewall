import { expect } from "chai";
import { evaluateTransaction } from "../src";

// Scaffold test: replaced by the real policy tests in Milestone 3D.
describe("policy engine scaffold (Milestone 3A)", () => {
  it("denies every transaction until the engine is implemented (fails closed)", async () => {
    const d = await evaluateTransaction({ mandateAddress: "anything", transactionBase64: "AAAA" });
    expect(d.decision).to.equal("DENY");
    expect(d.riskFlags).to.include("NOT_IMPLEMENTED");
    expect(d.transactionSummary).to.deep.equal({ transfers: [], programIds: [] });
    expect(new Date(d.checkedAt).toISOString()).to.equal(d.checkedAt);
  });
});
