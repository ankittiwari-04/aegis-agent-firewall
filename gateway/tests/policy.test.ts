import {
  AccountLayout,
  AccountState,
  AccountType,
  AuthorityType,
  ExtensionType,
  MintLayout,
  MULTISIG_SIZE,
  TOKEN_2022_PROGRAM_ID as SPL_TOKEN_2022_ID,
  TOKEN_PROGRAM_ID as SPL_TOKEN_ID,
  createApproveInstruction,
  createSetAuthorityInstruction,
  createTransferCheckedInstruction,
  createTransferInstruction,
  getAccountLen,
  getMintLen,
} from "@solana/spl-token";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import {
  ACCOUNT_SIZE,
  MemoryReceiptStore,
  POLICY_VERSION,
  evaluateTransaction,
  evaluateWithReceipt,
  hashSummary,
  loadConfig,
  readChainTime,
} from "../src";
import type {
  AccountFetcher,
  DecisionReceipt,
  EvaluateOptions,
  EvaluateTransactionInput,
  PolicyDecision,
  RawAccount,
  ReceiptStore,
} from "../src";
import {
  ACCOUNT_STATE_INITIALIZED,
  ACCOUNT_TYPE_ACCOUNT,
  MINT_SIZE,
  MULTISIG_SIZE as OUR_MULTISIG_SIZE,
  TOKEN_ACCOUNT_SIZE,
  isPlainMint,
  parseTokenAccount,
} from "../src/tokenAccounts";
import { bankBackend } from "./helpers/simBackend";
import type { BankHooks, Provider } from "./helpers/simBackend";

// The chain is faked behind the injected account fetcher, so these tests need no validator.
// Mandate bytes are laid out by hand from the Rust struct; token accounts and mints are encoded
// by the real @solana/spl-token layouts; transactions come from the real web3.js / spl-token builders.

const idl = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../src/idl/aegis.json"), "utf8")) as {
  accounts: Array<{ discriminator: number[] }>;
};
const DISC = Buffer.from(idl.accounts[0]!.discriminator);
const config = loadConfig({});
const PROGRAM_ID = config.programId;
const U64_MAX = (1n << 64n) - 1n;
const NOW = 1_793_312_617n;
const CHECK_TIME = NOW + 100n;
const EXPIRES_AT = NOW + 86_400n;
const BLOCKHASH = Keypair.generate().publicKey.toBase58();

const k = (n: number) => new PublicKey(Buffer.alloc(32, n));
const b58 = (p: PublicKey) => p.toBase58();
const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const i64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(v); return b; };
const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };

const AGENT = Keypair.generate().publicKey;
const SPONSOR = k(1);
const MINT = k(3);
const OTHER_MINT = k(80);
const RECIPIENT = k(4);
const RECIPIENT_2 = k(5);
const STRANGER = k(9);
const DEST = k(20);
const DEST_2 = k(21);
const DEST_STRANGER = k(22);
const SRC = k(30);

// ---------- mandate account bytes ----------

interface Fields {
  sponsor: PublicKey; agent: PublicKey; mandateId: bigint; usdcMint: PublicKey;
  maxPerTx: bigint; maxTotal: bigint; totalSpent: bigint; dailyCap: bigint; dailySpent: bigint;
  currentDay: bigint; expiresAt: bigint; revoked: number; recipients: PublicKey[];
  createdAt: bigint; updatedAt: bigint; bump: number;
}

function defaults(): Fields {
  return {
    sponsor: SPONSOR, agent: AGENT, mandateId: 7n, usdcMint: MINT,
    maxPerTx: 100_000_000n, maxTotal: 250_000_000n, totalSpent: 40_000_000n,
    dailyCap: 200_000_000n, dailySpent: 5n, currentDay: 20_000n,
    expiresAt: EXPIRES_AT, revoked: 0, recipients: [RECIPIENT, RECIPIENT_2],
    createdAt: NOW, updatedAt: NOW + 60n, bump: 0,
  };
}

function derive(sponsor: PublicKey, mandateId: bigint): { address: PublicKey; bump: number } {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("mandate"), sponsor.toBuffer(), u64(mandateId)],
    PROGRAM_ID
  );
  return { address, bump };
}

function encodeMandate(f: Fields): Buffer {
  const body = Buffer.concat([
    DISC, f.sponsor.toBuffer(), f.agent.toBuffer(), u64(f.mandateId), f.usdcMint.toBuffer(),
    u64(f.maxPerTx), u64(f.maxTotal), u64(f.totalSpent), u64(f.dailyCap), u64(f.dailySpent),
    i64(f.currentDay), i64(f.expiresAt), Buffer.from([f.revoked]),
    u32(f.recipients.length), ...f.recipients.map((r) => r.toBuffer()),
    i64(f.createdAt), i64(f.updatedAt), Buffer.from([f.bump]),
  ]);
  return Buffer.concat([body, Buffer.alloc(ACCOUNT_SIZE - body.length)]);
}

function mandateAccount(overrides: Partial<Fields> = {}) {
  const f = { ...defaults(), ...overrides };
  const { address, bump } = derive(f.sponsor, f.mandateId);
  return { address, bytes: encodeMandate({ ...f, bump: overrides.bump ?? bump }) };
}

// ---------- token accounts, mints, clock ----------

function tokenAccountData(
  owner: PublicKey,
  mint: PublicKey = MINT,
  state: AccountState = AccountState.Initialized
): Buffer {
  const buf = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint, owner, amount: 1_000n, delegateOption: 0, delegate: PublicKey.default, state,
      isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    buf
  );
  return buf;
}

function mintData(length: number = MintLayout.span): Buffer {
  const buf = Buffer.alloc(length);
  MintLayout.encode(
    {
      mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 0n, decimals: 6,
      isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default,
    },
    buf
  );
  return buf;
}

function clockData(unix: bigint): Buffer {
  const b = Buffer.alloc(40);
  b.writeBigInt64LE(unix, 32);
  return b;
}

// ---------- the fake chain ----------

