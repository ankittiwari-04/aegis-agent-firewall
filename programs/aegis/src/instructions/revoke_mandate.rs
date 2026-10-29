use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, events::MandateRevoked, state::AgentMandate};

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

/// Permanently revokes a mandate. There is intentionally no way to undo this:
/// nothing in the program ever sets `revoked` back to false, and the account is
/// never closed, so it stays onchain as an audit record.
pub fn handle_revoke_mandate(ctx: Context<RevokeMandate>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let mandate_key = ctx.accounts.mandate.key();
    let mandate = &mut ctx.accounts.mandate;

    // A repeat revoke fails instead of silently overwriting the original updated_at.
    require!(!mandate.revoked, ErrorCode::MandateRevoked);

    mandate.revoked = true;
    mandate.updated_at = now;

    emit!(MandateRevoked {
        mandate: mandate_key,
        sponsor: mandate.sponsor,
        agent: mandate.agent,
        mandate_id: mandate.mandate_id,
        revoked_at: now,
    });

    Ok(())
}
