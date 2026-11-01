import {
  AuthorityType,
  ASSOCIATED_TOKEN_PROGRAM_ID as SPL_ASSOCIATED_TOKEN_ID,
  TOKEN_2022_PROGRAM_ID as SPL_TOKEN_2022_ID,
  TOKEN_PROGRAM_ID as SPL_TOKEN_ID,
  createApproveCheckedInstruction,
  createApproveInstruction,
  createSetAuthorityInstruction,
  createTransferCheckedInstruction,
  createTransferInstruction,
} from "@solana/spl-token";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { expect } from "chai";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  MAX_TRANSACTION_BYTES,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  decodeTransaction,
} from "../src";
import type { DecodedTransaction } from "../src";

// Every transaction below is built with the real @solana/web3.js and @solana/spl-token builders and
// serialized, so the decoder is tested on bytes the libraries actually produce.

const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const key = () => Keypair.generate().publicKey;
const b58 = (k: PublicKey) => k.toBase58();
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

function legacyBytes(feePayer: PublicKey, ixs: TransactionInstruction[]): Buffer {
  const tx = new Transaction();
  tx.feePayer = feePayer;
  tx.recentBlockhash = BLOCKHASH;
  tx.add(...ixs);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}

function v0Bytes(payer: PublicKey, ixs: TransactionInstruction[]): Buffer {
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: BLOCKHASH,
    instructions: ixs,
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize());
}

const decodeLegacy = (payer: PublicKey, ixs: TransactionInstruction[]) =>
  decodeTransaction(b64(legacyBytes(payer, ixs)));

function only<T>(items: readonly T[]): T {
  expect(items).to.have.length(1);
  return items[0] as T;
}

function expectInvalid(d: DecodedTransaction, code: RegExp): void {
  expect(d.valid).to.equal(false);
  expect(d.fullyRecognized).to.equal(false);
  expect(d.signers).to.deep.equal([]);
  expect(d.programIds).to.deep.equal([]);
  expect(d.instructions).to.deep.equal([]);
  expect(d.transfers).to.deep.equal([]);
  expect(d.authorityChanges).to.deep.equal([]);
  expect(d.unrecognizedInstructions).to.deep.equal([]);
  expect(d.errors).to.have.length(1);
  expect(d.errors[0]).to.match(code);
}

describe("decodeTransaction: input validation", () => {
  const payer = key();
  const good = () =>
    legacyBytes(payer, [SystemProgram.transfer({ fromPubkey: payer, toPubkey: key(), lamports: 1n })]);

  it("rejects empty and non-string input", async () => {
    expectInvalid(await decodeTransaction(""), /^EMPTY_INPUT/);
    for (const bad of [undefined, null, 123, {}, []]) {
      expectInvalid(await decodeTransaction(bad as unknown as string), /^INVALID_BASE64/);
    }
  });

  it("rejects anything that is not canonical base64", async () => {
    const bad = ["not base64!!", "AAAA!!!!AAAA", "AA AA", "-_-_", "AA", "AAAA====", " ", "AB=="];
    for (const s of bad) {
      expectInvalid(await decodeTransaction(s), /^INVALID_BASE64/);
    }
  });

  it("rejects oversized input", async () => {
    expectInvalid(await decodeTransaction(b64(Buffer.alloc(2000))), /^TOO_LARGE/);
    expectInvalid(await decodeTransaction(b64(Buffer.alloc(MAX_TRANSACTION_BYTES + 1))), /^TOO_LARGE/);
  });

  it("rejects valid base64 that is not a transaction", async () => {
    for (const junk of [Buffer.alloc(64, 7), Buffer.alloc(100, 0), Buffer.alloc(200, 0xff)]) {
      expectInvalid(await decodeTransaction(b64(junk)), /^(MALFORMED_TRANSACTION|NON_CANONICAL_ENCODING)/);
    }
  });

  it("rejects a truncated transaction", async () => {
    const bytes = good();
    expectInvalid(await decodeTransaction(b64(bytes.subarray(0, bytes.length - 5))), /^MALFORMED_TRANSACTION/);
  });

  it("rejects a transaction with trailing bytes (the parser alone would accept it)", async () => {
    const padded = Buffer.concat([good(), Buffer.from([1, 2, 3])]);
    expectInvalid(await decodeTransaction(b64(padded)), /^NON_CANONICAL_ENCODING/);
  });

  it("never throws, whatever it is given", async () => {
    const hostile: unknown[] = ["A".repeat(100_000), "=".repeat(4), "\u0000", "AAAA".repeat(400), Symbol("x")];
    for (const h of hostile) {
      let d: DecodedTransaction | undefined;
      try {
        d = await decodeTransaction(h as string);
      } catch (e) {
        expect.fail(`decodeTransaction threw: ${String(e)}`);
      }
      expect(d?.valid).to.equal(false);
    }
  });
});