function makeChain(mandate: Partial<Fields> = {}) {
  const m = mandateAccount(mandate);
  const accounts = new Map<string, RawAccount | null>();
  const calls: string[] = [];
  accounts.set(b58(m.address), { owner: PROGRAM_ID, data: m.bytes });
  accounts.set(b58(DEST), { owner: SPL_TOKEN_ID, data: tokenAccountData(RECIPIENT) });
  accounts.set(b58(DEST_2), { owner: SPL_TOKEN_ID, data: tokenAccountData(RECIPIENT_2) });
  accounts.set(b58(DEST_STRANGER), { owner: SPL_TOKEN_ID, data: tokenAccountData(STRANGER) });
  const fetchAccount: AccountFetcher = async (a) => {
    calls.push(b58(a));
    return accounts.get(b58(a)) ?? null;
  };
  return { address: b58(m.address), fetchAccount, calls, accounts };
}
type Chain = ReturnType<typeof makeChain>;

function token2022Chain(mandate: Partial<Fields> = {}): Chain {
  const chain = makeChain(mandate);
  chain.accounts.set(b58(MINT), { owner: SPL_TOKEN_2022_ID, data: mintData() });
  chain.accounts.set(b58(DEST), { owner: SPL_TOKEN_2022_ID, data: tokenAccountData(RECIPIENT) });
  return chain;
}

// ---------- transactions ----------

