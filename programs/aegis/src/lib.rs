pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use events::*;
pub use instructions::*;
pub use state::*;

declare_id!("5RiVTk3kzfvz1pn9NiMDjaR1x6Vom565W9pFzNwVK5Bp");

#[program]
pub mod aegis {
    use super::*;

    pub fn initialize_mandate(
        ctx: Context<InitializeMandate>,
        params: InitializeMandateParams,
    ) -> Result<()> {
        crate::instructions::initialize_mandate::handle_initialize_mandate(ctx, params)
    }

    pub fn revoke_mandate(ctx: Context<RevokeMandate>) -> Result<()> {
        crate::instructions::revoke_mandate::handle_revoke_mandate(ctx)
    }

    pub fn record_spend(ctx: Context<RecordSpend>, amount: u64) -> Result<()> {
        crate::instructions::record_spend::handle_record_spend(ctx, amount)
    }
}