describe("decodeTransaction: SOL transfers", () => {
  const payer = Keypair.generate();
  const dest = key();

  it("decodes a legacy SOL transfer", async () => {
    const ix = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: dest, lamports: 1_500_000_000n });
    const d = await decodeLegacy(payer.publicKey, [ix]);
    expect(d.valid).to.equal(true);
    expect(d.errors).to.deep.equal([]);
    expect(d.transactionType).to.equal("legacy");
    expect(d.fullyRecognized).to.equal(true);
    expect(d.signers).to.deep.equal([b58(payer.publicKey)]);
    expect(d.programIds).to.deep.equal([SYSTEM_PROGRAM_ID]);
    expect(d.authorityChanges).to.deep.equal([]);
    expect(d.unrecognizedInstructions).to.deep.equal([]);
    expect(d.instructions).to.have.length(1);
    expect(d.instructions[0]).to.include({
      index: 0,
      programId: SYSTEM_PROGRAM_ID,
      classification: "SYSTEM_TRANSFER",
      recognized: true,
    });

    const t = only(d.transfers);
    expect(t.kind).to.equal("SOL");
    expect(t.instructionIndex).to.equal(0);
    expect(t.programId).to.equal(SYSTEM_PROGRAM_ID);
    expect(t.source).to.equal(b58(payer.publicKey));
    expect(t.destination).to.equal(b58(dest));
    expect(typeof t.amount).to.equal("bigint");
    expect(t.amount).to.equal(1_500_000_000n);
    expect(t.amount).to.equal(SystemInstruction.decodeTransfer(ix).lamports); // independent cross-check
    expect(t.mint).to.equal(undefined);
    expect(t.destinationIsTokenAccount).to.equal(false);
    expect(t.unresolved).to.deep.equal([]);
  });

  it("decodes a versioned (v0) SOL transfer that uses no lookup tables", async () => {
    const ix = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: dest, lamports: 42n });
    const d = await decodeTransaction(b64(v0Bytes(payer.publicKey, [ix])));
    expect(d.valid).to.equal(true);
    expect(d.transactionType).to.equal("versioned");
    expect(d.fullyRecognized).to.equal(true);
    const t = only(d.transfers);
    expect(t.source).to.equal(b58(payer.publicKey));
    expect(t.destination).to.equal(b58(dest));
    expect(t.amount).to.equal(42n);
  });

  it("decodes SOL amounts above 2^53 exactly", async () => {
    for (const lamports of [9_007_199_254_740_993n, 12_345_678_901_234_567n, 18_446_744_073_709_551_615n]) {
      const ix = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: dest, lamports });
      const t = only((await decodeLegacy(payer.publicKey, [ix])).transfers);
      expect(typeof t.amount).to.equal("bigint");
      expect(t.amount).to.equal(lamports);
    }
  });

  it("explicitly rejects a v0 transaction that uses an address lookup table", async () => {
    const ix = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: dest, lamports: 1n });
    const lut = new AddressLookupTableAccount({
      key: key(),
      state: {
        deactivationSlot: 0xffffffffffffffffn,
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        authority: undefined,
        addresses: [dest],
      },
    });
    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: BLOCKHASH,
      instructions: [ix],
    }).compileToV0Message([lut]);
    const d = await decodeTransaction(b64(new VersionedTransaction(msg).serialize()));
    expectInvalid(d, /^ADDRESS_LOOKUP_TABLES_UNSUPPORTED/);
    expect(d.transactionType).to.equal("versioned");
  });
});

