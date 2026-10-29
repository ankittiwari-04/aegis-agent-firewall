use anchor_lang::prelude::*;

/// Emitted when a sponsor creates a new mandate.
#[event]
pub struct MandateCreated {
    pub mandate: Pubkey,
    pub sponsor: Pubkey,
    pub agent: Pubkey,
    pub usdc_mint: Pubkey,
    pub mandate_id: u64,
    pub max_per_tx: u64,
    pub max_total: u64,
    pub daily_cap: u64,
    pub expires_at: i64,
    pub created_at: i64,
}

/// Emitted when a sponsor permanently revokes a mandate.
#[event]
pub struct MandateRevoked {
    pub mandate: Pubkey,
    pub sponsor: Pubkey,
    pub agent: Pubkey,
    pub mandate_id: u64,
    pub revoked_at: i64,
}

/// Emitted when a spend is recorded against a mandate.
#[event]
pub struct SpendRecorded {
    pub mandate: Pubkey,
    pub sponsor: Pubkey,
    pub agent: Pubkey,
    pub mandate_id: u64,
    pub amount: u64,
    /// Running total after this spend was added.
    pub total_spent: u64,
    pub recorded_at: i64,
}
