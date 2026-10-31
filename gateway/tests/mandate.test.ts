import { BorshAccountsCoder } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { ACCOUNT_SIZE, DEFAULT_PROGRAM_ID, MandateLoadError, getMandateStatus, loadConfig, loadMandate } from "../src";
import type { AccountFetcher, MandateErrorCode, RawAccount } from "../src";

// These tests need no validator: accounts are built from raw bytes laid out by hand from the Rust
// struct (programs/aegis/src/state.rs), independently of the Anchor coder the loader uses.

// Same reason as in src/mandate.ts: no JSON import statement.
const idl = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../src/idl/aegis.json"), "utf8")) as {
  address: string;
  accounts: Array<{ name: string; discriminator: number[] }>;
};

const config = loadConfig({});
const PROGRAM_ID = config.programId;
const DISC = Buffer.from(idl.accounts[0]!.discriminator);
const CREATED_AT = 1_793_312_617n;
const U64_MAX = (1n << 64n) - 1n;

const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const i64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(v); return b; };
const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };

interface Fields {
  sponsor: PublicKey; agent: PublicKey; mandateId: bigint; usdcMint: PublicKey;
  maxPerTx: bigint; maxTotal: bigint; totalSpent: bigint; dailyCap: bigint; dailySpent: bigint;
  currentDay: bigint; expiresAt: bigint; revoked: number; recipients: PublicKey[];
  createdAt: bigint; updatedAt: bigint; bump: number;
}

function defaults(): Fields {
  return {
    sponsor: key(1), agent: key(2), mandateId: 7n, usdcMint: key(3),
    maxPerTx: 100_000_000n, maxTotal: 250_000_000n, totalSpent: 40_000_000n,
    dailyCap: 200_000_000n, dailySpent: 5n, currentDay: 20_000n,
    expiresAt: CREATED_AT + 86_400n, revoked: 0, recipients: [key(4), key(5)],
    createdAt: CREATED_AT, updatedAt: CREATED_AT + 60n, bump: 0,
  };
}

function derive(sponsor: PublicKey, mandateId: bigint): { address: PublicKey; bump: number } {
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(mandateId);
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("mandate"), sponsor.toBuffer(), id],
    PROGRAM_ID
  );
  return { address, bump };
}

function encode(f: Fields): Buffer {
  const body = Buffer.concat([
    DISC, f.sponsor.toBuffer(), f.agent.toBuffer(), u64(f.mandateId), f.usdcMint.toBuffer(),
    u64(f.maxPerTx), u64(f.maxTotal), u64(f.totalSpent), u64(f.dailyCap), u64(f.dailySpent),
    i64(f.currentDay), i64(f.expiresAt), Buffer.from([f.revoked]),
    u32(f.recipients.length), ...f.recipients.map((r) => r.toBuffer()),
    i64(f.createdAt), i64(f.updatedAt), Buffer.from([f.bump]),
  ]);
  return Buffer.concat([body, Buffer.alloc(ACCOUNT_SIZE - body.length)]);
}

/** Builds a valid account at its real PDA address. Overrides are applied before encoding. */
function make(overrides: Partial<Fields> = {}) {
  const merged = { ...defaults(), ...overrides };
  const { address, bump } = derive(merged.sponsor, merged.mandateId);
  const fields: Fields = { ...merged, bump: overrides.bump ?? bump };
  return { address, fields, bytes: encode(fields) };
}

function fetcherFor(address: PublicKey, account: RawAccount): AccountFetcher {
  return async (a) => (a.equals(address) ? account : null);
}

async function load(address: PublicKey, data: Buffer, owner: PublicKey = PROGRAM_ID) {
  return loadMandate(address.toBase58(), { config, fetchAccount: fetcherFor(address, { owner, data }) });
}

async function expectLoadError(p: Promise<unknown>, code: MandateErrorCode): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect(e, `expected a MandateLoadError, got: ${String(e)}`).to.be.instanceOf(MandateLoadError);
    expect((e as MandateLoadError).code, `wrong error code: ${String(e)}`).to.equal(code);
    return;
  }
  expect.fail(`expected MandateLoadError ${code}, but loadMandate succeeded`);
}

