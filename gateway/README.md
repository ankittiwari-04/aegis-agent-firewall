# Aegis gateway

Policy gateway that evaluates a serialized Solana transaction against an Aegis `AgentMandate` before it is submitted.

## Status

Milestone 3A: scaffold only. `evaluateTransaction` denies every transaction (it fails closed) until the policy engine lands in Milestone 3D. Mandate loading (3B) and transaction decoding (3C) are not implemented yet.

## Security properties

- Never signs or submits transactions and holds no keys.
- Localnet and devnet only: any RPC host other than `127.0.0.1`, `localhost` or `api.devnet.solana.com` is rejected, as are credentials embedded in the URL.
- Fails closed: invalid configuration or input produces an error or a DENY decision, never an ALLOW.

## Configuration

- `AEGIS_RPC_URL`: defaults to `http://127.0.0.1:8899`
- `AEGIS_PROGRAM_ID`: defaults to the Aegis program id in `Anchor.toml`

## Scripts

Run these inside `gateway/`:

    npm run typecheck
    npm run build
    npm test
