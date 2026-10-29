import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { expect } from "chai";
import { Aegis } from "../target/types/aegis";

const { Keypair, PublicKey, LAMPORTS_PER_SOL, SYSVAR_CLOCK_PUBKEY } = anchor.web3;
type Keypair = anchor.web3.Keypair;
type PublicKey = anchor.web3.PublicKey;

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const connection = provider.connection;
const baseProgram = anchor.workspace.aegis as Program<Aegis>;

// Amounts are in USDC base units (6 decimals): 100_000_000 = 100 USDC.
const MAX_PER_TX = 100_000_000;
const MAX_TOTAL = 250_000_000;
const DAILY_CAP = 200_000_000;
const ONE_DAY = 86_400;

let nextMandateId = 1;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Solana rejects a transaction identical to one it already processed (same message and
// blockhash). Tests repeat calls with the same arguments, so every revoke/spend carries a
// harmless compute-budget instruction with a unique value to keep its transaction distinct.
let uniqueCounter = 0;
function uniqueIx() {
  uniqueCounter += 1;
  return anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 + uniqueCounter });
}

// Asserts that a call fails with the named program error (e.g. "MandateRevoked").
async function expectProgramError(call: Promise<unknown>, code: string): Promise<void> {
  try {
    await call;
  } catch (e: any) {
    const anchorCode = e?.error?.errorCode?.code;
    if (anchorCode !== undefined) {
      expect(anchorCode, `wrong program error: ${e.message}`).to.equal(code);
      return;
    }
    let logs: string[] = [];
    try {
      logs = e?.logs ?? [];
    } catch (_) {
      logs = [];
    }
    const text = [String(e?.message ?? e)].concat(logs).join("\n");
    expect(text, `expected program error ${code}, got: ${text}`).to.include(`Error Code: ${code}`);
    return;
  }
  expect.fail(`expected program error ${code}, but the call succeeded`);
}

// ---------- helpers ----------

// Each actor is a fresh throwaway keypair funded on localnet. The developer's own
// wallet is never used to sign test transactions.
async function fundedActor(): Promise<Keypair> {
  const kp = Keypair.generate();
  const sig = await connection.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL);
  const latest = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
  return kp;
}

// A Program client whose provider (fee payer + signer) is the given actor.
function programFor(actor: Keypair): Program<Aegis> {
  const actorProvider = new anchor.AnchorProvider(connection, new anchor.Wallet(actor), {
    commitment: "confirmed",
  });
  return new Program<Aegis>(baseProgram.idl, actorProvider);
}

function mandatePda(sponsor: PublicKey, mandateId: anchor.BN): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("mandate"), sponsor.toBuffer(), mandateId.toArrayLike(Buffer, "le", 8)],
    baseProgram.programId
  )[0];
}

// The chain's own clock (what the program reads), in unix seconds. Never use Date.now()
// for expiry: the chain clock can be moved forward and then no longer matches real time.
async function chainNow(): Promise<number> {
  const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
  if (!info) throw new Error("Clock sysvar not found");
  // Clock layout: slot u64, epoch_start_timestamp i64, epoch u64,
  // leader_schedule_epoch u64, unix_timestamp i64 (offset 32).
  return new anchor.BN(info.data.slice(32, 40), 10, "le").fromTwos(64).toNumber();
}

// surfnet_timeTravel takes an ABSOLUTE timestamp in MILLISECONDS; the Clock sysvar is in
// SECONDS. The clock can only move forward.
async function timeTravelTo(unixSeconds: number): Promise<void> {
  const res = await (connection as any)._rpcRequest("surfnet_timeTravel", [
    { absoluteTimestamp: unixSeconds * 1000 },
  ]);
  if (res.error) throw new Error(`surfnet_timeTravel failed: ${JSON.stringify(res.error)}`);
}

async function waitForChainTime(target: number): Promise<number> {
  let now = await chainNow();
  for (let i = 0; i < 10 && now < target; i++) {
    await sleep(500);
    now = await chainNow();
  }
  return now;
}

interface MandateOpts {
  maxPerTx?: number | anchor.BN;
  maxTotal?: number | anchor.BN;
  dailyCap?: number | anchor.BN;
  expiresIn?: number; // seconds after the chain's current time
  recipients?: PublicKey[];
}

