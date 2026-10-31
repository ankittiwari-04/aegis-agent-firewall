# Aegis gateway

Policy gateway that evaluates a serialized Solana transaction against an Aegis `AgentMandate` before it is submitted.

## Status

- 3A (done): scaffold, config validation, health check.
- 3B (done): mandate loader (`loadMandate`) and `getMandateStatus`.
- 3C (next): transaction decoder. 3D: policy engine. Until 3D, `evaluateTransaction` denies everything.

## Security properties

- Never signs or submits transactions and holds no keys.
- Localnet and devnet only: any RPC host other than `127.0.0.1`, `localhost` or `api.devnet.solana.com` is rejected, as are credentials embedded in the URL.
- Fails closed: invalid configuration or input produces an error or a DENY decision, never an ALLOW. Any throw from the mandate loader must be treated as DENY.

## Mandate loader

`loadMandate(address)` returns a normalized mandate (amounts are `bigint`) or throws a `MandateLoadError` with one of these codes:

- `INVALID_ADDRESS`: not a canonical base58 public key (rejected before any network call)
- `NOT_FOUND`: the account does not exist
- `RPC_ERROR`: the fetch failed (the underlying error is dropped so URLs cannot leak)
- `WRONG_OWNER`: not owned by the Aegis program (blocks lookalike accounts from other programs)
- `MALFORMED_DATA`: wrong size, discriminator, layout, padding or flag byte
- `PDA_MISMATCH`: the address is not the PDA derived from the stored sponsor, mandate id and canonical bump
- `CORRUPT_STATE`: values the program could never have written (for example `totalSpent > maxTotalSpend`)

`getMandateStatus(mandate, nowSeconds)` returns `REVOKED`, `EXPIRED` or `ACTIVE`. Revoked wins over expired, and expired means `now >= expiry`. The loader reads no clock: the chain Clock sysvar is wired in with the policy engine in 3D.

The IDL is committed at `src/idl/aegis.json` because `target/` is gitignored. After changing the program, run `anchor build` at the repo root and then `npm run sync-idl` here. A test fails if the copy goes stale.

## Known limitations

- No live-chain test yet: the loader is tested on byte-exact accounts, not on an account read from a running validator. This also means the assumed account size of 350 bytes (8 + 342, from the Rust unit test) has not been read off a real account. Both are planned for 3D.
- Reads use `confirmed` commitment. A revocation or spend that has not reached `confirmed` is invisible to the gateway, so there is a window between the check and the transaction landing. The program's own checks remain the final authority.
- The recipient allowlist and the daily cap are stored onchain but not enforced by the program. The gateway does not expose the daily cap fields.

## Configuration

- `AEGIS_RPC_URL`: defaults to `http://127.0.0.1:8899`
- `AEGIS_PROGRAM_ID`: defaults to the Aegis program id in `Anchor.toml`

## Scripts

Run these inside `gateway/`:

    npm run typecheck
    npm run build
    npm test
    npm run sync-idl
