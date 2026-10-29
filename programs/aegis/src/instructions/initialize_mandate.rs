use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, events::MandateCreated, state::AgentMandate};

/// Arguments for creating a mandate. All amounts are in base units of the mint.
/// The agent and the mint are passed as accounts, not arguments.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeMandateParams {
    pub mandate_id: u64,
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

    /// CHECK: Only the public key is read and stored. The agent does not need to sign
    /// or exist onchain; it is validated in the handler (not default, not the sponsor).
    pub agent: UncheckedAccount<'info>,

    /// CHECK: Only the public key is read and stored. It is NOT verified to be an SPL
    /// mint in this milestone (TODO: validate with anchor-spl in a later phase).
    pub usdc_mint: UncheckedAccount<'info>,

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

pub fn handle_initialize_mandate(
    ctx: Context<InitializeMandate>,
    params: InitializeMandateParams,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let sponsor_key = ctx.accounts.sponsor.key();
    let agent_key = ctx.accounts.agent.key();
    let mint_key = ctx.accounts.usdc_mint.key();

    // --- Validate everything before writing any state ---
    require!(params.expires_at > now, ErrorCode::InvalidExpiry);
    require!(params.max_per_tx > 0, ErrorCode::InvalidPerTransactionLimit);
    require!(params.max_total > 0, ErrorCode::InvalidTotalSpendLimit);
    require!(
        params.max_per_tx <= params.max_total,
        ErrorCode::PerTransactionLimitExceedsTotalLimit
    );
    require!(params.daily_cap > 0, ErrorCode::InvalidDailyCap);
    require!(
        agent_key != Pubkey::default() && agent_key != sponsor_key,
        ErrorCode::InvalidAgent
    );
    require!(mint_key != Pubkey::default(), ErrorCode::InvalidMint);

    // Allowlist: bounded length first, then no zero addresses, no duplicates.
    // An empty allowlist is allowed; it simply means no recipient is permitted.
    require!(
        params.allowed_recipients.len() <= MAX_ALLOWED_RECIPIENTS,
        ErrorCode::TooManyRecipients
    );
    for (i, recipient) in params.allowed_recipients.iter().enumerate() {
        require!(*recipient != Pubkey::default(), ErrorCode::InvalidRecipient);
        require!(
            !params.allowed_recipients[..i].contains(recipient),
            ErrorCode::InvalidRecipient
        );
    }

    // --- Write state ---
    let mandate_key = ctx.accounts.mandate.key();
    let bump = ctx.bumps.mandate;
    let mandate = &mut ctx.accounts.mandate;

    mandate.sponsor = sponsor_key;
    mandate.agent = agent_key;
    mandate.mandate_id = params.mandate_id;
    mandate.usdc_mint = mint_key;
    mandate.max_per_tx = params.max_per_tx;
    mandate.max_total = params.max_total;
    mandate.total_spent = 0;
    mandate.daily_cap = params.daily_cap;
    mandate.daily_spent = 0;
    mandate.current_day = now / SECONDS_PER_DAY;
    mandate.expires_at = params.expires_at;
    mandate.revoked = false;
    mandate.allowed_recipients = params.allowed_recipients;
    mandate.created_at = now;
    mandate.updated_at = now;
    mandate.bump = bump;

    emit!(MandateCreated {
        mandate: mandate_key,
        sponsor: sponsor_key,
        agent: agent_key,
        usdc_mint: mint_key,
        mandate_id: params.mandate_id,
        max_per_tx: params.max_per_tx,
        max_total: params.max_total,
        daily_cap: params.daily_cap,
        expires_at: params.expires_at,
        created_at: now,
    });

    Ok(())
}