async function createMandate(
  sponsor: Keypair,
  agent: PublicKey,
  mint: PublicKey,
  opts: MandateOpts = {}
) {
  const mandateId = new anchor.BN(nextMandateId++);
  const now = await chainNow();
  const params = {
    mandateId,
    maxPerTx: new anchor.BN(opts.maxPerTx ?? MAX_PER_TX),
    maxTotal: new anchor.BN(opts.maxTotal ?? MAX_TOTAL),
    dailyCap: new anchor.BN(opts.dailyCap ?? DAILY_CAP),
    expiresAt: new anchor.BN(now + (opts.expiresIn ?? ONE_DAY)),
    allowedRecipients: opts.recipients ?? [],
  };
  const mandate = mandatePda(sponsor.publicKey, mandateId);
  const sig = await programFor(sponsor)
    .methods.initializeMandate(params)
    .accountsPartial({ sponsor: sponsor.publicKey, agent, usdcMint: mint, mandate })
    .rpc();
  return { mandateId, mandate, params, sig, now };
}

async function revokeMandate(sponsor: Keypair, mandate: PublicKey): Promise<string> {
  return programFor(sponsor)
    .methods.revokeMandate()
    .accountsPartial({ sponsor: sponsor.publicKey, mandate })
    .preInstructions([uniqueIx()])
    .rpc();
}

async function recordSpend(
  sponsor: Keypair,
  mandate: PublicKey,
  amount: number | anchor.BN
): Promise<string> {
  return programFor(sponsor)
    .methods.recordSpend(new anchor.BN(amount))
    .accountsPartial({ sponsor: sponsor.publicKey, mandate })
    .preInstructions([uniqueIx()])
    .rpc();
}

// Decodes the program event with the given name from a confirmed transaction's logs.
async function getEvent(sig: string, name: string): Promise<any> {
  let tx = null;
  for (let i = 0; i < 5 && !tx; i++) {
    tx = await connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) await sleep(400);
  }
  if (!tx || !tx.meta || !tx.meta.logMessages) throw new Error(`no logs for ${sig}`);
  const parser = new anchor.EventParser(baseProgram.programId, baseProgram.coder);
  for (const ev of parser.parseLogs(tx.meta.logMessages)) {
    if (ev.name.toLowerCase() === name.toLowerCase()) return ev.data;
  }
  throw new Error(`event ${name} not found in transaction logs`);
}

// ---------- tests ----------

