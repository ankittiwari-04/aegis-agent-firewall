pub mod constants;
pub mod error;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use state::*;

declare_id!("5RiVTk3kzfvz1pn9NiMDjaR1x6Vom565W9pFzNwVK5Bp");

// Milestone 1 defines the data model only. Instructions (initialize_mandate,
// revoke_mandate, record_spend) are added in Milestone 2.
#[program]
pub mod aegis {}
