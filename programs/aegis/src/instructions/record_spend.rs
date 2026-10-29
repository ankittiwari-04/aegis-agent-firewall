use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, state::AgentMandate};

#[derive(Accounts)]
pub struct RecordSpend<'info> {
    /// MVP: only the sponsor may record spend. Agent-signed authorization comes later.
    pub sponsor: Signer<'info>,

    #[account(
        mut,
        seeds = [MANDATE_SEED, mandate.sponsor.as_ref(), &mandate.mandate_id.to_le_bytes()],
        bump = mandate.bump,
        has_one = sponsor @ ErrorCode::Unauthorized
    )]
    pub mandate: Account<'info, AgentMandate>,
}

/// Milestone 2A scaffold: fails closed on purpose.
/// TODO (Milestone 2D): reject if revoked or expired, amount == 0, amount > max_per_tx,
/// or total_spent + amount > max_total (use checked_add, map failure to MathOverflow);
/// update total_spent and updated_at; emit SpendRecorded.
pub fn handle_record_spend(_ctx: Context<RecordSpend>, _amount: u64) -> Result<()> {
    err!(ErrorCode::NotImplemented)
}