describe("decodeTransaction: SPL token transfers", () => {
  const feePayer = Keypair.generate();
  const src = key();
  const dst = key();
  const owner = key();
  const mint = key();

  it("decodes a Transfer: no mint is invented, the destination is a token account", async () => {
    const d = await decodeLegacy(feePayer.publicKey, [createTransferInstruction(src, dst, owner, 5_000_000n)]);
    expect(d.valid).to.equal(true);
    expect(d.programIds).to.deep.equal([TOKEN_PROGRAM_ID]);
    expect(d.instructions[0]?.classification).to.equal("TOKEN_TRANSFER");
    const t = only(d.transfers);
    expect(t.kind).to.equal("SPL_TOKEN");
    expect(t.programId).to.equal(TOKEN_PROGRAM_ID);
    expect(t.source).to.equal(b58(src));
    expect(t.destination).to.equal(b58(dst));
    expect(t.authority).to.equal(b58(owner));
    expect(t.amount).to.equal(5_000_000n);
    expect(t.mint).to.equal(undefined);
    expect(t.destinationIsTokenAccount).to.equal(true);
    expect(t.additionalSigners).to.deep.equal([]);
    expect(t.unresolved).to.have.members(["MINT_UNRESOLVED", "DESTINATION_OWNER_UNRESOLVED"]);
  });

  it("decodes a TransferChecked: the mint and decimals come from the instruction", async () => {
    const d = await decodeLegacy(feePayer.publicKey, [
      createTransferCheckedInstruction(src, mint, dst, owner, 7_000_000n, 6),
    ]);
    expect(d.valid).to.equal(true);
    expect(d.instructions[0]?.classification).to.equal("TOKEN_TRANSFER_CHECKED");
    const t = only(d.transfers);
    expect(t.source).to.equal(b58(src));
    expect(t.mint).to.equal(b58(mint));
    expect(t.destination).to.equal(b58(dst));
    expect(t.authority).to.equal(b58(owner));
    expect(t.decimals).to.equal(6);
    expect(t.amount).to.equal(7_000_000n);
    expect(t.destinationIsTokenAccount).to.equal(true);
    expect(t.unresolved).to.deep.equal(["DESTINATION_OWNER_UNRESOLVED"]);
  });

  it("decodes token amounts above 2^53 exactly, up to the u64 maximum", async () => {
    for (const amount of [9_007_199_254_740_993n, 1_234_567_890_123_456_789n, 18_446_744_073_709_551_615n]) {
      const plain = only((await decodeLegacy(feePayer.publicKey, [createTransferInstruction(src, dst, owner, amount)])).transfers);
      const checked = only(
        (await decodeLegacy(feePayer.publicKey, [createTransferCheckedInstruction(src, mint, dst, owner, amount, 6)])).transfers
      );
      expect(typeof plain.amount).to.equal("bigint");
      expect(plain.amount).to.equal(amount);
      expect(checked.amount).to.equal(amount);
    }
  });

  it("captures multisig signer accounts instead of assuming exactly three accounts", async () => {
    const multisig = key();
    const s1 = Keypair.generate();
    const s2 = Keypair.generate();
    const d = await decodeLegacy(feePayer.publicKey, [createTransferInstruction(src, dst, multisig, 9n, [s1, s2])]);
    expect(d.valid).to.equal(true);
    const t = only(d.transfers);
    expect(t.authority).to.equal(b58(multisig));
    expect(t.additionalSigners).to.deep.equal([b58(s1.publicKey), b58(s2.publicKey)]);
    expect(t.destination).to.equal(b58(dst));
    expect(d.signers).to.have.members([b58(feePayer.publicKey), b58(s1.publicKey), b58(s2.publicKey)]);
  });
});

