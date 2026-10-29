use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, state::AgentMandate};

/// Arguments for creating a mandate. All amounts are in base units of `usdc_mint`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeMandateParams {
    pub mandate_id: u64,
    pub agent: Pubkey,
    pub usdc_mint: Pubkey,
    pub max_per_tx: u64,
    pub max_total: u64,
    pub daily_cap: u64,
    pub expires_at: i64,
    pub allowed_recipients: Vec<Pubkey>,
}

#[derive(Accounts)]
#[instruction(params: InitializeMandateParams)]
pub struct InitializeMandate<'info> {
    /// The human sponsor. Must sign and pays rent. Because the sponsor's key is part
    /// of the PDA seeds, a mandate can only be created under the signer's own address.
    #[account(mut)]
    pub sponsor: Signer<'info>,

    #[account(
        init,
        payer = sponsor,
        space = 8 + AgentMandate::INIT_SPACE,
        seeds = [MANDATE_SEED, sponsor.key().as_ref(), &params.mandate_id.to_le_bytes()],
        bump
    )]
    pub mandate: Account<'info, AgentMandate>,

    pub system_program: Program<'info, System>,
}

/// Milestone 2A scaffold: fails closed on purpose.
/// TODO (Milestone 2B): validate expires_at is in the future, max_per_tx > 0,
/// max_total > 0, daily_cap > 0, max_per_tx <= max_total, allowlist length <= 5
/// with no duplicates or default pubkeys; fill every AgentMandate field
/// (total_spent = 0, daily_spent = 0, revoked = false, timestamps from Clock,
/// bump from ctx.bumps); emit MandateCreated.
pub fn handle_initialize_mandate(
    _ctx: Context<InitializeMandate>,
    _params: InitializeMandateParams,
) -> Result<()> {
    err!(ErrorCode::NotImplemented)
}
