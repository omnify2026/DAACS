use serde::de::DeserializeOwned;
use serde::Serialize;
use std::fs;
use std::io;
use std::path::Path;

pub fn json_from_str<T: DeserializeOwned>(s: &str) -> Result<T, serde_json::Error> {
    serde_json::from_str(s)
}

pub fn json_to_string<T: Serialize>(value: &T) -> Result<String, serde_json::Error> {
    serde_json::to_string(value)
}

pub fn json_to_string_pretty<T: Serialize>(value: &T) -> Result<String, serde_json::Error> {
    serde_json::to_string_pretty(value)
}

pub fn json_from_file<P: AsRef<Path>, T: DeserializeOwned>(path: P) -> Result<T, JsonFileError> {
    let contents = fs::read_to_string(path.as_ref()).map_err(JsonFileError::Io)?;
    serde_json::from_str(&contents).map_err(JsonFileError::Parse)
}

pub fn json_to_file<P: AsRef<Path>, T: Serialize>(path: P, value: &T) -> Result<(), JsonFileError> {
    let contents = serde_json::to_string_pretty(value).map_err(JsonFileError::Parse)?;
    fs::write(path.as_ref(), contents).map_err(JsonFileError::Io)
}

pub fn try_json_from_str<T: DeserializeOwned>(s: &str) -> Option<T> {
    json_from_str(s).ok()
}

pub fn try_json_from_file<P: AsRef<Path>, T: DeserializeOwned>(path: P) -> Option<T> {
    json_from_file(path).ok()
}

#[derive(Debug)]
pub enum JsonFileError {
    Io(io::Error),
    Parse(serde_json::Error),
}

impl std::fmt::Display for JsonFileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JsonFileError::Io(e) => write!(f, "IO error: {}", e),
            JsonFileError::Parse(e) => write!(f, "JSON parse error: {}", e),
        }
    }
}

impl std::error::Error for JsonFileError {}
