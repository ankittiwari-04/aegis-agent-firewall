use anchor_lang::prelude::*;

/// PDA seed prefix. Full seeds: ["mandate", sponsor pubkey, mandate_id as u64 little-endian bytes].
#[constant]
pub const MANDATE_SEED: &[u8] = b"mandate";

/// Maximum number of allowed recipient wallets per mandate.
/// Must match #[max_len(..)] on AgentMandate.allowed_recipients in state.rs.
pub const MAX_ALLOWED_RECIPIENTS: usize = 5;

/// Used to compute the current "day" bucket for the daily cap: unix_timestamp / SECONDS_PER_DAY.
pub const SECONDS_PER_DAY: i64 = 86_400;