describe("decodeTransaction: authority changes (security-sensitive)", () => {
  const feePayer = Keypair.generate();
  const account = key();
  const owner = key();
  const delegate = key();
  const mint = key();
  const newAuthority = key();

  it("flags a System Assign", async () => {
    const newOwnerProgram = key();
    const ix = SystemProgram.assign({ accountPubkey: account, programId: newOwnerProgram });
    const d = await decodeLegacy(feePayer.publicKey, [ix]);
    expect(d.valid).to.equal(true);
    expect(d.transfers).to.deep.equal([]);
    expect(d.instructions[0]?.classification).to.equal("SYSTEM_ASSIGN");
    const c = only(d.authorityChanges);
    expect(c.kind).to.equal("SYSTEM_ASSIGN");
    expect(c.securitySensitive).to.equal(true);
    expect(c.account).to.equal(b58(account));
    expect(c.newOwnerProgram).to.equal(b58(newOwnerProgram));
  });

  it("flags an Approve and does not report it as a transfer", async () => {
    const d = await decodeLegacy(feePayer.publicKey, [createApproveInstruction(account, delegate, owner, 5_000_000n)]);
    expect(d.valid).to.equal(true);
    expect(d.transfers).to.deep.equal([]);
    const c = only(d.authorityChanges);
    expect(c.kind).to.equal("TOKEN_APPROVE");
    expect(c.securitySensitive).to.equal(true);
    expect(c.programId).to.equal(TOKEN_PROGRAM_ID);
    expect(c.account).to.equal(b58(account));
    expect(c.delegate).to.equal(b58(delegate));
    expect(c.authority).to.equal(b58(owner));
    expect(c.amount).to.equal(5_000_000n);
    expect(c.additionalSigners).to.deep.equal([]);
  });

  it("flags an ApproveChecked with its mint and decimals", async () => {
    const d = await decodeLegacy(feePayer.publicKey, [
      createApproveCheckedInstruction(account, mint, delegate, owner, 18_446_744_073_709_551_615n, 6),
    ]);
    expect(d.instructions[0]?.classification).to.equal("TOKEN_APPROVE_CHECKED");
    const c = only(d.authorityChanges);
    expect(c.kind).to.equal("TOKEN_APPROVE");
    expect(c.securitySensitive).to.equal(true);
    expect(c.account).to.equal(b58(account));
    expect(c.mint).to.equal(b58(mint));
    expect(c.delegate).to.equal(b58(delegate));
    expect(c.authority).to.equal(b58(owner));
    expect(c.decimals).to.equal(6);
    expect(c.amount).to.equal(18_446_744_073_709_551_615n);
  });

  it("flags a SetAuthority that installs a new authority", async () => {
    const d = await decodeLegacy(feePayer.publicKey, [
      createSetAuthorityInstruction(account, owner, AuthorityType.AccountOwner, newAuthority),
    ]);
    expect(d.valid).to.equal(true);
    expect(d.transfers).to.deep.equal([]);
    const c = only(d.authorityChanges);
    expect(c.kind).to.equal("TOKEN_SET_AUTHORITY");
    expect(c.securitySensitive).to.equal(true);
    expect(c.account).to.equal(b58(account));
    expect(c.authority).to.equal(b58(owner));
    expect(c.authorityType).to.equal(AuthorityType.AccountOwner);
    expect(c.newAuthority).to.equal(b58(newAuthority));
  });

  it("flags a SetAuthority that clears the authority (null)", async () => {
    const d = await decodeLegacy(feePayer.publicKey, [
      createSetAuthorityInstruction(account, owner, AuthorityType.AccountOwner, null),
    ]);
    const c = only(d.authorityChanges);
    expect(c.kind).to.equal("TOKEN_SET_AUTHORITY");
    expect(c.securitySensitive).to.equal(true);
    expect(c.newAuthority).to.equal(null);
  });
});

describe("decodeTransaction: Token-2022 (base instruction decoding only)", () => {
  const feePayer = Keypair.generate();
  const src = key();
  const dst = key();
  const owner = key();
  const mint = key();
  const delegate = key();
  const flag = "TOKEN_2022_EXTENSIONS_UNRESOLVED";

  it("decodes Token-2022 base instructions and flags extension effects as unresolved", async () => {
    const t1 = only(
      (await decodeLegacy(feePayer.publicKey, [createTransferInstruction(src, dst, owner, 1n, [], SPL_TOKEN_2022_ID)])).transfers
    );
    expect(t1.programId).to.equal(TOKEN_2022_PROGRAM_ID);
    expect(t1.unresolved).to.include(flag);
    expect(t1.unresolved).to.include("MINT_UNRESOLVED");

    const t2 = only(
      (await decodeLegacy(feePayer.publicKey, [createTransferCheckedInstruction(src, mint, dst, owner, 2n, 6, [], SPL_TOKEN_2022_ID)])).transfers
    );
    expect(t2.programId).to.equal(TOKEN_2022_PROGRAM_ID);
    expect(t2.mint).to.equal(b58(mint));
    expect(t2.unresolved).to.include(flag);

    const a = only(
      (await decodeLegacy(feePayer.publicKey, [createApproveInstruction(src, delegate, owner, 3n, [], SPL_TOKEN_2022_ID)])).authorityChanges
    );
    expect(a.programId).to.equal(TOKEN_2022_PROGRAM_ID);
    expect(a.unresolved).to.include(flag);

    const s = only(
      (await decodeLegacy(feePayer.publicKey, [createSetAuthorityInstruction(src, owner, AuthorityType.AccountOwner, null, [], SPL_TOKEN_2022_ID)])).authorityChanges
    );
    expect(s.programId).to.equal(TOKEN_2022_PROGRAM_ID);
    expect(s.unresolved).to.include(flag);
  });

  it("does not attach the Token-2022 flag to classic Token instructions", async () => {
    const t = only((await decodeLegacy(feePayer.publicKey, [createTransferInstruction(src, dst, owner, 1n)])).transfers);
    expect(t.unresolved).to.not.include(flag);
  });
});