describe("aegis mandate lifecycle", () => {
  let sponsor: Keypair;
  let agent: PublicKey;
  let mint: PublicKey;
  let recipients: PublicKey[];
  let mandateA: Awaited<ReturnType<typeof createMandate>>;

  before(async () => {
    sponsor = await fundedActor();
    agent = Keypair.generate().publicKey;
    mint = Keypair.generate().publicKey;
    recipients = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    mandateA = await createMandate(sponsor, agent, mint, { recipients });
  });

  it("test harness: can advance the on-chain clock with surfnet_timeTravel", async () => {
    const before = await chainNow();
    await timeTravelTo(before + 3_600);
    const after = await waitForChainTime(before + 3_600);
    console.log(`      chain clock: ${before} -> ${after}`);
    expect(after).to.be.at.least(before + 3_600);
  });

  it("creates a mandate at the derived PDA and stores the correct state", async () => {
    const m = await baseProgram.account.agentMandate.fetch(mandateA.mandate);
    const [, expectedBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("mandate"),
        sponsor.publicKey.toBuffer(),
        mandateA.mandateId.toArrayLike(Buffer, "le", 8),
      ],
      baseProgram.programId
    );

    expect(m.sponsor.toBase58()).to.equal(sponsor.publicKey.toBase58());
    expect(m.agent.toBase58()).to.equal(agent.toBase58());
    expect(m.usdcMint.toBase58()).to.equal(mint.toBase58());
    expect(m.mandateId.toNumber()).to.equal(mandateA.mandateId.toNumber());
    expect(m.maxPerTx.toNumber()).to.equal(MAX_PER_TX);
    expect(m.maxTotal.toNumber()).to.equal(MAX_TOTAL);
    expect(m.dailyCap.toNumber()).to.equal(DAILY_CAP);
    expect(m.expiresAt.toNumber()).to.equal(mandateA.params.expiresAt.toNumber());
    expect(m.totalSpent.toNumber()).to.equal(0);
    expect(m.dailySpent.toNumber()).to.equal(0);
    expect(m.revoked).to.equal(false);
    expect(m.allowedRecipients.map((k: PublicKey) => k.toBase58())).to.deep.equal(
      recipients.map((k) => k.toBase58())
    );
    expect(m.createdAt.toNumber()).to.be.at.least(mandateA.now);
    expect(m.updatedAt.toNumber()).to.equal(m.createdAt.toNumber());
    expect(m.currentDay.toNumber()).to.equal(Math.floor(m.createdAt.toNumber() / ONE_DAY));
    expect(m.bump).to.equal(expectedBump);
  });

  it("emits MandateCreated with the correct data", async () => {
    const ev = await getEvent(mandateA.sig, "MandateCreated");
    const m = await baseProgram.account.agentMandate.fetch(mandateA.mandate);
    expect(ev.mandate.toBase58()).to.equal(mandateA.mandate.toBase58());
    expect(ev.sponsor.toBase58()).to.equal(sponsor.publicKey.toBase58());
    expect(ev.agent.toBase58()).to.equal(agent.toBase58());
    expect(ev.usdcMint.toBase58()).to.equal(mint.toBase58());
    expect(ev.mandateId.toNumber()).to.equal(mandateA.mandateId.toNumber());
    expect(ev.maxPerTx.toNumber()).to.equal(MAX_PER_TX);
    expect(ev.maxTotal.toNumber()).to.equal(MAX_TOTAL);
    expect(ev.dailyCap.toNumber()).to.equal(DAILY_CAP);
    expect(ev.expiresAt.toNumber()).to.equal(mandateA.params.expiresAt.toNumber());
    expect(ev.createdAt.toNumber()).to.equal(m.createdAt.toNumber());
  });

  it("lets the sponsor revoke a mandate and emits MandateRevoked", async () => {
    const created = await createMandate(sponsor, agent, mint);
    const sig = await revokeMandate(sponsor, created.mandate);

    const m = await baseProgram.account.agentMandate.fetch(created.mandate);
    expect(m.revoked).to.equal(true);
    expect(m.updatedAt.toNumber()).to.be.at.least(m.createdAt.toNumber());

    const ev = await getEvent(sig, "MandateRevoked");
    expect(ev.mandate.toBase58()).to.equal(created.mandate.toBase58());
    expect(ev.sponsor.toBase58()).to.equal(sponsor.publicKey.toBase58());
    expect(ev.agent.toBase58()).to.equal(agent.toBase58());
    expect(ev.mandateId.toNumber()).to.equal(created.mandateId.toNumber());
    expect(ev.revokedAt.toNumber()).to.equal(m.updatedAt.toNumber());
  });

  it("records valid spends, updates total_spent, and emits SpendRecorded", async () => {
    const created = await createMandate(sponsor, agent, mint);

    const sig1 = await recordSpend(sponsor, created.mandate, 40_000_000);
    let m = await baseProgram.account.agentMandate.fetch(created.mandate);
    expect(m.totalSpent.toNumber()).to.equal(40_000_000);

    const ev = await getEvent(sig1, "SpendRecorded");
    expect(ev.mandate.toBase58()).to.equal(created.mandate.toBase58());
    expect(ev.sponsor.toBase58()).to.equal(sponsor.publicKey.toBase58());
    expect(ev.agent.toBase58()).to.equal(agent.toBase58());
    expect(ev.mandateId.toNumber()).to.equal(created.mandateId.toNumber());
    expect(ev.amount.toNumber()).to.equal(40_000_000);
    expect(ev.totalSpent.toNumber()).to.equal(40_000_000);
    expect(ev.recordedAt.toNumber()).to.equal(m.updatedAt.toNumber());

    // A second spend must add to the running total, not replace it.
    await recordSpend(sponsor, created.mandate, 10_000_000);
    m = await baseProgram.account.agentMandate.fetch(created.mandate);
    expect(m.totalSpent.toNumber()).to.equal(50_000_000);
  });
});

