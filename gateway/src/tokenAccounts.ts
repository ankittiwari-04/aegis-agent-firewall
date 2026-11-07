import { PublicKey } from "@solana/web3.js";

// Layouts follow the SPL Token program. Tests check every constant here against @solana/spl-token,
// which is a dev dependency only: the gateway has no runtime dependency on it.
export const TOKEN_ACCOUNT_SIZE = 165;
export const MULTISIG_SIZE = 355;
export const MINT_SIZE = 82;
export const ACCOUNT_STATE_INITIALIZED = 1;
/** Token-2022 accounts with extensions carry this marker byte right after the 165 base bytes. */
export const ACCOUNT_TYPE_ACCOUNT = 2;

const MINT_OFFSET = 0;
const OWNER_OFFSET = 32;
const STATE_OFFSET = 108;
const ACCOUNT_TYPE_OFFSET = 165;
const MINT_INITIALIZED_OFFSET = 45;

export interface ParsedTokenAccount {
  mint: string;
  owner: string;
}

/**
 * Returns the mint and owner of an initialized token account, or null for anything ambiguous.
 * Classic Token accounts must be exactly 165 bytes. With `allowExtensions` (Token-2022) a longer
 * account is accepted only if it carries the account-type marker. Multisig-sized data is always
 * rejected, and so are uninitialized and frozen accounts.
 */
export function parseTokenAccount(data: Uint8Array, allowExtensions: boolean): ParsedTokenAccount | null {
  const buf = Buffer.from(data);
  if (buf.length < TOKEN_ACCOUNT_SIZE || buf.length === MULTISIG_SIZE) return null;
  if (
    buf.length > TOKEN_ACCOUNT_SIZE &&
    (!allowExtensions || buf[ACCOUNT_TYPE_OFFSET] !== ACCOUNT_TYPE_ACCOUNT)
  ) {
    return null;
  }
  if (buf[STATE_OFFSET] !== ACCOUNT_STATE_INITIALIZED) return null;
  return {
    mint: new PublicKey(buf.subarray(MINT_OFFSET, MINT_OFFSET + 32)).toBase58(),
    owner: new PublicKey(buf.subarray(OWNER_OFFSET, OWNER_OFFSET + 32)).toBase58(),
  };
}

/** True for an initialized mint with no extensions (exactly the 82 base bytes). */
export function isPlainMint(data: Uint8Array): boolean {
  const buf = Buffer.from(data);
  return buf.length === MINT_SIZE && buf[MINT_INITIALIZED_OFFSET] === 1;
}
