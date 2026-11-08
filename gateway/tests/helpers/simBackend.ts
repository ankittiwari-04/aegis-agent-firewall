import { decodeTransaction } from "../../src";
import type { AccountSnapshot, RawSimulatedAccount, SimulationBackend } from "../../src";

// A tiny fake bank for tests. It reads account state from `provider`, applies the decoded SPL
// transfers and a fee, and lets a test inject failures or unexpected mutations.

const U64_MAX = (1n << 64n) - 1n;

export type Provider = (address: string) => AccountSnapshot | null;

export interface BankHooks {
  /** Makes the simulation fail with this error. */
  fail?: unknown;
  throwOnGetAccounts?: boolean;
  throwOnSimulate?: boolean;
  /** Return no account state. */
  omitAccounts?: boolean;
  /** Return one account too few. */
  shortAccounts?: boolean;
  logs?: string[] | null;
  unitsConsumed?: number;
  /** Fee taken from the fee payer. Default 5000. */
  fee?: bigint;
  /** Do not apply the decoded transfers (the chain "did nothing"). */
  skipTransfers?: boolean;
  /** Edit the post-simulation state before it is returned. */
  mutate?: (post: Map<string, AccountSnapshot | null>) => void;
}

export interface BankBackend extends SimulationBackend {
  calls: { getAccounts: number; simulate: number };
}

function clone(a: AccountSnapshot | null): AccountSnapshot | null {
  return a === null ? null : { lamports: a.lamports, owner: a.owner, executable: a.executable, data: Buffer.from(a.data) };
}

function adjustTokenAmount(post: Map<string, AccountSnapshot | null>, address: string, delta: bigint): boolean {
  const account = post.get(address) ?? null;
  if (account === null || account.data.length < 72) return false;
  const next = account.data.readBigUInt64LE(64) + delta;
  if (next < 0n || next > U64_MAX) return false;
  account.data.writeBigUInt64LE(next, 64);
  return true;
}

export function bankBackend(provider: Provider, hooks: BankHooks = {}): BankBackend {
  const calls = { getAccounts: 0, simulate: 0 };
  return {
    calls,
    async getAccounts(addresses) {
      calls.getAccounts += 1;
      if (hooks.throwOnGetAccounts) throw new Error("rpc down http://user:secret@127.0.0.1:8899");
      return addresses.map((a) => clone(provider(a)));
    },
    async simulate(transactionBase64, addresses) {
      calls.simulate += 1;
      if (hooks.throwOnSimulate) throw new Error("rpc down http://user:secret@127.0.0.1:8899");
      const decoded = await decodeTransaction(transactionBase64);
      const post = new Map<string, AccountSnapshot | null>();
      for (const a of addresses) post.set(a, clone(provider(a)));

      let overflow = false;
      if (hooks.fail === undefined) {
        if (!hooks.skipTransfers) {
          for (const t of decoded.transfers) {
            if (t.kind !== "SPL_TOKEN") continue;
            if (!adjustTokenAmount(post, t.source, -t.amount)) overflow = true;
            if (!adjustTokenAmount(post, t.destination, t.amount)) overflow = true;
          }
        }
        const payer = decoded.signers[0];
        const fee = hooks.fee ?? 5_000n;
        const payerAccount = payer === undefined ? null : post.get(payer) ?? null;
        if (payerAccount !== null && fee > 0n && payerAccount.lamports >= fee) payerAccount.lamports -= fee;
        if (hooks.mutate !== undefined) hooks.mutate(post);
      }

      const accounts: Array<RawSimulatedAccount | null> = addresses.map((a) => {
        const s = post.get(a) ?? null;
        return s === null
          ? null
          : { lamports: Number(s.lamports), owner: s.owner, executable: s.executable, dataBase64: s.data.toString("base64") };
      });
      return {
        err: hooks.fail !== undefined ? hooks.fail : overflow ? { InstructionError: [0, "ArithmeticOverflow"] } : null,
        logs: hooks.logs !== undefined ? hooks.logs : ["Program log: ok"],
        unitsConsumed: hooks.unitsConsumed !== undefined ? hooks.unitsConsumed : 4321,
        accounts: hooks.omitAccounts ? null : hooks.shortAccounts ? accounts.slice(0, -1) : accounts,
      };
    },
  };
}