describe("decodeTransaction: unrecognized and malformed instructions are preserved and flagged", () => {
  const payer = Keypair.generate();
  const meta = () => ({ pubkey: key(), isSigner: false, isWritable: true });

  it("preserves an unknown program instruction with its accounts and raw data", async () => {
    const program = key();
    const keys = [meta(), meta()];
    const ix = new TransactionInstruction({ programId: program, keys, data: Buffer.from([1, 2, 3]) });
    const d = await decodeLegacy(payer.publicKey, [ix]);
    expect(d.valid).to.equal(true);
    expect(d.fullyRecognized).to.equal(false);
    expect(d.transfers).to.deep.equal([]);
    expect(d.programIds).to.deep.equal([b58(program)]);
    expect(d.instructions[0]).to.include({ index: 0, classification: "UNRECOGNIZED", recognized: false });
    const u = only(d.unrecognizedInstructions);
    expect(u.instructionIndex).to.equal(0);
    expect(u.programId).to.equal(b58(program));
    expect(u.accounts).to.deep.equal(keys.map((k) => b58(k.pubkey)));
    expect(u.dataBase64).to.equal(Buffer.from([1, 2, 3]).toString("base64"));
    expect(u.knownProgram).to.equal(false);
    expect(u.reason).to.match(/Unknown program/);
  });

  it("flags unknown opcodes of known programs and the Associated Token Program", async () => {
    const systemData = Buffer.alloc(4);
    systemData.writeUInt32LE(11);
    const cases: Array<{ ix: TransactionInstruction; reason: RegExp }> = [
      {
        ix: new TransactionInstruction({ programId: SPL_TOKEN_ID, keys: [meta(), meta()], data: Buffer.from([99]) }),
        reason: /Token Program instruction not analyzed \(opcode 99\)/,
      },
      {
        ix: new TransactionInstruction({ programId: SystemProgram.programId, keys: [meta()], data: systemData }),
        reason: /System Program instruction not analyzed \(opcode 11\)/,
      },
      {
        ix: new TransactionInstruction({ programId: SPL_ASSOCIATED_TOKEN_ID, keys: [meta(), meta()], data: Buffer.from([1]) }),
        reason: /Associated Token Program instruction not analyzed/,
      },
    ];
    for (const c of cases) {
      const d = await decodeLegacy(payer.publicKey, [c.ix]);
      expect(d.valid).to.equal(true);
      expect(d.fullyRecognized).to.equal(false);
      expect(d.transfers).to.deep.equal([]);
      const u = only(d.unrecognizedInstructions);
      expect(u.knownProgram).to.equal(true);
      expect(u.reason).to.match(c.reason);
    }
  });

  it("preserves instructions with truncated data or too few accounts as flagged, never as transfers", async () => {
    const amount = Buffer.alloc(8, 1);
    const setAuthorityBadFlag = Buffer.alloc(35);
    setAuthorityBadFlag[0] = 6;
    setAuthorityBadFlag[1] = 2;
    const setAuthorityClearBadFlag = Buffer.from([6, 2, 1]);
    const systemShort = Buffer.alloc(8);
    systemShort.writeUInt32LE(2);
    const systemFull = Buffer.alloc(12);
    systemFull.writeUInt32LE(2);
    const assignShort = Buffer.alloc(35);
    assignShort.writeUInt32LE(1);

    const cases: Array<{ ix: TransactionInstruction; reason: RegExp }> = [
      {
        ix: new TransactionInstruction({ programId: SPL_TOKEN_ID, keys: [meta(), meta(), meta()], data: Buffer.from([3, 1, 2, 3]) }),
        reason: /Malformed Token transfer:/,
      },
      {
        ix: new TransactionInstruction({ programId: SPL_TOKEN_ID, keys: [meta(), meta()], data: Buffer.concat([Buffer.from([3]), amount]) }),
        reason: /Malformed Token transfer:/,
      },
      {
        ix: new TransactionInstruction({ programId: SPL_TOKEN_ID, keys: [meta(), meta(), meta()], data: Buffer.concat([Buffer.from([3]), amount, Buffer.from([0])]) }),
        reason: /Malformed Token transfer:/,
      },
      {
        ix: new TransactionInstruction({ programId: SPL_TOKEN_ID, keys: [meta(), meta(), meta(), meta()], data: Buffer.concat([Buffer.from([12]), amount]) }),
        reason: /Malformed Token transfer-checked:/,
      },
      {
        ix: new TransactionInstruction({ programId: SPL_TOKEN_ID, keys: [meta(), meta()], data: Buffer.concat([Buffer.from([4]), amount]) }),
        reason: /Malformed Token approve:/,
      },
      {
        ix: new TransactionInstruction({ programId: SPL_TOKEN_ID, keys: [meta(), meta()], data: setAuthorityBadFlag }),
        reason: /Malformed Token set-authority:/,
      },
      {
        ix: new TransactionInstruction({ programId: SPL_TOKEN_ID, keys: [meta(), meta()], data: setAuthorityClearBadFlag }),
        reason: /Malformed Token set-authority:/,
      },
      {
        ix: new TransactionInstruction({ programId: SPL_TOKEN_ID, keys: [meta()], data: Buffer.alloc(0) }),
        reason: /Malformed Token instruction:/,
      },
      {
        ix: new TransactionInstruction({ programId: SystemProgram.programId, keys: [meta(), meta()], data: systemShort }),
        reason: /Malformed System transfer:/,
      },
      {
        ix: new TransactionInstruction({ programId: SystemProgram.programId, keys: [meta(), meta(), meta()], data: systemFull }),
        reason: /Malformed System transfer:/,
      },
      {
        ix: new TransactionInstruction({ programId: SystemProgram.programId, keys: [meta()], data: assignShort }),
        reason: /Malformed System assign:/,
      },
    ];
    for (const c of cases) {
      const d = await decodeLegacy(payer.publicKey, [c.ix]);
      expect(d.valid, c.reason.source).to.equal(true);
      expect(d.fullyRecognized).to.equal(false);
      expect(d.transfers, c.reason.source).to.deep.equal([]);
      expect(d.authorityChanges, c.reason.source).to.deep.equal([]);
      expect(d.instructions[0]?.classification).to.equal("UNRECOGNIZED");
      const u = only(d.unrecognizedInstructions);
      expect(u.knownProgram).to.equal(true);
      expect(u.reason).to.match(c.reason);
    }
  });

  it("still reports detected transfers next to an unknown instruction, but not as fully recognized", async () => {
    const dest = key();
    const unknown = new TransactionInstruction({ programId: key(), keys: [meta()], data: Buffer.from([7]) });
    const d = await decodeLegacy(payer.publicKey, [
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: dest, lamports: 10n }),
      unknown,
    ]);
    expect(d.valid).to.equal(true);
    expect(only(d.transfers).destination).to.equal(b58(dest));
    expect(only(d.unrecognizedInstructions).instructionIndex).to.equal(1);
    expect(d.fullyRecognized).to.equal(false);
  });

  it("reports a transaction with no transfer as decoded, without treating it as authorized", async () => {
    const d = await decodeLegacy(payer.publicKey, [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 })]);
    expect(d.valid).to.equal(true);
    expect(d.fullyRecognized).to.equal(true);
    expect(d.transfers).to.deep.equal([]);
    expect(d.authorityChanges).to.deep.equal([]);
    expect(d.programIds).to.deep.equal([COMPUTE_BUDGET_PROGRAM_ID]);
    expect(d.instructions[0]?.classification).to.equal("COMPUTE_BUDGET");
    // The decoder has no notion of allow or deny: that is the policy engine's decision.
    expect(d).to.not.have.property("decision");
    expect(d).to.not.have.property("allowed");
  });
});

