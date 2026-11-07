import { SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import type { AccountFetcher, RawAccount } from "./mandate";

/** Clock sysvar: slot u64, epoch_start_timestamp i64, epoch u64, leader_schedule_epoch u64, unix_timestamp i64. */
export const CLOCK_SYSVAR_SIZE = 40;
const UNIX_TIMESTAMP_OFFSET = 32;

export class ClockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClockError";
  }
}

/**
 * Reads the chain's own clock (unix seconds). The chain clock is the source of truth for expiry:
 * it is what the program reads, and it can differ from the gateway machine's clock.
 * Throws ClockError on any problem, and callers must treat that as DENY.
 */
export async function readChainTime(fetchAccount: AccountFetcher): Promise<bigint> {
  let account: RawAccount | null;
  try {
    account = await fetchAccount(SYSVAR_CLOCK_PUBKEY);
  } catch {
    throw new ClockError("Failed to fetch the chain clock");
  }
  if (account === null || account === undefined) throw new ClockError("Chain clock account not found");
  const data = Buffer.from(account.data);
  if (data.length !== CLOCK_SYSVAR_SIZE) throw new ClockError("Unexpected chain clock size");
  const seconds = data.readBigInt64LE(UNIX_TIMESTAMP_OFFSET);
  if (seconds <= 0n) throw new ClockError("Invalid chain clock value");
  return seconds;
}