function txBase64(feePayer: PublicKey, ixs: TransactionInstruction[]): string {
  const tx = new Transaction();
  tx.feePayer = feePayer;
  tx.recentBlockhash = BLOCKHASH;
  tx.add(...ixs);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

const checked = (amount: bigint, dest = DEST, authority = AGENT, programId = SPL_TOKEN_ID) =>
  createTransferCheckedInstruction(SRC, MINT, dest, authority, amount, 6, [], programId);
const plain = (amount: bigint, dest = DEST, authority = AGENT, programId = SPL_TOKEN_ID) =>
  createTransferInstruction(SRC, dest, authority, amount, [], programId);
const spl = (amount: bigint, dest = DEST) => txBase64(AGENT, [checked(amount, dest)]);
const unknownIx = () =>
  new TransactionInstruction({ programId: k(90), keys: [{ pubkey: k(91), isSigner: false, isWritable: true }], data: Buffer.from([7]) });

function lookupTableTx(): string {
  const ix = SystemProgram.transfer({ fromPubkey: AGENT, toPubkey: RECIPIENT, lamports: 1n });
  const lut = new AddressLookupTableAccount({
    key: k(70),
    state: {
      deactivationSlot: 0xffffffffffffffffn, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0,
      authority: undefined, addresses: [RECIPIENT],
    },
  });
  const msg = new TransactionMessage({ payerKey: AGENT, recentBlockhash: BLOCKHASH, instructions: [ix] }).compileToV0Message([lut]);
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
}

// ---------- running and asserting ----------

async function run(chain: Chain, tx: string, nowSeconds: bigint = CHECK_TIME): Promise<PolicyDecision> {
  return evaluateTransaction(
    { mandateAddress: chain.address, transactionBase64: tx },
    { nowSeconds, fetchAccount: chain.fetchAccount, config, simulationBackend: bankBackend(providerFor(chain)) }
  );
}

function expectDeny(d: PolicyDecision, flags: string[]): void {
  expect(d.decision).to.equal("DENY");
  expect(d.riskFlags).to.deep.equal(flags);
  expect(d.reason).to.be.a("string").and.not.equal("");
  expect(new Date(d.checkedAt).toISOString()).to.equal(d.checkedAt);
}

function expectAllow(d: PolicyDecision): void {
  expect(d.decision, `denied: ${d.reason} ${JSON.stringify(d.riskFlags)}`).to.equal("ALLOW");
  expect(d.riskFlags).to.deep.equal([]);
  expect(new Date(d.checkedAt).toISOString()).to.equal(d.checkedAt);
}

// =============================================================================================

describe("layout assumptions (checked against the libraries)", () => {
  it("matches @solana/spl-token for sizes, state values and markers", () => {
    expect(TOKEN_ACCOUNT_SIZE).to.equal(AccountLayout.span);
    expect(MINT_SIZE).to.equal(MintLayout.span);
    expect(OUR_MULTISIG_SIZE).to.equal(MULTISIG_SIZE);
    expect(ACCOUNT_STATE_INITIALIZED).to.equal(AccountState.Initialized);
    expect(ACCOUNT_TYPE_ACCOUNT).to.equal(AccountType.Account);
    expect(getMintLen([])).to.equal(MintLayout.span);
    expect(getMintLen([ExtensionType.TransferFeeConfig])).to.be.greaterThan(MintLayout.span);
    expect(getAccountLen([ExtensionType.ImmutableOwner])).to.be.greaterThan(AccountLayout.span);
    expect(mintData()[45]).to.equal(1); // isInitialized offset
    expect(isPlainMint(mintData())).to.equal(true);
  });

  it("parses token accounts the library encodes (owner and mint offsets)", () => {
    const parsed = parseTokenAccount(tokenAccountData(RECIPIENT, OTHER_MINT), false);
    expect(parsed).to.deep.equal({ mint: b58(OTHER_MINT), owner: b58(RECIPIENT) });
    const ext = Buffer.alloc(getAccountLen([ExtensionType.ImmutableOwner]));
    tokenAccountData(RECIPIENT).copy(ext);
    ext[AccountLayout.span] = AccountType.Account;
    expect(parseTokenAccount(ext, true)).to.deep.equal({ mint: b58(MINT), owner: b58(RECIPIENT) });
  });

  it("rejects ambiguous token account data", () => {
    const base = tokenAccountData(RECIPIENT);
    const ext = Buffer.alloc(getAccountLen([ExtensionType.ImmutableOwner]));
    base.copy(ext);
    expect(parseTokenAccount(ext, true)).to.equal(null); // no account-type marker
    ext[AccountLayout.span] = AccountType.Account;
    expect(parseTokenAccount(ext, false)).to.equal(null); // extensions not allowed for the classic program
    expect(parseTokenAccount(base.subarray(0, 164), true)).to.equal(null);
    expect(parseTokenAccount(Buffer.alloc(MULTISIG_SIZE), true)).to.equal(null);
    expect(parseTokenAccount(tokenAccountData(RECIPIENT, MINT, AccountState.Uninitialized), false)).to.equal(null);
    expect(parseTokenAccount(tokenAccountData(RECIPIENT, MINT, AccountState.Frozen), false)).to.equal(null);
  });
});

describe("readChainTime", () => {
  it("reads unix_timestamp from the Clock sysvar", async () => {
    const seen: string[] = [];
    const fetchAccount: AccountFetcher = async (a) => {
      seen.push(b58(a));
      return { owner: k(50), data: clockData(1_793_312_700n) };
    };
    expect(await readChainTime(fetchAccount)).to.equal(1_793_312_700n);
    expect(seen).to.deep.equal([b58(SYSVAR_CLOCK_PUBKEY)]);
  });

  it("fails closed on a missing, malformed, non-positive or unreachable clock", async () => {
    const bad: AccountFetcher[] = [
      async () => null,
      async () => ({ owner: k(50), data: Buffer.alloc(39) }),
      async () => ({ owner: k(50), data: clockData(0n) }),
      async () => ({ owner: k(50), data: clockData(-5n) }),
      async () => { throw new Error("rpc down"); },
    ];
    for (const f of bad) {
      let threw = false;
      try { await readChainTime(f); } catch { threw = true; }
      expect(threw).to.equal(true);
    }
  });
});

describe("evaluateTransaction: allowed transactions", () => {
  it("allows a TransferChecked to an allowlisted recipient and reports a JSON-safe summary", async () => {
    const chain = makeChain();
    const d = await run(chain, spl(5_000_000n));
    expectAllow(d);
    expect(d.reason).to.match(/allowlisted recipients/);
    expect(d.mandateAddress).to.equal(chain.address);
    const s = d.transactionSummary;
    expect(s.transactionType).to.equal("legacy");
    expect(s.programIds).to.deep.equal([b58(SPL_TOKEN_ID)]);
    expect(s.authorityChanges).to.deep.equal([]);
    expect(s.unrecognizedInstructions).to.deep.equal([]);
    expect(s.transfers).to.deep.equal([
      {
        kind: "SPL_TOKEN", source: b58(SRC), destination: b58(DEST), amount: "5000000",
        mint: b58(MINT), instructionIndex: 0, programId: b58(SPL_TOKEN_ID),
        authority: b58(AGENT), destinationOwner: b58(RECIPIENT),
      },
    ]);
    expect(JSON.parse(JSON.stringify(d))).to.deep.equal(d);
  });

  it("allows a plain Transfer: the mint comes from the destination account, not the instruction", async () => {
    const chain = makeChain();
    const d = await run(chain, txBase64(AGENT, [plain(5_000_000n)]));
    expectAllow(d);
    expect(d.transactionSummary.transfers[0]?.mint).to.equal(b58(MINT));
    expect(d.transactionSummary.transfers[0]?.destinationOwner).to.equal(b58(RECIPIENT));
  });

  it("allows a Token-2022 base transfer when the mandate mint has no extensions", async () => {
    const chain = token2022Chain();
    const d = await run(chain, txBase64(AGENT, [checked(5_000_000n, DEST, AGENT, SPL_TOKEN_2022_ID)]));
    expectAllow(d);
    expect(chain.calls).to.include(b58(MINT));

    const ext = Buffer.alloc(getAccountLen([ExtensionType.ImmutableOwner]));
    tokenAccountData(RECIPIENT).copy(ext);
    ext[AccountLayout.span] = AccountType.Account;
    chain.accounts.set(b58(DEST), { owner: SPL_TOKEN_2022_ID, data: ext });
    expectAllow(await run(chain, txBase64(AGENT, [checked(5_000_000n, DEST, AGENT, SPL_TOKEN_2022_ID)])));
  });

  it("allows exactly the per-transaction limit and exactly the remaining allowance", async () => {
    expectAllow(await run(makeChain(), spl(100_000_000n))); // per-tx limit, remaining is 210M
    const tight = makeChain({ totalSpent: 200_000_000n }); // remaining 50M, per-tx 100M
    expectAllow(await run(tight, spl(50_000_000n)));
  });

  it("allows several transfers whose total is within the per-transaction limit, and fetches a shared destination once", async () => {
    const chain = makeChain();
    const d = await run(chain, txBase64(AGENT, [checked(40_000_000n), checked(60_000_000n)]));
    expectAllow(d);
    expect(d.transactionSummary.transfers.map((t) => [t.instructionIndex, t.amount])).to.deep.equal([
      [0, "40000000"],
      [1, "60000000"],
    ]);
    expect(chain.calls.filter((c) => c === b58(DEST))).to.have.length(1);
  });

  it("allows u64-maximum amounts when the limits allow them", async () => {
    const chain = makeChain({ maxPerTx: U64_MAX, maxTotal: U64_MAX, totalSpent: 0n });
    const empty = tokenAccountData(RECIPIENT);
    empty.writeBigUInt64LE(0n, 64); // a real chain rejects a transfer that would overflow the destination
    chain.accounts.set(b58(DEST), { owner: SPL_TOKEN_ID, data: empty });
    expectAllow(await run(chain, spl(U64_MAX)));
  });
});

describe("evaluateTransaction: mandate and clock denials", () => {
  it("denies a revoked mandate before doing any other work", async () => {
    const chain = makeChain({ revoked: 1 });
    const d = await run(chain, spl(1n));
    expectDeny(d, ["MANDATE_REVOKED"]);
    expect(chain.calls).to.deep.equal([chain.address]);
  });

  it("denies an expired mandate: valid just before expiry, denied at expiry", async () => {
    expectAllow(await run(makeChain(), spl(1n), EXPIRES_AT - 1n));
    expectDeny(await run(makeChain(), spl(1n), EXPIRES_AT), ["MANDATE_EXPIRED"]);
    expectDeny(await run(makeChain(), spl(1n), EXPIRES_AT + 1_000n), ["MANDATE_EXPIRED"]);
  });

  it("denies a missing mandate and a mandate owned by another program", async () => {
    const missing = makeChain();
    missing.accounts.set(missing.address, null);
    expectDeny(await run(missing, spl(1n)), ["MANDATE_NOT_FOUND"]);

    const foreign = makeChain();
    foreign.accounts.set(foreign.address, { owner: k(60), data: mandateAccount().bytes });
    expectDeny(await run(foreign, spl(1n)), ["MANDATE_WRONG_OWNER"]);
  });

  it("denies a corrupt mandate and an invalid mandate address (without any network call)", async () => {
    expectDeny(await run(makeChain({ totalSpent: 250_000_001n }), spl(1n)), ["MANDATE_CORRUPT"]);

    const chain = makeChain();
    const d = await evaluateTransaction(
      { mandateAddress: "not-a-key", transactionBase64: spl(1n) },
      { nowSeconds: CHECK_TIME, fetchAccount: chain.fetchAccount, config, simulationBackend: bankBackend(providerFor(chain)) }
    );
    expectDeny(d, ["INVALID_MANDATE_ADDRESS"]);
    expect(chain.calls).to.deep.equal([]);
  });

  it("denies when the RPC fails, without leaking the underlying error", async () => {
    const fetchAccount: AccountFetcher = async () => {
      throw new Error("connect failed: http://user:secret@127.0.0.1:8899");
    };
    const d = await evaluateTransaction(
      { mandateAddress: b58(mandateAccount().address), transactionBase64: spl(1n) },
      { nowSeconds: CHECK_TIME, fetchAccount, config }
    );
    expectDeny(d, ["MANDATE_RPC_ERROR"]);
    expect(JSON.stringify(d)).to.not.include("secret");
  });

  it("uses the chain clock when nowSeconds is not supplied, and denies if it is unavailable", async () => {
    const withClock = (ts: bigint | null, size = 40) => {
      const chain = makeChain();
      const data = clockData(ts ?? 1n).subarray(0, size);
      chain.accounts.set(b58(SYSVAR_CLOCK_PUBKEY), ts === null ? null : { owner: k(50), data });
      return chain;
    };
    const go = (chain: Chain) =>
      evaluateTransaction(
        { mandateAddress: chain.address, transactionBase64: spl(1n) },
        { fetchAccount: chain.fetchAccount, config, simulationBackend: bankBackend(providerFor(chain)) }
      );
    expectAllow(await go(withClock(CHECK_TIME)));
    expectDeny(await go(withClock(EXPIRES_AT)), ["MANDATE_EXPIRED"]);
    expectDeny(await go(withClock(null)), ["CLOCK_UNAVAILABLE"]);
    expectDeny(await go(withClock(CHECK_TIME, 39)), ["CLOCK_UNAVAILABLE"]);
  });

  it("never reads nowSeconds from the request", async () => {
    const chain = makeChain();
    const input = { mandateAddress: chain.address, transactionBase64: spl(1n), nowSeconds: 0n };
    const d = await evaluateTransaction(input as unknown as EvaluateTransactionInput, {
      nowSeconds: EXPIRES_AT + 1n,
      fetchAccount: chain.fetchAccount,
      config,
    });
    expectDeny(d, ["MANDATE_EXPIRED"]);
  });
});

describe("evaluateTransaction: transaction-level denials", () => {
  it("denies invalid base64 and empty input", async () => {
    for (const bad of ["not base64!!", "", "AAAA!!!!AAAA", "AA"]) {
      expectDeny(await run(makeChain(), bad), ["INVALID_BASE64"]);
    }
  });

  it("denies malformed transactions: junk, truncated, trailing bytes", async () => {
    const good = Buffer.from(spl(1n), "base64");
    const cases = [
      Buffer.alloc(64, 7).toString("base64"),
      good.subarray(0, good.length - 5).toString("base64"),
      Buffer.concat([good, Buffer.from([1, 2, 3])]).toString("base64"),
    ];
    for (const tx of cases) expectDeny(await run(makeChain(), tx), ["MALFORMED_TRANSACTION"]);
  });

  it("denies a transaction that uses an address lookup table", async () => {
    const d = await run(makeChain(), lookupTableTx());
    expectDeny(d, ["LOOKUP_TABLE_UNRESOLVED"]);
    expect(d.transactionSummary.transactionType).to.equal("versioned");
    expect(d.transactionSummary.transfers).to.deep.equal([]);
  });

  it("denies an unrecognized instruction even next to a valid transfer, and preserves it", async () => {
    const chain = makeChain();
    const d = await run(chain, txBase64(AGENT, [checked(5_000_000n), unknownIx()]));
    expectDeny(d, ["UNRECOGNIZED_INSTRUCTION"]);
    expect(d.transactionSummary.unrecognizedInstructions).to.have.length(1);
    expect(d.transactionSummary.unrecognizedInstructions[0]?.programId).to.equal(b58(k(90)));
    expect(d.transactionSummary.transfers).to.have.length(1);
    expect(chain.calls).to.deep.equal([chain.address]); // no destination or mint lookups
  });

  it("denies an authority change even next to a valid transfer", async () => {
    const withSetAuthority = txBase64(AGENT, [
      checked(5_000_000n),
      createSetAuthorityInstruction(SRC, AGENT, AuthorityType.AccountOwner, STRANGER),
    ]);
    expectDeny(await run(makeChain(), withSetAuthority), ["AUTHORITY_CHANGE_DETECTED"]);

    const assign = txBase64(AGENT, [SystemProgram.assign({ accountPubkey: AGENT, programId: k(95) })]);
    const d = await run(makeChain(), assign);
    expect(d.decision).to.equal("DENY");
    expect(d.riskFlags).to.include("AUTHORITY_CHANGE_DETECTED");
  });

  it("denies a token approval even next to a valid transfer, with a JSON-safe amount", async () => {
    const tx = txBase64(AGENT, [checked(5_000_000n), createApproveInstruction(SRC, STRANGER, AGENT, 5_000_000n)]);
    const d = await run(makeChain(), tx);
    expectDeny(d, ["APPROVAL_DETECTED"]);
    const change = d.transactionSummary.authorityChanges[0];
    expect(change?.securitySensitive).to.equal(true);
    expect(change?.amount).to.equal("5000000");
    expect(JSON.parse(JSON.stringify(d))).to.deep.equal(d);
  });

  it("denies a transaction with no transfer instead of giving a blanket approval", async () => {
    const d = await run(makeChain(), txBase64(AGENT, [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 })]));
    expectDeny(d, ["NO_POLICY_RELEVANT_TRANSFER"]);
    expect(d.reason).to.equal("No policy-relevant transfer detected; refusing blanket approval");
    expect(d.transactionSummary.programIds).to.deep.equal([b58(ComputeBudgetProgram.programId)]);
  });

  it("reports every structural problem in riskFlags, with the first as the reason", async () => {
    const chain = makeChain();
    const tx = txBase64(AGENT, [unknownIx(), createApproveInstruction(SRC, STRANGER, AGENT, 5n)]);
    const d = await run(chain, tx);
    expectDeny(d, ["UNRECOGNIZED_INSTRUCTION", "APPROVAL_DETECTED", "NO_POLICY_RELEVANT_TRANSFER"]);
    expect(d.reason).to.match(/unrecognized instruction/);
  });
});