describe("decodeTransaction: several instructions", () => {
  it("preserves multiple transfers separately, in order, with true instruction indices", async () => {
    const payer = Keypair.generate();
    const src = key();
    const dst = key();
    const owner = key();
    const mint = key();
    const destA = key();
    const destB = key();
    const d = await decodeLegacy(payer.publicKey, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: destA, lamports: 1_000n }),
      createTransferInstruction(src, dst, owner, 2_000n),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: destB, lamports: 3_000n }),
      createTransferCheckedInstruction(src, mint, dst, owner, 4_000n, 6),
    ]);
    expect(d.valid).to.equal(true);
    expect(d.fullyRecognized).to.equal(true);
    expect(d.instructions.map((i) => i.classification)).to.deep.equal([
      "COMPUTE_BUDGET",
      "SYSTEM_TRANSFER",
      "TOKEN_TRANSFER",
      "SYSTEM_TRANSFER",
      "TOKEN_TRANSFER_CHECKED",
    ]);
    expect(d.instructions.map((i) => i.index)).to.deep.equal([0, 1, 2, 3, 4]);
    expect(d.transfers.map((t) => [t.kind, t.instructionIndex, t.amount])).to.deep.equal([
      ["SOL", 1, 1_000n],
      ["SPL_TOKEN", 2, 2_000n],
      ["SOL", 3, 3_000n],
      ["SPL_TOKEN", 4, 4_000n],
    ]);
    expect(d.transfers[0]?.destination).to.equal(b58(destA));
    expect(d.transfers[2]?.destination).to.equal(b58(destB));
    expect(d.programIds).to.deep.equal([COMPUTE_BUDGET_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID]);
  });
});

