use anchor_lang::prelude::*;

/// A scoped, revocable spending mandate that a human sponsor issues to one agent.
///
/// This is a separate onchain authorization object. It never gives the agent
/// control of the sponsor's wallet; it only describes what the agent may spend.
///
/// PDA seeds: ["mandate", sponsor, mandate_id.to_le_bytes()]
///
/// All amounts are in base units of `usdc_mint` (for USDC with 6 decimals,
/// 1_000_000 = 1 USDC). All timestamps are unix seconds from the Clock sysvar.
#[account]
#[derive(InitSpace)]
pub struct AgentMandate {
    /// Human owner. Only this key may create, revoke or update the mandate.
    pub sponsor: Pubkey,
    /// The one key authorized to spend under this mandate.
    pub agent: Pubkey,
    /// Sponsor-chosen ID; part of the PDA seeds so one sponsor can hold many mandates.
    pub mandate_id: u64,
    /// The single token mint this mandate covers.
    pub usdc_mint: Pubkey,
    /// Maximum amount for any single transaction.
    pub max_per_tx: u64,
    /// Maximum lifetime spend under this mandate.
    pub max_total: u64,
    /// Running total already spent. Only ever increased, using checked math.
    pub total_spent: u64,
    /// Maximum spend per day bucket.
    pub daily_cap: u64,
    /// Amount spent in the day bucket recorded in `current_day`.
    pub daily_spent: u64,
    /// Day bucket (unix_timestamp / 86_400) of the last recorded spend.
    /// When the bucket changes, `daily_spent` resets to zero.
    pub current_day: i64,
    /// Unix timestamp after which the mandate can no longer be used.
    pub expires_at: i64,
    /// Kill switch. Once true, the mandate can never be used again.
    pub revoked: bool,
    /// Wallets the agent may pay. Capped at 5 for the MVP; the account is
    /// allocated at full size, so there is no reallocation to get wrong.
    #[max_len(5)]
    pub allowed_recipients: Vec<Pubkey>,
    pub created_at: i64,
    pub updated_at: i64,
    pub bump: u8,
}

#[cfg(test)]
mod tests {
    use super::*;

    // sponsor 32 + agent 32 + mandate_id 8 + usdc_mint 32 + max_per_tx 8 + max_total 8
    // + total_spent 8 + daily_cap 8 + daily_spent 8 + current_day 8 + expires_at 8
    // + revoked 1 + vec (4 + 5 * 32) + created_at 8 + updated_at 8 + bump 1 = 342
    #[test]
    fn agent_mandate_space_is_342_bytes() {
        assert_eq!(AgentMandate::INIT_SPACE, 342);
    }
}
