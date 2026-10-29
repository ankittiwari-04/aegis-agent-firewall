use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, events::SpendRecorded, state::AgentMandate};

#[derive(Accounts)]
pub struct RecordSpend<'info> {
    /// MVP LIMITATION: only the sponsor may record spend. The agent does not sign
    /// anything yet, so this instruction is a ledger entry, not enforcement against
    /// the agent. Agent-signed authorization (has_one = agent), recipient checks and
    /// real token movement are added in a later milestone.
    pub sponsor: Signer<'info>,

    #[account(
        mut,
        seeds = [MANDATE_SEED, mandate.sponsor.as_ref(), &mandate.mandate_id.to_le_bytes()],
        bump = mandate.bump,
        has_one = sponsor @ ErrorCode::Unauthorized
    )]
    pub mandate: Account<'info, AgentMandate>,
}

/// Records an authorized spend against a mandate.
///
/// NOT enforced yet (documented limitations):
/// - the recipient allowlist (this instruction takes no recipient),
/// - the daily cap (daily_cap / daily_spent / current_day are not read or written).
///
/// All validation happens before any state is modified, so a failure changes nothing.
pub fn handle_record_spend(ctx: Context<RecordSpend>, amount: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let mandate_key = ctx.accounts.mandate.key();
    let mandate = &mut ctx.accounts.mandate;

    // 1. (Sponsor check already enforced by has_one in the accounts struct.)
    // 2. Revoked mandates can never be used, whatever else is true.
    require!(!mandate.revoked, ErrorCode::MandateRevoked);
    // 3. Valid strictly before expires_at; at or after it, the mandate is expired.
    require!(now < mandate.expires_at, ErrorCode::MandateExpired);
    // 4. Zero-amount spends are meaningless and rejected.
    require!(amount > 0, ErrorCode::InvalidAmount);
    // 5. Per-transaction cap (plain comparison, no arithmetic).
    require!(amount <= mandate.max_per_tx, ErrorCode::ExceedsPerTxLimit);

    // 6. Total cap, computed without any addition that could wrap:
    //    compare against the remaining allowance instead of checking total_spent + amount.
    let remaining = mandate
        .max_total
        .checked_sub(mandate.total_spent)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(amount <= remaining, ErrorCode::ExceedsTotalLimit);

    // 7. Update state. checked_add cannot fail after the check above; it is kept so
    //    safety does not depend on that check staying in place.
    let new_total = mandate
        .total_spent
        .checked_add(amount)
        .ok_or(ErrorCode::MathOverflow)?;
    mandate.total_spent = new_total;
    // 8.
    mandate.updated_at = now;

    // 9.
    emit!(SpendRecorded {
        mandate: mandate_key,
        sponsor: mandate.sponsor,
        agent: mandate.agent,
        mandate_id: mandate.mandate_id,
        amount,
        total_spent: new_total,
        recorded_at: now,
    });

    Ok(())
}