describe("decodeTransaction: invalid references and headers", () => {
  const payer = Keypair.generate();
  const base = () =>
    legacyBytes(payer.publicKey, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: key(), lamports: 1n })]);
  // Layout of this one-signer, three-key, one-instruction legacy transaction (215 bytes):
  // [1 sig count][64 sig][3 header][1 key count][3 * 32 keys][32 blockhash][1 ix count][ix...]
  const IX_START = 1 + 64 + 3 + 1 + 3 * 32 + 32 + 1;

  it("rejects an instruction whose program index is outside the account list", async () => {
    const bytes = Buffer.from(base());
    expect(bytes.length).to.equal(215);
    expect(bytes[68]).to.equal(3); // key count
    expect(bytes[IX_START]).to.equal(2); // program id index (the System Program is the third key)
    bytes[IX_START] = 9;
    expectInvalid(await decodeTransaction(b64(bytes)), /^(INVALID_ACCOUNT_REFERENCE|MALFORMED_TRANSACTION)/);
  });

  it("rejects an instruction whose account index is outside the account list", async () => {
    const bytes = Buffer.from(base());
    expect(bytes[IX_START + 1]).to.equal(2); // account count
    expect(bytes[IX_START + 3]).to.equal(1); // second account index (the destination)
    bytes[IX_START + 3] = 9;
    expectInvalid(await decodeTransaction(b64(bytes)), /^(INVALID_ACCOUNT_REFERENCE|MALFORMED_TRANSACTION)/);
  });

  it("rejects a header that disagrees with the signature count", async () => {
    const bytes = Buffer.from(base());
    expect(bytes[65]).to.equal(1); // numRequiredSignatures
    bytes[65] = 2;
    expectInvalid(await decodeTransaction(b64(bytes)), /^MALFORMED_TRANSACTION/);
  });
});

describe("decoder constants", () => {
  it("match the program IDs exported by the libraries", () => {
    expect(SYSTEM_PROGRAM_ID).to.equal(SystemProgram.programId.toBase58());
    expect(COMPUTE_BUDGET_PROGRAM_ID).to.equal(ComputeBudgetProgram.programId.toBase58());
    expect(TOKEN_PROGRAM_ID).to.equal(SPL_TOKEN_ID.toBase58());
    expect(TOKEN_2022_PROGRAM_ID).to.equal(SPL_TOKEN_2022_ID.toBase58());
    expect(ASSOCIATED_TOKEN_PROGRAM_ID).to.equal(SPL_ASSOCIATED_TOKEN_ID.toBase58());
    expect(MAX_TRANSACTION_BYTES).to.equal(1232);
  });
});
