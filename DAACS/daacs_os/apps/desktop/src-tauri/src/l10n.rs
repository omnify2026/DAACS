use omni_localization::Localizer;
use std::path::PathBuf;

fn l10n_base_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .to_path_buf()
}

fn localizer_with_culture(
    in_culture: &str,
) -> Result<Localizer, omni_localization::LocalizerError> {
    let base = l10n_base_path();
    Localizer::with_culture(&base, in_culture)
}

pub(crate) fn localized_text(in_key: &str, in_fallback: &str) -> String {
    let base = l10n_base_path();
    let mut localizer = Localizer::new(&base);
    if localizer.load_culture_with_fallback("ko", "en").is_ok() {
        return localizer.get(in_key).unwrap_or(in_fallback).to_string();
    }
    in_fallback.to_string()
}

#[tauri::command]
pub fn get_l10n(in_culture: String, in_key: String) -> Result<Option<String>, String> {
    let culture = in_culture.trim();
    let key = in_key.trim();
    if culture.is_empty() || key.is_empty() {
        return Ok(None);
    }
    let loc = localizer_with_culture(culture).map_err(|e| e.to_string())?;
    Ok(loc.try_get(key))
}