describe("evaluateTransaction: transfer-level denials", () => {
  it("denies SOL transfers as an unsupported asset", async () => {
    const tx = txBase64(AGENT, [SystemProgram.transfer({ fromPubkey: AGENT, toPubkey: RECIPIENT, lamports: 5_000n })]);
    const d = await run(makeChain(), tx);
    expectDeny(d, ["UNSUPPORTED_ASSET"]);
    expect(d.transactionSummary.transfers[0]?.kind).to.equal("SOL");
  });

  it("denies a recipient that is not on the allowlist (the token account owner is checked)", async () => {
    const d = await run(makeChain(), spl(5_000_000n, DEST_STRANGER));
    expectDeny(d, ["UNKNOWN_RECIPIENT"]);
    expect(d.transactionSummary.transfers[0]?.destinationOwner).to.equal(b58(STRANGER));
  });

  it("denies everything when the allowlist is empty", async () => {
    expectDeny(await run(makeChain({ recipients: [] }), spl(1n)), ["UNKNOWN_RECIPIENT"]);
  });

  it("denies when the destination token account owner cannot be resolved", async () => {
    const variants: Array<[string, RawAccount | null]> = [
      ["missing", null],
      ["too short", { owner: SPL_TOKEN_ID, data: tokenAccountData(RECIPIENT).subarray(0, 164) }],
      ["classic account with a trailing marker", { owner: SPL_TOKEN_ID, data: Buffer.concat([tokenAccountData(RECIPIENT), Buffer.from([AccountType.Account])]) }],
      ["multisig-sized", { owner: SPL_TOKEN_ID, data: Buffer.alloc(MULTISIG_SIZE) }],
      ["uninitialized", { owner: SPL_TOKEN_ID, data: tokenAccountData(RECIPIENT, MINT, AccountState.Uninitialized) }],
      ["frozen", { owner: SPL_TOKEN_ID, data: tokenAccountData(RECIPIENT, MINT, AccountState.Frozen) }],
      ["owned by another program", { owner: SystemProgram.programId, data: tokenAccountData(RECIPIENT) }],
    ];
    for (const [label, account] of variants) {
      const chain = makeChain();
      chain.accounts.set(b58(DEST), account);
      const d = await run(chain, spl(1n));
      expect(d.decision, label).to.equal("DENY");
      expect(d.riskFlags, label).to.deep.equal(["TOKEN_ACCOUNT_OWNER_UNRESOLVED"]);
    }
  });

  it("denies when fetching the destination fails, without leaking the error", async () => {
    const chain = makeChain();
    const fetchAccount: AccountFetcher = async (a) => {
      if (a.equals(DEST)) throw new Error("boom http://user:secret@127.0.0.1:8899");
      return chain.fetchAccount(a);
    };
    const d = await evaluateTransaction(
      { mandateAddress: chain.address, transactionBase64: spl(1n) },
      { nowSeconds: CHECK_TIME, fetchAccount, config }
    );
    expectDeny(d, ["TOKEN_ACCOUNT_OWNER_UNRESOLVED"]);
    expect(JSON.stringify(d)).to.not.include("secret");
  });

  it("denies a token other than the mandate's mint", async () => {
    const otherMint = txBase64(AGENT, [createTransferCheckedInstruction(SRC, OTHER_MINT, DEST, AGENT, 5n, 6)]);
    expectDeny(await run(makeChain(), otherMint), ["MINT_MISMATCH"]);

    const wrongDest = makeChain();
    wrongDest.accounts.set(b58(DEST), { owner: SPL_TOKEN_ID, data: tokenAccountData(RECIPIENT, OTHER_MINT) });
    expectDeny(await run(wrongDest, txBase64(AGENT, [plain(5n)])), ["MINT_MISMATCH"]);
  });

  it("denies a transfer not authorized by the mandate's agent", async () => {
    expectDeny(await run(makeChain(), txBase64(STRANGER, [checked(5n, DEST, STRANGER)])), ["AGENT_MISMATCH"]);

    const unsigned = checked(5n);
    unsigned.keys = unsigned.keys.map((key) => (key.pubkey.equals(AGENT) ? { ...key, isSigner: false } : key));
    expectDeny(await run(makeChain(), txBase64(k(40), [unsigned])), ["AGENT_MISMATCH"]);
  });

  it("denies one unit above the per-transaction limit", async () => {
    expectDeny(await run(makeChain(), spl(100_000_001n)), ["AMOUNT_EXCEEDS_PER_TRANSACTION_LIMIT"]);
  });

  it("denies one unit above the remaining allowance", async () => {
    const chain = makeChain({ totalSpent: 200_000_000n }); // remaining 50M, per-tx 100M
    expectDeny(await run(chain, spl(50_000_001n)), ["AMOUNT_EXCEEDS_REMAINING_ALLOWANCE"]);
  });

  it("denies transfers that together exceed the per-transaction limit, though each is within it", async () => {
    const tx = txBase64(AGENT, [checked(60_000_000n), checked(60_000_000n, DEST_2)]);
    expectDeny(await run(makeChain(), tx), ["COMBINED_EXCEEDS_PER_TRANSACTION_LIMIT"]);
  });

  it("denies transfers that together exceed the remaining allowance, though each is within it", async () => {
    const chain = makeChain({ totalSpent: 200_000_000n }); // remaining 50M
    const tx = txBase64(AGENT, [checked(30_000_000n), checked(30_000_000n, DEST_2)]);
    expectDeny(await run(chain, tx), ["COMBINED_EXCEEDS_REMAINING_ALLOWANCE"]);
  });

  it("compares sums above 2^64 exactly instead of wrapping around", async () => {
    const chain = makeChain({ maxPerTx: U64_MAX, maxTotal: U64_MAX, totalSpent: 0n });
    const tx = txBase64(AGENT, [checked(U64_MAX), checked(U64_MAX, DEST_2)]);
    expectDeny(await run(chain, tx), ["COMBINED_EXCEEDS_PER_TRANSACTION_LIMIT", "COMBINED_EXCEEDS_REMAINING_ALLOWANCE"]);
  });

  it("denies Token-2022 transfers unless the mandate mint is shown to have no extensions", async () => {
    const t22 = () => txBase64(AGENT, [checked(5n, DEST, AGENT, SPL_TOKEN_2022_ID)]);

    const extended = token2022Chain();
    const extMint = Buffer.alloc(getMintLen([ExtensionType.TransferFeeConfig]));
    mintData().copy(extMint);
    extMint[AccountLayout.span] = AccountType.Mint;
    extended.accounts.set(b58(MINT), { owner: SPL_TOKEN_2022_ID, data: extMint });
    expectDeny(await run(extended, t22()), ["TOKEN_2022_EXTENSIONS_UNRESOLVED"]);

    const missing = token2022Chain();
    missing.accounts.set(b58(MINT), null);
    expectDeny(await run(missing, t22()), ["TOKEN_2022_EXTENSIONS_UNRESOLVED"]);

    const classicOwned = token2022Chain();
    classicOwned.accounts.set(b58(MINT), { owner: SPL_TOKEN_ID, data: mintData() });
    expectDeny(await run(classicOwned, t22()), ["TOKEN_2022_EXTENSIONS_UNRESOLVED"]);
  });

  it("denies a Token-2022 transfer whose destination account belongs to the classic Token program", async () => {
    const chain = token2022Chain();
    chain.accounts.set(b58(DEST), { owner: SPL_TOKEN_ID, data: tokenAccountData(RECIPIENT) });
    expectDeny(await run(chain, txBase64(AGENT, [checked(5n, DEST, AGENT, SPL_TOKEN_2022_ID)])), [
      "TOKEN_ACCOUNT_OWNER_UNRESOLVED",
    ]);
  });
});