describe("loadMandate: valid accounts", () => {
  it("loads a valid mandate and returns the correct normalized fields", async () => {
    const { address, fields, bytes } = make();
    const m = await load(address, bytes);
    expect(m).to.deep.equal({
      address: address.toBase58(),
      sponsor: fields.sponsor.toBase58(),
      agent: fields.agent.toBase58(),
      usdcMint: fields.usdcMint.toBase58(),
      maxAmountPerTx: 100_000_000n,
      maxTotalSpend: 250_000_000n,
      totalSpent: 40_000_000n,
      remainingAllowance: 210_000_000n,
      expiry: CREATED_AT + 86_400n,
      revoked: false,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT + 60n,
      allowedRecipients: [key(4).toBase58(), key(5).toBase58()],
    });
  });

  it("accepts the maximum of 5 recipients (no padding) and an empty allowlist", async () => {
    const five = make({ recipients: [key(10), key(11), key(12), key(13), key(14)] });
    expect((await load(five.address, five.bytes)).allowedRecipients).to.have.length(5);
    const none = make({ recipients: [] });
    expect((await load(none.address, none.bytes)).allowedRecipients).to.deep.equal([]);
  });

  it("computes the remaining allowance exactly for values above 2^53 (bigint, no precision loss)", async () => {
    const { address, bytes } = make({ maxPerTx: 100n, maxTotal: U64_MAX, totalSpent: 12_345_678_901_234_567n });
    const m = await load(address, bytes);
    expect(typeof m.remainingAllowance).to.equal("bigint");
    expect(m.remainingAllowance).to.equal(U64_MAX - 12_345_678_901_234_567n);
    expect(m.totalSpent).to.equal(12_345_678_901_234_567n);
    expect(m.maxTotalSpend).to.equal(U64_MAX);
  });

  it("hand-built layout equals the Anchor coder's own encoding", async () => {
    const coder = new BorshAccountsCoder(idl as unknown as ConstructorParameters<typeof BorshAccountsCoder>[0]);
    const { bytes } = make();
    const reencoded = await coder.encode("AgentMandate", coder.decode("AgentMandate", bytes));
    expect(reencoded.length).to.equal(169 + 4 + 2 * 32 + 17);
    expect(Buffer.compare(reencoded, bytes.subarray(0, reencoded.length))).to.equal(0);
  });
});

describe("loadMandate: input and account checks", () => {
  it("rejects invalid mandate addresses without touching the network", async () => {
    const bad: unknown[] = [
      "", " ", "abc", "not-base58!!", "0OIl", "1".repeat(33), "a".repeat(100),
      PublicKey.default.toBase58() + " ", 12345, null, undefined, {},
    ];
    let calls = 0;
    const fetchAccount: AccountFetcher = async () => { calls += 1; return null; };
    for (const b of bad) {
      await expectLoadError(loadMandate(b as string, { config, fetchAccount }), "INVALID_ADDRESS");
    }
    expect(calls).to.equal(0);
  });

  it("rejects a missing mandate account", async () => {
    const { address } = make();
    await expectLoadError(
      loadMandate(address.toBase58(), { config, fetchAccount: async () => null }),
      "NOT_FOUND"
    );
  });

  it("rejects an account owned by another program even when the bytes are perfectly valid", async () => {
    const { address, bytes } = make();
    await expectLoadError(load(address, bytes, key(9)), "WRONG_OWNER");
  });

  it("fails closed when the RPC call throws, without leaking the underlying error", async () => {
    const { address } = make();
    const fetchAccount: AccountFetcher = async () => {
      throw new Error("connect failed: http://user:secret@127.0.0.1:8899");
    };
    try {
      await loadMandate(address.toBase58(), { config, fetchAccount });
      expect.fail("expected loadMandate to throw");
    } catch (e) {
      expect(e).to.be.instanceOf(MandateLoadError);
      expect((e as MandateLoadError).code).to.equal("RPC_ERROR");
      expect((e as MandateLoadError).message).to.not.include("secret");
    }
  });
});

describe("loadMandate: malformed data", () => {
  it("rejects accounts of the wrong size", async () => {
    const { address, bytes } = make();
    for (const data of [
      Buffer.alloc(0), bytes.subarray(0, 100), bytes.subarray(0, 349), Buffer.concat([bytes, Buffer.alloc(1)]),
    ]) {
      await expectLoadError(load(address, data), "MALFORMED_DATA");
    }
  });

  it("rejects a wrong discriminator, all-zero data, and garbage", async () => {
    const { address, bytes } = make();
    const flipped = Buffer.from(bytes);
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    for (const data of [flipped, Buffer.alloc(ACCOUNT_SIZE), Buffer.alloc(ACCOUNT_SIZE, 0xab)]) {
      await expectLoadError(load(address, data), "MALFORMED_DATA");
    }
  });

  it("rejects an oversize recipient-list length field", async () => {
    const { address, bytes } = make();
    for (const length of [6, 0xffffffff]) {
      const data = Buffer.from(bytes);
      data.writeUInt32LE(length, 169);
      await expectLoadError(load(address, data), "MALFORMED_DATA");
    }
  });

  it("rejects non-zero bytes after the account data (the coder alone would accept them)", async () => {
    const { address, bytes } = make();
    const data = Buffer.from(bytes);
    data[349] = 9;
    await expectLoadError(load(address, data), "MALFORMED_DATA");
  });

  it("rejects a non-canonical revoked byte", async () => {
    const { address, bytes } = make({ revoked: 2 });
    await expectLoadError(load(address, bytes), "MALFORMED_DATA");
  });
});

