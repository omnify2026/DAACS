mod loader;
mod flatten;

pub use loader::{Localizer, LocalizerError};
pub use flatten::flatten_json_to_string_map;
