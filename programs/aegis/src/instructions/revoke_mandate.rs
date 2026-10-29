use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, state::AgentMandate};

#[derive(Accounts)]
pub struct RevokeMandate<'info> {
    /// Must be the sponsor stored in the mandate (enforced by has_one below).
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
/// TODO (Milestone 2C): set revoked = true, update updated_at from Clock,
/// emit MandateRevoked. Revocation is irreversible in this MVP.
pub fn handle_revoke_mandate(_ctx: Context<RevokeMandate>) -> Result<()> {
    err!(ErrorCode::NotImplemented)
}