describe("loadMandate: address derivation", () => {
  it("rejects valid mandate bytes that are not at the derived PDA address", async () => {
    const { bytes } = make();
    await expectLoadError(load(key(77), bytes), "PDA_MISMATCH");
  });

  it("rejects a stored bump that differs from the canonical bump", async () => {
    const canonical = derive(defaults().sponsor, defaults().mandateId).bump;
    const { address, bytes } = make({ bump: canonical === 255 ? 254 : canonical + 1 });
    await expectLoadError(load(address, bytes), "PDA_MISMATCH");
  });
});

describe("loadMandate: corrupt state", () => {
  it("rejects a mandate where totalSpent exceeds maxTotalSpend", async () => {
    for (const totalSpent of [250_000_001n, U64_MAX]) {
      const { address, bytes } = make({ totalSpent });
      await expectLoadError(load(address, bytes), "CORRUPT_STATE");
    }
  });

  it("rejects invalid limits", async () => {
    for (const o of [
      { maxPerTx: 0n },
      { maxPerTx: 300_000_000n },
      { maxTotal: 0n, maxPerTx: 0n, totalSpent: 0n },
    ] as Array<Partial<Fields>>) {
      const { address, bytes } = make(o);
      await expectLoadError(load(address, bytes), "CORRUPT_STATE");
    }
  });

  it("rejects an invalid agent or mint", async () => {
    for (const o of [
      { agent: defaults().sponsor },
      { agent: PublicKey.default },
      { usdcMint: PublicKey.default },
    ] as Array<Partial<Fields>>) {
      const { address, bytes } = make(o);
      await expectLoadError(load(address, bytes), "CORRUPT_STATE");
    }
  });

  it("rejects duplicate or default-key recipients", async () => {
    for (const recipients of [[key(4), key(4)], [PublicKey.default]]) {
      const { address, bytes } = make({ recipients });
      await expectLoadError(load(address, bytes), "CORRUPT_STATE");
    }
  });

  it("rejects an expiry that is not after the creation time", async () => {
    for (const expiresAt of [CREATED_AT, CREATED_AT - 1n]) {
      const { address, bytes } = make({ expiresAt });
      await expectLoadError(load(address, bytes), "CORRUPT_STATE");
    }
  });
});

describe("mandate status", () => {
  it("identifies a revoked mandate, and revoked takes precedence over expired", async () => {
    const { address, bytes } = make({ revoked: 1 });
    const m = await load(address, bytes);
    expect(m.revoked).to.equal(true);
    expect(getMandateStatus(m, 0n)).to.equal("REVOKED");
    expect(getMandateStatus(m, m.expiry + 1_000n)).to.equal("REVOKED");
  });

  it("identifies an expired mandate, with now >= expiry as the boundary", async () => {
    const { address, bytes } = make();
    const m = await load(address, bytes);
    expect(getMandateStatus(m, m.expiry - 1n)).to.equal("ACTIVE");
    expect(getMandateStatus(m, m.expiry)).to.equal("EXPIRED");
    expect(getMandateStatus(m, m.expiry + 1n)).to.equal("EXPIRED");
  });

  it("identifies an active mandate", async () => {
    const { address, bytes } = make();
    const m = await load(address, bytes);
    expect(m.revoked).to.equal(false);
    expect(getMandateStatus(m, CREATED_AT)).to.equal("ACTIVE");
  });
});

describe("committed IDL", () => {
  it("has the program address the gateway is configured with by default", () => {
    expect(idl.address).to.equal(DEFAULT_PROGRAM_ID);
  });

  it("uses the standard account discriminator for AgentMandate (sha256 of 'account:AgentMandate')", () => {
    const expected = createHash("sha256").update("account:AgentMandate").digest().subarray(0, 8);
    expect(Buffer.from(idl.accounts[0]!.discriminator).equals(expected)).to.equal(true);
  });

  it("matches the IDL built by anchor build (pending when target/ is absent)", function () {
    const built = path.resolve(__dirname, "../../target/idl/aegis.json");
    if (!fs.existsSync(built)) this.skip();
    expect(idl).to.deep.equal(JSON.parse(fs.readFileSync(built, "utf8")));
  });
});