// ---------- abuse paths: creation and revocation ----------

async function buildParams(mandateId: anchor.BN, opts: MandateOpts = {}) {
  const now = await chainNow();
  return {
    mandateId,
    maxPerTx: new anchor.BN(opts.maxPerTx ?? MAX_PER_TX),
    maxTotal: new anchor.BN(opts.maxTotal ?? MAX_TOTAL),
    dailyCap: new anchor.BN(opts.dailyCap ?? DAILY_CAP),
    expiresAt: new anchor.BN(now + (opts.expiresIn ?? ONE_DAY)),
    allowedRecipients: opts.recipients ?? [],
  };
}

describe("aegis abuse paths: creation and revocation", () => {
  let sponsor: Keypair;
  let attacker: Keypair;
  let agent: PublicKey;
  let mint: PublicKey;

  before(async () => {
    sponsor = await fundedActor();
    attacker = await fundedActor();
    agent = Keypair.generate().publicKey;
    mint = Keypair.generate().publicKey;
  });

  // ----- initialize_mandate -----

  it("rejects an attacker creating a mandate at another sponsor's address", async () => {
    const mandateId = new anchor.BN(nextMandateId++);
    const victimPda = mandatePda(sponsor.publicKey, mandateId);
    const params = await buildParams(mandateId);
    // The attacker signs as themselves but targets the victim's mandate address.
    await expectProgramError(
      programFor(attacker)
        .methods.initializeMandate(params)
        .accountsPartial({ sponsor: attacker.publicKey, agent, usdcMint: mint, mandate: victimPda })
        .rpc(),
      "ConstraintSeeds"
    );
    expect(await connection.getAccountInfo(victimPda)).to.equal(null);
  });

  it("rejects creation when the named sponsor does not sign", async () => {
    const mandateId = new anchor.BN(nextMandateId++);
    const victimPda = mandatePda(sponsor.publicKey, mandateId);
    const params = await buildParams(mandateId);
    const ix = await programFor(attacker)
      .methods.initializeMandate(params)
      .accountsPartial({ sponsor: sponsor.publicKey, agent, usdcMint: mint, mandate: victimPda })
      .instruction();
    // Force the sponsor to be a non-signer; the attacker is only the fee payer.
    ix.keys = ix.keys.map((k) => (k.pubkey.equals(sponsor.publicKey) ? { ...k, isSigner: false } : k));
    const tx = new anchor.web3.Transaction().add(ix);
    await expectProgramError(
      anchor.web3.sendAndConfirmTransaction(connection, tx, [attacker]),
      "AccountNotSigner"
    );
    expect(await connection.getAccountInfo(victimPda)).to.equal(null);
  });

  it("rejects an expiry in the past or equal to the current time", async () => {
    await expectProgramError(createMandate(sponsor, agent, mint, { expiresIn: -10 }), "InvalidExpiry");
    await expectProgramError(createMandate(sponsor, agent, mint, { expiresIn: 0 }), "InvalidExpiry");
  });

  it("rejects a zero per-transaction limit", async () => {
    await expectProgramError(createMandate(sponsor, agent, mint, { maxPerTx: 0 }), "InvalidPerTransactionLimit");
  });

  it("rejects a zero total-spend limit", async () => {
    await expectProgramError(createMandate(sponsor, agent, mint, { maxTotal: 0 }), "InvalidTotalSpendLimit");
  });

  it("rejects a per-transaction limit greater than the total-spend limit", async () => {
    await expectProgramError(
      createMandate(sponsor, agent, mint, { maxPerTx: 200_000_000, maxTotal: 100_000_000 }),
      "PerTransactionLimitExceedsTotalLimit"
    );
  });

  it("rejects a zero daily cap", async () => {
    await expectProgramError(createMandate(sponsor, agent, mint, { dailyCap: 0 }), "InvalidDailyCap");
  });

  it("rejects an agent that is the sponsor's own key", async () => {
    await expectProgramError(createMandate(sponsor, sponsor.publicKey, mint), "InvalidAgent");
  });

  it("rejects more than 5 allowed recipients", async () => {
    const six = Array.from({ length: 6 }, () => Keypair.generate().publicKey);
    await expectProgramError(createMandate(sponsor, agent, mint, { recipients: six }), "TooManyRecipients");
  });

  it("rejects a duplicate recipient in the allowlist", async () => {
    const r = Keypair.generate().publicKey;
    await expectProgramError(createMandate(sponsor, agent, mint, { recipients: [r, r] }), "InvalidRecipient");
  });

  // ----- revoke_mandate -----

  it("rejects revocation by a non-sponsor and leaves the mandate active", async () => {
    const created = await createMandate(sponsor, agent, mint);
    await expectProgramError(revokeMandate(attacker, created.mandate), "Unauthorized");
    const m = await baseProgram.account.agentMandate.fetch(created.mandate);
    expect(m.revoked).to.equal(false);
  });

  it("rejects spend after revocation and records nothing", async () => {
    const created = await createMandate(sponsor, agent, mint);
    await revokeMandate(sponsor, created.mandate);
    await expectProgramError(recordSpend(sponsor, created.mandate, 1_000_000), "MandateRevoked");
    const m = await baseProgram.account.agentMandate.fetch(created.mandate);
    expect(m.totalSpent.toNumber()).to.equal(0);
  });

  it("cannot be un-revoked: no instruction clears the flag and a repeat revoke fails", async () => {
    // Guard: the program exposes exactly these instructions. If an instruction that could
    // touch `revoked` is ever added, this fails on purpose and must be reviewed.
    const names = baseProgram.idl.instructions.map((i) => i.name.replace(/_/g, "").toLowerCase()).sort();
    expect(names).to.deep.equal(["initializemandate", "recordspend", "revokemandate"]);

    const created = await createMandate(sponsor, agent, mint);
    await revokeMandate(sponsor, created.mandate);
    const first = await baseProgram.account.agentMandate.fetch(created.mandate);
    expect(first.revoked).to.equal(true);

    await expectProgramError(revokeMandate(sponsor, created.mandate), "MandateRevoked");
    const after = await baseProgram.account.agentMandate.fetch(created.mandate);
    expect(after.revoked).to.equal(true);
    expect(after.updatedAt.toNumber()).to.equal(first.updatedAt.toNumber());
    await expectProgramError(recordSpend(sponsor, created.mandate, 1_000_000), "MandateRevoked");
  });
});

