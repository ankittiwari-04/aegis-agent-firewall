import { AccountLayout, AccountState, TOKEN_PROGRAM_ID, createTransferCheckedInstruction } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { expect } from "chai";
import { DEFAULT_MAX_FEE_LAMPORTS, decodeTransaction, runSimulation } from "../src";
import type { AccountSnapshot, RawSimulation, SimulationBackend, SimulationResult } from "../src";
import { bankBackend } from "./helpers/simBackend";
import type { BankHooks, Provider } from "./helpers/simBackend";

const b58 = (k: PublicKey) => k.toBase58();
const AGENT = Keypair.generate().publicKey;
const SRC = Keypair.generate().publicKey;
const DEST = Keypair.generate().publicKey;
const MINT = Keypair.generate().publicKey;
const RECIPIENT = Keypair.generate().publicKey;
const OTHER = Keypair.generate().publicKey;
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const AMOUNT = 400_000n;

function tokenAccount(owner: PublicKey, amount: bigint): AccountSnapshot {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint: MINT, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: AccountState.Initialized,
      isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default,
    },
    data
  );
  return { lamports: 2_039_280n, owner: b58(TOKEN_PROGRAM_ID), executable: false, data };
}

const wallet = (lamports: bigint): AccountSnapshot => ({
  lamports, owner: b58(SystemProgram.programId), executable: false, data: Buffer.alloc(0),
});

function baseProvider(overrides: Record<string, AccountSnapshot | null> = {}): Provider {
  const accounts: Record<string, AccountSnapshot | null> = {
    [b58(AGENT)]: wallet(10_000_000_000n),
    [b58(SRC)]: tokenAccount(AGENT, 1_000_000n),
    [b58(DEST)]: tokenAccount(RECIPIENT, 500n),
    ...overrides,
  };
  return (address) => (address in accounts ? accounts[address] ?? null : wallet(1_000_000n));
}

async function decoded() {
  const tx = new Transaction();
  tx.feePayer = AGENT;
  tx.recentBlockhash = BLOCKHASH;
  tx.add(createTransferCheckedInstruction(SRC, MINT, DEST, AGENT, AMOUNT, 6));
  const base64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  const d = await decodeTransaction(base64);
  expect(d.valid).to.equal(true);
  return { base64, decoded: d };
}

async function simulate(hooks: BankHooks = {}, opts: { provider?: Provider; maxFee?: bigint } = {}) {
  const { base64, decoded: d } = await decoded();
  const backend = bankBackend(opts.provider ?? baseProvider(), hooks);
  const result = await runSimulation({
    transactionBase64: base64,
    decoded: d,
    backend,
    maxFeeLamports: opts.maxFee ?? DEFAULT_MAX_FEE_LAMPORTS,
  });
  return { result, backend };
}

async function withBackend(make: (inner: ReturnType<typeof bankBackend>) => SimulationBackend): Promise<SimulationResult> {
  const { base64, decoded: d } = await decoded();
  const backend = make(bankBackend(baseProvider()));
  return runSimulation({ transactionBase64: base64, decoded: d, backend, maxFeeLamports: DEFAULT_MAX_FEE_LAMPORTS });
}

describe("runSimulation: success", () => {
  it("accepts a clean simulation and records logs, compute units and the expected changes", async () => {
    const { result, backend } = await simulate();
    expect(result.status).to.equal("SUCCESS");
    expect(result.error).to.equal(null);
    expect(result.logs).to.deep.equal(["Program log: ok"]);
    expect(result.logsTruncated).to.equal(false);
    expect(result.unitsConsumed).to.equal("4321");
    expect(result.accountsChecked).to.equal(5);
    expect(result.unexpectedChanges).to.deep.equal([]);
    expect(backend.calls).to.deep.equal({ getAccounts: 1, simulate: 1 });

    const change = (address: PublicKey, field: string) =>
      result.accountChanges.find((c) => c.address === b58(address) && c.field === field);
    expect(change(SRC, "token amount")).to.deep.equal({
      address: b58(SRC), field: "token amount", before: "1000000", after: "600000", expected: true,
    });
    expect(change(DEST, "token amount")).to.deep.equal({
      address: b58(DEST), field: "token amount", before: "500", after: "400500", expected: true,
    });
    expect(change(AGENT, "lamports")).to.deep.equal({
      address: b58(AGENT), field: "lamports", before: "10000000000", after: "9999995000", expected: true,
    });
    expect(result.accountChanges).to.have.length(3);
    expect(JSON.parse(JSON.stringify(result))).to.deep.equal(result);
  });

  it("accepts a fee of zero and records no fee-payer change", async () => {
    const { result } = await simulate({ fee: 0n });
    expect(result.status).to.equal("SUCCESS");
    expect(result.accountChanges.some((c) => c.address === b58(AGENT))).to.equal(false);
  });
});

