use anchor_lang::prelude::*;

// These errors are used by the mandate instructions added in Milestone 2.
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
    #[msg("Limits are invalid: all caps must be greater than zero and per-tx cannot exceed total")]
    InvalidLimits,
    #[msg("Recipient is not on the mandate allowlist")]
    RecipientNotAllowed,
    #[msg("Too many allowed recipients")]
    TooManyRecipients,
    #[msg("Allowlist contains a duplicate or invalid recipient")]
    InvalidRecipient,
    #[msg("Signer is not the agent authorized by this mandate")]
    AgentMismatch,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