// ---------- abuse paths: expiry and spend limits ----------

const U64_MAX = new anchor.BN("18446744073709551615");

describe("aegis abuse paths: expiry", () => {
  let sponsor: Keypair;
  let agent: PublicKey;
  let mint: PublicKey;

  before(async () => {
    sponsor = await fundedActor();
    agent = Keypair.generate().publicKey;
    mint = Keypair.generate().publicKey;
  });

  it("rejects spend after expiry and records nothing", async () => {
    const created = await createMandate(sponsor, agent, mint, { expiresIn: 120 });
    // Valid before expiry: proves the later failure is caused by expiry alone.
    await recordSpend(sponsor, created.mandate, 10_000_000);

    const expiresAt = created.params.expiresAt.toNumber();
    await timeTravelTo(expiresAt + 1);
    const now = await waitForChainTime(expiresAt + 1);
    expect(now).to.be.at.least(expiresAt + 1);

    await expectProgramError(recordSpend(sponsor, created.mandate, 10_000_000), "MandateExpired");
    const m = await baseProgram.account.agentMandate.fetch(created.mandate);
    expect(m.totalSpent.toNumber()).to.equal(10_000_000);
  });

  it("rejects spend once the clock reaches the expiry timestamp", async () => {
    const created = await createMandate(sponsor, agent, mint, { expiresIn: 120 });
    const expiresAt = created.params.expiresAt.toNumber();
    await timeTravelTo(expiresAt);
    const now = await waitForChainTime(expiresAt);
    expect(now).to.be.at.least(expiresAt);

    await expectProgramError(recordSpend(sponsor, created.mandate, 1_000_000), "MandateExpired");
    const m = await baseProgram.account.agentMandate.fetch(created.mandate);
    expect(m.totalSpent.toNumber()).to.equal(0);
  });

  it("still lets the sponsor revoke an expired mandate", async () => {
    const created = await createMandate(sponsor, agent, mint, { expiresIn: 60 });
    const expiresAt = created.params.expiresAt.toNumber();
    await timeTravelTo(expiresAt + 1);
    await waitForChainTime(expiresAt + 1);

    await revokeMandate(sponsor, created.mandate);
    const m = await baseProgram.account.agentMandate.fetch(created.mandate);
    expect(m.revoked).to.equal(true);
  });
});