describe("runSimulation: simulation failure", () => {
  it("reports FAILED with the error and keeps the logs", async () => {
    const { result } = await simulate({ fail: { InstructionError: [0, { Custom: 1 }] } });
    expect(result.status).to.equal("FAILED");
    expect(result.error).to.include("InstructionError");
    expect(result.logs).to.deep.equal(["Program log: ok"]);
    expect(result.accountChanges).to.deep.equal([]);
    expect(result.unexpectedChanges).to.deep.equal([]);
  });

  it("reports FAILED when the transfer would overflow the destination", async () => {
    const provider = baseProvider({ [b58(DEST)]: tokenAccount(RECIPIENT, (1n << 64n) - 1n) });
    const { result } = await simulate({}, { provider });
    expect(result.status).to.equal("FAILED");
    expect(result.error).to.include("ArithmeticOverflow");
  });
});

describe("runSimulation: unexpected account mutations", () => {
  const cases: Array<{ name: string; address: PublicKey; hooks: BankHooks; provider?: Provider }> = [
    {
      name: "a change to an unrelated account's lamports",
      address: MINT,
      hooks: { mutate: (post) => { const a = post.get(b58(MINT)); if (a) a.lamports += 1n; } },
    },
    {
      name: "a destination token account reassigned to another owner program",
      address: DEST,
      hooks: { mutate: (post) => { const a = post.get(b58(DEST)); if (a) a.owner = b58(OTHER); } },
    },
    {
      name: "a delegate set on the destination (bytes outside the amount)",
      address: DEST,
      hooks: { mutate: (post) => { const a = post.get(b58(DEST)); if (a) a.data.writeUInt32LE(1, 72); } },
    },
    {
      name: "a source drained by more than the transfer",
      address: SRC,
      hooks: {
        mutate: (post) => {
          const a = post.get(b58(SRC));
          if (a) a.data.writeBigUInt64LE(a.data.readBigUInt64LE(64) - 1n, 64);
        },
      },
    },
    {
      name: "lamports moved out of a token account",
      address: DEST,
      hooks: { mutate: (post) => { const a = post.get(b58(DEST)); if (a) a.lamports -= 1n; } },
    },
    {
      name: "a fee payer that loses far more than a fee",
      address: AGENT,
      hooks: { mutate: (post) => { const a = post.get(b58(AGENT)); if (a) a.lamports -= 2_000_000n; } },
    },
    {
      name: "a fee payer that gains lamports",
      address: AGENT,
      hooks: { mutate: (post) => { const a = post.get(b58(AGENT)); if (a) a.lamports += 10_000n; } },
    },
    {
      name: "an account created by the transaction",
      address: MINT,
      provider: baseProvider({ [b58(MINT)]: null }),
      hooks: { mutate: (post) => { post.set(b58(MINT), wallet(1_000n)); } },
    },
    {
      name: "a destination token account closed",
      address: DEST,
      hooks: { mutate: (post) => { post.set(b58(DEST), null); } },
    },
    {
      name: "transfers that did not move the stated amounts",
      address: SRC,
      hooks: { skipTransfers: true },
    },
    {
      name: "a program account whose executable flag flipped",
      address: TOKEN_PROGRAM_ID,
      hooks: { mutate: (post) => { const a = post.get(b58(TOKEN_PROGRAM_ID)); if (a) a.executable = true; } },
    },
  ];

  for (const c of cases) {
    it(`rejects ${c.name}`, async () => {
      const { result } = await simulate(c.hooks, { provider: c.provider });
      expect(result.status).to.equal("UNEXPECTED_MUTATION");
      expect(result.error).to.equal(null);
      expect(result.unexpectedChanges.some((s) => s.startsWith(b58(c.address)))).to.equal(true);
      expect(result.accountChanges.some((x) => x.address === b58(c.address) && !x.expected)).to.equal(true);
    });
  }

  it("applies the fee limit: a fee above the configured maximum is unexpected", async () => {
    const { result } = await simulate({}, { maxFee: 1_000n });
    expect(result.status).to.equal("UNEXPECTED_MUTATION");
    expect(result.unexpectedChanges[0]).to.include(b58(AGENT));
    expect(result.unexpectedChanges[0]).to.include("allowed fee");
  });
});

