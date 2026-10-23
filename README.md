# Aegis

**Aegis is a transaction firewall for autonomous AI agents on Solana.**

AI agents are beginning to hold wallets, pay for APIs, trade, and interact with onchain protocols. But a compromised or manipulated agent can turn a prompt injection into a financial exploit.

Aegis gives humans a way to issue scoped, revocable mandates to AI agents. Before an agent transaction is accepted, Aegis checks whether the action is authorized, within spending limits, and consistent with the user's intent.

## Why it matters

- Agents should not hold unrestricted wallet authority
- Every agent action should be policy-checked
- Spending should be limited, revocable, and auditable
- Security should be enforced before a transaction is submitted

## How it works (planned design)

1. A human sponsor creates a **mandate** onchain for a specific agent: spending limits, an expiry time, and a list of allowed recipients.
2. The agent proposes a transaction.
3. The Aegis gateway decodes the transaction and checks it against the mandate before anything is submitted.
4. The sponsor can revoke the mandate at any time.

Core design rule: the agent never receives control of the sponsor's wallet. The mandate is a separate onchain account that only describes what the agent is allowed to do.

## Current status

This repository is an early MVP focused on:

- Onchain agent mandates
- Spending limits
- Revocation and expiry
- A TypeScript policy gateway
- Test coverage for abuse scenarios

Aegis is **not audited** and runs on localnet only for now. Do not use it with real funds.

## Roadmap

- [x] Agent mandate data model
- [ ] Mandate lifecycle instructions
- [ ] Policy gateway
- [ ] Transaction simulation
- [ ] Risk rules
- [ ] Audit receipts
- [ ] Dashboard

## Repository layout

    programs/aegis/   Anchor program (onchain mandate logic)
    tests/            Anchor tests (TypeScript, Mocha)
    gateway/          TypeScript policy gateway (planned, Day 3)
    migrations/       Anchor deploy scripts
    app/              Reserved for a future dashboard

## Development

Toolchain used so far:

- Anchor CLI 1.2.0
- Solana CLI 3.1.10
- Rust 1.89.0 (pinned in rust-toolchain.toml)
- Node.js 24
- Surfpool 1.5.0 (local test backend)

Build the program:

    npm install
    anchor build

Run the Rust unit tests:

    RUSTFLAGS="" cargo test -p aegis --lib

The empty RUSTFLAGS is only needed if your global ~/.cargo/config.toml sets nightly-only compiler flags, which breaks stable builds.

## License

MIT. See LICENSE.