describe("aegis abuse paths: spend limits", () => {
  let sponsor: Keypair;
  let agent: PublicKey;
  let mint: PublicKey;

  before(async () => {
    sponsor = await fundedActor();
    agent = Keypair.generate().publicKey;
    mint = Keypair.generate().publicKey;
  });

  it("rejects a zero-amount spend", async () => {
    const created = await createMandate(sponsor, agent, mint);
    await expectProgramError(recordSpend(sponsor, created.mandate, 0), "InvalidAmount");
    const m = await baseProgram.account.agentMandate.fetch(created.mandate);
    expect(m.totalSpent.toNumber()).to.equal(0);
  });

  it("rejects a spend above the per-transaction limit but allows exactly the limit", async () => {
    const created = await createMandate(sponsor, agent, mint);
    await expectProgramError(recordSpend(sponsor, created.mandate, MAX_PER_TX + 1), "ExceedsPerTxLimit");
    let m = await baseProgram.account.agentMandate.fetch(created.mandate);
    expect(m.totalSpent.toNumber()).to.equal(0);

    await recordSpend(sponsor, created.mandate, MAX_PER_TX);
    m = await baseProgram.account.agentMandate.fetch(created.mandate);
    expect(m.totalSpent.toNumber()).to.equal(MAX_PER_TX);
  });

  it("rejects a spend that would exceed the total cap and records nothing", async () => {
    const created = await createMandate(sponsor, agent, mint);
    await recordSpend(sponsor, created.mandate, 100_000_000);
    await recordSpend(sponsor, created.mandate, 100_000_000);
    // 200M spent, 50M remaining; 60M is within the per-tx limit but over the remaining allowance.
    await expectProgramError(recordSpend(sponsor, created.mandate, 60_000_000), "ExceedsTotalLimit");
    const m = await baseProgram.account.agentMandate.fetch(created.mandate);
    expect(m.totalSpent.toNumber()).to.equal(200_000_000);
  });

  it("allows spends up to exactly the total cap, then rejects any further spend", async () => {
    const created = await createMandate(sponsor, agent, mint);
    await recordSpend(sponsor, created.mandate, 100_000_000);
    await recordSpend(sponsor, created.mandate, 100_000_000);
    await recordSpend(sponsor, created.mandate, 50_000_000);
    let m = await baseProgram.account.agentMandate.fetch(created.mandate);
    expect(m.totalSpent.toNumber()).to.equal(MAX_TOTAL);

    await expectProgramError(recordSpend(sponsor, created.mandate, 1), "ExceedsTotalLimit");
    m = await baseProgram.account.agentMandate.fetch(created.mandate);
    expect(m.totalSpent.toNumber()).to.equal(MAX_TOTAL);
  });

  it("rejects a spend that would overflow u64 instead of wrapping around", async () => {
    // Both limits at u64::MAX. A naive `total_spent + amount <= max_total` check would
    // wrap around to a small number and wrongly pass; the remaining-allowance check must not.
    const created = await createMandate(sponsor, agent, mint, { maxPerTx: U64_MAX, maxTotal: U64_MAX });
    await recordSpend(sponsor, created.mandate, U64_MAX.subn(5));
    await expectProgramError(recordSpend(sponsor, created.mandate, 10), "ExceedsTotalLimit");
    let m = await baseProgram.account.agentMandate.fetch(created.mandate);
    expect(m.totalSpent.toString()).to.equal(U64_MAX.subn(5).toString());

    // Exactly the remaining 5 units fills the cap to u64::MAX; one more unit is rejected.
    await recordSpend(sponsor, created.mandate, 5);
    m = await baseProgram.account.agentMandate.fetch(created.mandate);
    expect(m.totalSpent.toString()).to.equal(U64_MAX.toString());
    await expectProgramError(recordSpend(sponsor, created.mandate, 1), "ExceedsTotalLimit");
  });
});