describe("evaluateTransaction: input handling and decision shape", () => {
  it("never throws on bad input and denies with INVALID_INPUT", async () => {
    const chain = makeChain();
    const bad: unknown[] = [
      null, undefined, 5, "text", [], {},
      { mandateAddress: 5, transactionBase64: "x" },
      { mandateAddress: chain.address },
      { transactionBase64: "x" },
    ];
    for (const b of bad) {
      let d: PolicyDecision | undefined;
      try {
        d = await evaluateTransaction(b as EvaluateTransactionInput, { fetchAccount: chain.fetchAccount, config, simulationBackend: bankBackend(providerFor(chain)) });
      } catch (e) {
        expect.fail(`evaluateTransaction threw: ${String(e)}`);
      }
      expectDeny(d as PolicyDecision, ["INVALID_INPUT"]);
    }
    expect(chain.calls).to.deep.equal([]);
  });

  it("denies a nowSeconds that is not a bigint", async () => {
    const chain = makeChain();
    const d = await evaluateTransaction(
      { mandateAddress: chain.address, transactionBase64: spl(1n) },
      { nowSeconds: 5 as unknown as bigint, fetchAccount: chain.fetchAccount, config, simulationBackend: bankBackend(providerFor(chain)) }
    );
    expectDeny(d, ["INVALID_INPUT"]);
  });

  it("returns exactly the documented shape, JSON-safe, for both ALLOW and DENY", async () => {
    const allow = await run(makeChain(), spl(5n));
    const deny = await run(makeChain(), txBase64(AGENT, [checked(5n), createApproveInstruction(SRC, STRANGER, AGENT, 5n)]));
    for (const d of [allow, deny]) {
      expect(Object.keys(d).sort()).to.deep.equal(
        d.decision === "ALLOW"
          ? ["checkedAt", "decision", "mandateAddress", "reason", "riskFlags", "simulation", "transactionSummary"]
          : ["checkedAt", "decision", "mandateAddress", "reason", "riskFlags", "transactionSummary"]
      );
      expect(Object.keys(d.transactionSummary).sort()).to.deep.equal(
        ["authorityChanges", "programIds", "transactionType", "transfers", "unrecognizedInstructions"]
      );
      expect(new Set(d.riskFlags).size).to.equal(d.riskFlags.length);
      expect(JSON.parse(JSON.stringify(d))).to.deep.equal(d);
    }
    expect(allow.decision).to.equal("ALLOW");
    expect(deny.decision).to.equal("DENY");
  });
});

