use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Only the mandate sponsor can perform this action")]
    Unauthorized,
    #[msg("Mandate has been revoked")]
    MandateRevoked,
    #[msg("Mandate has expired")]
    MandateExpired,
    #[msg("Expiry must be in the future")]
    InvalidExpiry,
    #[msg("Spend amount must be greater than zero")]
    InvalidAmount,
    #[msg("Amount exceeds the per-transaction limit")]
    ExceedsPerTxLimit,
    #[msg("Amount exceeds the remaining total allowance")]
    ExceedsTotalLimit,
    #[msg("Amount exceeds the daily spending cap")]
    ExceedsDailyLimit,
    #[msg("Per-transaction limit must be greater than zero")]
    InvalidPerTransactionLimit,
    #[msg("Total spend limit must be greater than zero")]
    InvalidTotalSpendLimit,
    #[msg("Per-transaction limit cannot exceed the total spend limit")]
    PerTransactionLimitExceedsTotalLimit,
    #[msg("Daily cap must be greater than zero")]
    InvalidDailyCap,
    #[msg("Recipient is not on the mandate allowlist")]
    RecipientNotAllowed,
    #[msg("Too many allowed recipients")]
    TooManyRecipients,
    #[msg("Allowlist contains a duplicate or invalid recipient")]
    InvalidRecipient,
    #[msg("Agent must be a non-default key different from the sponsor")]
    InvalidAgent,
    #[msg("Mint must not be the default (all-zero) address")]
    InvalidMint,
    #[msg("Signer is not the agent authorized by this mandate")]
    AgentMismatch,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("This instruction is not implemented yet")]
    NotImplemented,
}
