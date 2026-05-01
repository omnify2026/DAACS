use omni_utilities::{file_exists, json_from_file};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::flatten::flatten_json_to_string_map;

const L10N_REL_PATH: &str = "Resources/L10N";
const L10N_FILE_NAME: &str = "L10N.json";

#[derive(Debug)]
pub enum LocalizerError {
    Path(String),
    Load(omni_utilities::JsonFileError),
}

impl std::fmt::Display for LocalizerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LocalizerError::Path(s) => write!(f, "path error: {}", s),
            LocalizerError::Load(e) => write!(f, "load error: {}", e),
        }
    }
}

impl std::error::Error for LocalizerError {}

pub struct Localizer {
    base_path: PathBuf,
    culture: String,
    fallback_culture: Option<String>,
    strings: HashMap<String, String>,
}

impl Localizer {
    pub fn new<P: AsRef<Path>>(base_path: P) -> Self {
        Self {
            base_path: base_path.as_ref().to_path_buf(),
            culture: String::new(),
            fallback_culture: None,
            strings: HashMap::new(),
        }
    }

    pub fn with_culture<P: AsRef<Path>>(base_path: P, culture: &str) -> Result<Self, LocalizerError> {
        let mut loc = Self::new(base_path);
        loc.load_culture(culture)?;
        loc.culture = culture.to_string();
        Ok(loc)
    }

    pub fn with_fallback(
        mut self,
        fallback_culture: &str,
    ) -> Result<Self, LocalizerError> {
        self.fallback_culture = Some(fallback_culture.to_string());
        if self.strings.is_empty() && !self.culture.is_empty() {
            let culture = self.culture.clone();
            self.load_culture(&culture)?;
        }
        Ok(self)
    }

    fn path_for_culture(&self, culture: &str) -> PathBuf {
        self.base_path
            .join(L10N_REL_PATH)
            .join(culture)
            .join(L10N_FILE_NAME)
    }

    pub fn load_culture(&mut self, culture: &str) -> Result<(), LocalizerError> {
        let path = self.path_for_culture(culture);
        if !file_exists(&path) {
            return Err(LocalizerError::Path(format!(
                "L10N file not found: {}",
                path.display()
            )));
        }
        let value: Value = json_from_file(&path).map_err(LocalizerError::Load)?;
        let flat = flatten_json_to_string_map(&value);
        for (k, v) in flat {
            self.strings.insert(k, v);
        }
        self.culture = culture.to_string();
        Ok(())
    }

    pub fn load_culture_with_fallback(
        &mut self,
        culture: &str,
        fallback_culture: &str,
    ) -> Result<(), LocalizerError> {
        self.fallback_culture = Some(fallback_culture.to_string());
        let fallback_path = self.path_for_culture(fallback_culture);
        if file_exists(&fallback_path) {
            let value: Value = json_from_file(&fallback_path).map_err(LocalizerError::Load)?;
            self.strings = flatten_json_to_string_map(&value);
        }
        let path = self.path_for_culture(culture);
        if file_exists(&path) {
            let value: Value = json_from_file(&path).map_err(LocalizerError::Load)?;
            let flat = flatten_json_to_string_map(&value);
            for (k, v) in flat {
                self.strings.insert(k, v);
            }
            self.culture = culture.to_string();
            Ok(())
        } else if !self.strings.is_empty() {
            self.culture = culture.to_string();
            Ok(())
        } else {
            Err(LocalizerError::Path(format!(
                "L10N file not found: {}",
                path.display()
            )))
        }
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.strings.get(key).map(|s| s.as_str())
    }

    pub fn try_get(&self, key: &str) -> Option<String> {
        self.strings.get(key).cloned()
    }

    pub fn culture(&self) -> &str {
        &self.culture
    }

    pub fn base_path(&self) -> &Path {
        &self.base_path
    }

    pub fn set_culture(&mut self, culture: &str) {
        self.culture = culture.to_string();
    }
}