// ---------------------------------------------------------------------------------------------
// Simulation and receipts (Milestone 4A)
// ---------------------------------------------------------------------------------------------

/** Account state for the fake bank: the chain's known accounts, the agent's source token account, and wallets. */
function providerFor(chain: Chain): Provider {
  return (address) => {
    const known = chain.accounts.get(address);
    if (known) {
      return { lamports: 1_000_000_000n, owner: known.owner.toBase58(), executable: false, data: Buffer.from(known.data) };
    }
    if (address === b58(SRC)) {
      const data = tokenAccountData(AGENT);
      data.writeBigUInt64LE(U64_MAX, 64);
      const dest = chain.accounts.get(b58(DEST));
      return {
        lamports: 1_000_000_000n,
        owner: dest ? dest.owner.toBase58() : b58(SPL_TOKEN_ID),
        executable: false,
        data,
      };
    }
    return { lamports: 10_000_000_000n, owner: b58(SystemProgram.programId), executable: false, data: Buffer.alloc(0) };
  };
}

describe("evaluateTransaction: simulation before approval", () => {
  const goodTx = () => spl(5_000_000n);

  async function runWith(
    chain: Chain,
    hooks: BankHooks = {},
    extra: Partial<EvaluateOptions> = {},
    tx: string = goodTx()
  ) {
    const backend = bankBackend(providerFor(chain), hooks);
    const decision = await evaluateTransaction(
      { mandateAddress: chain.address, transactionBase64: tx },
      { nowSeconds: CHECK_TIME, fetchAccount: chain.fetchAccount, config, simulationBackend: backend, ...extra }
    );
    return { decision, backend };
  }

  it("allows only after a clean simulation, and attaches logs, compute units and account changes", async () => {
    const { decision, backend } = await runWith(makeChain());
    expectAllow(decision);
    expect(backend.calls).to.deep.equal({ getAccounts: 1, simulate: 1 });
    const sim = decision.simulation;
    expect(sim?.status).to.equal("SUCCESS");
    expect(sim?.logs).to.deep.equal(["Program log: ok"]);
    expect(sim?.unitsConsumed).to.equal("4321");
    expect(sim?.unexpectedChanges).to.deep.equal([]);
    expect(sim?.accountChanges.filter((c) => c.field === "token amount")).to.have.length(2);
    expect(JSON.parse(JSON.stringify(decision))).to.deep.equal(decision);
  });

  it("denies when the simulation fails", async () => {
    const { decision } = await runWith(makeChain(), { fail: { InstructionError: [0, "InsufficientFunds"] } });
    expectDeny(decision, ["SIMULATION_FAILED"]);
    expect(decision.reason).to.match(/^Simulation failed: /);
    expect(decision.simulation?.status).to.equal("FAILED");
    expect(decision.transactionSummary.transfers).to.have.length(1);
  });

  it("denies when the simulation reveals an unexpected account mutation", async () => {
    const { decision } = await runWith(makeChain(), {
      mutate: (post) => {
        const d = post.get(b58(DEST));
        if (d) d.owner = b58(STRANGER);
      },
    });
    expectDeny(decision, ["UNEXPECTED_ACCOUNT_MUTATION"]);
    expect(decision.reason).to.match(/changed accounts unexpectedly/);
    expect(decision.simulation?.status).to.equal("UNEXPECTED_MUTATION");
    expect(decision.simulation?.unexpectedChanges[0]).to.include(b58(DEST));
  });

  it("denies when the simulation cannot be completed, without leaking the error", async () => {
    const { decision } = await runWith(makeChain(), { throwOnSimulate: true });
    expectDeny(decision, ["SIMULATION_UNAVAILABLE"]);
    expect(decision.simulation?.status).to.equal("UNAVAILABLE");
    expect(JSON.stringify(decision)).to.not.include("secret");
  });

  it("honors the fee limit option and rejects an invalid one", async () => {
    const tight = await runWith(makeChain(), {}, { maxFeeLamports: 1_000n });
    expectDeny(tight.decision, ["UNEXPECTED_ACCOUNT_MUTATION"]);
    const negative = await runWith(makeChain(), {}, { maxFeeLamports: -1n });
    expectDeny(negative.decision, ["INVALID_INPUT"]);
    expect(negative.backend.calls.simulate).to.equal(0);
    const notBigint = await runWith(makeChain(), {}, { maxFeeLamports: 5 as unknown as bigint });
    expectDeny(notBigint.decision, ["INVALID_INPUT"]);
  });

  it("does not simulate a transaction that was already denied", async () => {
    const cases: Array<[string, Chain, string]> = [
      ["revoked mandate", makeChain({ revoked: 1 }), goodTx()],
      ["unrecognized instruction", makeChain(), txBase64(AGENT, [checked(5n), unknownIx()])],
      ["amount above the limit", makeChain(), spl(100_000_001n)],
      ["unknown recipient", makeChain(), spl(5n, DEST_STRANGER)],
    ];
    for (const [label, chain, tx] of cases) {
      const { decision, backend } = await runWith(chain, {}, {}, tx);
      expect(decision.decision, label).to.equal("DENY");
      expect(decision.simulation, label).to.equal(undefined);
      expect(backend.calls, label).to.deep.equal({ getAccounts: 0, simulate: 0 });
    }
  });
});