describe("runSimulation: unavailable or malformed backend results", () => {
  it("reports UNAVAILABLE when account state cannot be read, without simulating or leaking the error", async () => {
    const { result, backend } = await simulate({ throwOnGetAccounts: true });
    expect(result.status).to.equal("UNAVAILABLE");
    expect(backend.calls.simulate).to.equal(0);
    expect(JSON.stringify(result)).to.not.include("secret");
  });

  it("reports UNAVAILABLE when the simulation request throws, without leaking the error", async () => {
    const { result } = await simulate({ throwOnSimulate: true });
    expect(result.status).to.equal("UNAVAILABLE");
    expect(JSON.stringify(result)).to.not.include("secret");
  });

  it("reports UNAVAILABLE when no account state comes back, because mutations cannot be checked", async () => {
    const { result } = await simulate({ omitAccounts: true });
    expect(result.status).to.equal("UNAVAILABLE");
    expect(result.logs).to.deep.equal(["Program log: ok"]);
  });

  it("reports UNAVAILABLE when too few accounts come back", async () => {
    const { result } = await simulate({ shortAccounts: true });
    expect(result.status).to.equal("UNAVAILABLE");
  });

  it("reports UNAVAILABLE for malformed responses", async () => {
    const noErr = await withBackend((inner) => ({
      getAccounts: (a) => inner.getAccounts(a),
      simulate: async (t, a) => ({ ...(await inner.simulate(t, a)), err: undefined }),
    }));
    expect(noErr.status).to.equal("UNAVAILABLE");

    const nullResponse = await withBackend((inner) => ({
      getAccounts: (a) => inner.getAccounts(a),
      simulate: async () => null as unknown as RawSimulation,
    }));
    expect(nullResponse.status).to.equal("UNAVAILABLE");

    const badData = await withBackend((inner) => ({
      getAccounts: (a) => inner.getAccounts(a),
      simulate: async (t, a) => {
        const r = await inner.simulate(t, a);
        return { ...r, accounts: (r.accounts ?? []).map((x) => (x === null ? null : { ...x, dataBase64: "!!!" })) };
      },
    }));
    expect(badData.status).to.equal("UNAVAILABLE");

    const unsafeLamports = await withBackend((inner) => ({
      getAccounts: (a) => inner.getAccounts(a),
      simulate: async (t, a) => {
        const r = await inner.simulate(t, a);
        return { ...r, accounts: (r.accounts ?? []).map((x) => (x === null ? null : { ...x, lamports: Number.MAX_SAFE_INTEGER + 2 })) };
      },
    }));
    expect(unsafeLamports.status).to.equal("UNAVAILABLE");

    const wrongPreLength = await withBackend((inner) => ({
      getAccounts: async (a) => (await inner.getAccounts(a)).slice(1),
      simulate: (t, a) => inner.simulate(t, a),
    }));
    expect(wrongPreLength.status).to.equal("UNAVAILABLE");
  });
});

describe("runSimulation: captured data", () => {
  it("caps logs and truncates long lines", async () => {
    const logs = Array.from({ length: 500 }, (_, i) => `Program log: line ${i}`);
    logs[0] = "x".repeat(2_000);
    const { result } = await simulate({ logs });
    expect(result.status).to.equal("SUCCESS");
    expect(result.logs).to.have.length(200);
    expect(result.logs[0]).to.have.length(500);
    expect(result.logsTruncated).to.equal(true);
  });

  it("drops invalid compute-unit values instead of guessing", async () => {
    for (const unitsConsumed of [-1, Number.NaN, 1.5]) {
      const { result } = await simulate({ unitsConsumed });
      expect(result.unitsConsumed, String(unitsConsumed)).to.equal(null);
    }
    const { result } = await simulate({ logs: null });
    expect(result.logs).to.deep.equal([]);
  });
});