describe("decision receipts", () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  const evalWith = (
    chain: Chain,
    store?: ReceiptStore,
    tx: string = spl(5_000_000n),
    address: string = chain.address
  ) =>
    evaluateWithReceipt(
      { mandateAddress: address, transactionBase64: tx },
      {
        nowSeconds: CHECK_TIME,
        fetchAccount: chain.fetchAccount,
        config,
        simulationBackend: bankBackend(providerFor(chain)),
        ...(store ? { receiptStore: store } : {}),
      }
    );

  it("creates a complete receipt for an ALLOW and stores it", async () => {
    const chain = makeChain();
    const store = new MemoryReceiptStore();
    const { decision, receipt } = await evalWith(chain, store);
    expectAllow(decision);
    expect(Object.keys(receipt).sort()).to.deep.equal([
      "agent", "checkedAt", "decision", "mandateAddress", "policyVersion", "reason",
      "receiptId", "receiptVersion", "riskFlags", "simulation", "sponsor", "transactionSummaryHash",
    ]);
    expect(receipt).to.include({
      receiptVersion: 1, policyVersion: POLICY_VERSION, mandateAddress: chain.address,
      agent: b58(AGENT), sponsor: b58(SPONSOR), decision: "ALLOW",
      reason: decision.reason, checkedAt: decision.checkedAt,
    });
    expect(receipt.riskFlags).to.deep.equal([]);
    expect(receipt.transactionSummaryHash).to.match(/^[0-9a-f]{64}$/);
    expect(receipt.transactionSummaryHash).to.equal(hashSummary(decision.transactionSummary));
    expect(receipt.receiptId).to.match(UUID);
    expect(receipt.simulation.status).to.equal("SUCCESS");
    expect(receipt.simulation).to.deep.equal(decision.simulation);
    expect(store.list()).to.deep.equal([receipt]);
  });

  it("creates a receipt for every DENY too, with the simulation marked NOT_RUN when it was never reached", async () => {
    const store = new MemoryReceiptStore();
    const scenarios: Array<[string, Chain, string]> = [
      ["revoked mandate", makeChain({ revoked: 1 }), spl(5n)],
      ["unknown recipient", makeChain(), spl(5n, DEST_STRANGER)],
      ["over the limit", makeChain(), spl(100_000_001n)],
      ["approval", makeChain(), txBase64(AGENT, [createApproveInstruction(SRC, STRANGER, AGENT, 5n)])],
    ];
    const ids = new Set<string>();
    for (const [label, chain, tx] of scenarios) {
      const { decision, receipt } = await evalWith(chain, store, tx);
      expect(decision.decision, label).to.equal("DENY");
      expect(receipt.decision, label).to.equal("DENY");
      expect(receipt.riskFlags, label).to.deep.equal(decision.riskFlags);
      expect(receipt.reason, label).to.equal(decision.reason);
      expect(receipt.agent, label).to.equal(b58(AGENT));
      expect(receipt.sponsor, label).to.equal(b58(SPONSOR));
      expect(receipt.simulation.status, label).to.equal("NOT_RUN");
      expect(receipt.transactionSummaryHash, label).to.equal(hashSummary(decision.transactionSummary));
      ids.add(receipt.receiptId);
    }
    expect(ids.size).to.equal(scenarios.length);
    expect(store.list()).to.have.length(scenarios.length);
  });

  it("records simulation denials with the simulation result", async () => {
    const chain = makeChain();
    const store = new MemoryReceiptStore();
    const { decision, receipt } = await evaluateWithReceipt(
      { mandateAddress: chain.address, transactionBase64: spl(5n) },
      {
        nowSeconds: CHECK_TIME,
        fetchAccount: chain.fetchAccount,
        config,
        simulationBackend: bankBackend(providerFor(chain), { fail: "AccountNotFound" }),
        receiptStore: store,
      }
    );
    expectDeny(decision, ["SIMULATION_FAILED"]);
    expect(receipt.simulation.status).to.equal("FAILED");
    expect(receipt.simulation.error).to.equal("AccountNotFound");
  });

  it("records agent and sponsor as null when the mandate could not be loaded", async () => {
    const chain = makeChain();
    const store = new MemoryReceiptStore();
    const { decision, receipt } = await evalWith(chain, store, spl(5n), "not-a-key");
    expectDeny(decision, ["INVALID_MANDATE_ADDRESS"]);
    expect(receipt.agent).to.equal(null);
    expect(receipt.sponsor).to.equal(null);
    expect(receipt.mandateAddress).to.equal("not-a-key");
    expect(receipt.simulation.status).to.equal("NOT_RUN");
    expect(store.list()).to.have.length(1);
  });

  it("stores receipts from evaluateTransaction too when a store is supplied", async () => {
    const chain = makeChain();
    const store = new MemoryReceiptStore();
    const d = await evaluateTransaction(
      { mandateAddress: chain.address, transactionBase64: spl(5n) },
      {
        nowSeconds: CHECK_TIME,
        fetchAccount: chain.fetchAccount,
        config,
        simulationBackend: bankBackend(providerFor(chain)),
        receiptStore: store,
      }
    );
    expectAllow(d);
    expect(store.list()).to.have.length(1);
  });

  it("turns an ALLOW into a DENY when its receipt cannot be stored: no receipt, no approval", async () => {
    const chain = makeChain();
    const stored: DecisionReceipt[] = [];
    let attempts = 0;
    const flaky: ReceiptStore = {
      append(r) {
        attempts += 1;
        if (attempts === 1) throw new Error("disk full http://user:secret@127.0.0.1:8899");
        stored.push(r);
      },
      list: () => stored,
    };
    const { decision, receipt } = await evalWith(chain, flaky);
    expectDeny(decision, ["RECEIPT_STORE_FAILED"]);
    expect(decision.simulation?.status).to.equal("SUCCESS");
    expect(receipt.decision).to.equal("DENY");
    expect(receipt.riskFlags).to.deep.equal(["RECEIPT_STORE_FAILED"]);
    expect(stored).to.deep.equal([receipt]);
    expect(JSON.stringify(decision)).to.not.include("secret");
    expect(JSON.stringify(receipt)).to.not.include("secret");
  });

  it("still returns a DENY receipt when the store keeps failing", async () => {
    const chain = makeChain();
    const broken: ReceiptStore = {
      append() {
        throw new Error("read-only file system");
      },
      list: () => [],
    };
    const allowed = await evalWith(chain, broken);
    expectDeny(allowed.decision, ["RECEIPT_STORE_FAILED"]);
    expect(allowed.receipt.decision).to.equal("DENY");

    const denied = await evalWith(makeChain({ revoked: 1 }), broken);
    expectDeny(denied.decision, ["MANDATE_REVOKED"]);
    expect(denied.receipt.decision).to.equal("DENY");
  });
});
