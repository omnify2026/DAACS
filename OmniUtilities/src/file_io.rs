use std::fs;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU8, Ordering};

const ENC_UTF8: u8 = 0;
const ENC_UTF16_LE: u8 = 1;
const ENC_UTF16_BE: u8 = 2;

static DEFAULT_STRING_ENCODING: AtomicU8 = AtomicU8::new(ENC_UTF16_LE);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StringEncoding {
    Utf8,
    Utf16Le,
    Utf16Be,
}

impl StringEncoding {
    fn to_u8(self) -> u8 {
        match self {
            StringEncoding::Utf8 => ENC_UTF8,
            StringEncoding::Utf16Le => ENC_UTF16_LE,
            StringEncoding::Utf16Be => ENC_UTF16_BE,
        }
    }
    fn from_u8(v: u8) -> Self {
        match v {
            ENC_UTF8 => StringEncoding::Utf8,
            ENC_UTF16_LE => StringEncoding::Utf16Le,
            ENC_UTF16_BE => StringEncoding::Utf16Be,
            _ => StringEncoding::Utf16Le,
        }
    }
}

pub fn set_default_string_encoding(encoding: StringEncoding) {
    DEFAULT_STRING_ENCODING.store(encoding.to_u8(), Ordering::SeqCst);
}

pub fn default_string_encoding() -> StringEncoding {
    StringEncoding::from_u8(DEFAULT_STRING_ENCODING.load(Ordering::SeqCst))
}

fn decode_bytes_to_string(bytes: &[u8], encoding: StringEncoding) -> Result<String, io::Error> {
    match encoding {
        StringEncoding::Utf8 => {
            String::from_utf8(bytes.to_vec()).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
        }
        StringEncoding::Utf16Le => {
            let mut start = 0;
            if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
                start = 2;
            }
            if (bytes.len() - start) % 2 != 0 {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "UTF-16LE invalid length"));
            }
            let u16_slice: Vec<u16> = (start..bytes.len())
                .step_by(2)
                .map(|i| u16::from_le_bytes([bytes[i], bytes[i + 1]]))
                .collect();
            char::decode_utf16(u16_slice.into_iter())
                .map(|r| r.map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid UTF-16")))
                .collect::<Result<String, _>>()
        }
        StringEncoding::Utf16Be => {
            let mut start = 0;
            if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
                start = 2;
            }
            if (bytes.len() - start) % 2 != 0 {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "UTF-16BE invalid length"));
            }
            let u16_slice: Vec<u16> = (start..bytes.len())
                .step_by(2)
                .map(|i| u16::from_be_bytes([bytes[i], bytes[i + 1]]))
                .collect();
            char::decode_utf16(u16_slice.into_iter())
                .map(|r| r.map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid UTF-16")))
                .collect::<Result<String, _>>()
        }
    }
}

fn encode_string_to_bytes(s: &str, encoding: StringEncoding) -> Vec<u8> {
    match encoding {
        StringEncoding::Utf8 => s.as_bytes().to_vec(),
        StringEncoding::Utf16Le => {
            let mut out = vec![0xFF, 0xFE];
            for u in s.encode_utf16() {
                out.extend_from_slice(&u.to_le_bytes());
            }
            out
        }
        StringEncoding::Utf16Be => {
            let mut out = vec![0xFE, 0xFF];
            for u in s.encode_utf16() {
                out.extend_from_slice(&u.to_be_bytes());
            }
            out
        }
    }
}

pub fn read_file_to_string<P: AsRef<Path>>(path: P) -> io::Result<String> {
    read_file_to_string_with_encoding(path, default_string_encoding())
}

pub fn read_file_to_string_with_encoding<P: AsRef<Path>>(
    path: P,
    encoding: StringEncoding,
) -> io::Result<String> {
    let bytes = fs::read(path)?;
    decode_bytes_to_string(&bytes, encoding)
}

pub fn write_string_to_file<P: AsRef<Path>>(path: P, contents: &str) -> io::Result<()> {
    write_string_to_file_with_encoding(path, contents, default_string_encoding())
}

pub fn write_string_to_file_with_encoding<P: AsRef<Path>>(
    path: P,
    contents: &str,
    encoding: StringEncoding,
) -> io::Result<()> {
    let bytes = encode_string_to_bytes(contents, encoding);
    fs::write(path, bytes)
}

pub fn read_file_to_bytes<P: AsRef<Path>>(path: P) -> io::Result<Vec<u8>> {
    fs::read(path)
}

pub fn write_bytes_to_file<P: AsRef<Path>>(path: P, contents: &[u8]) -> io::Result<()> {
    fs::write(path, contents)
}

pub fn try_read_file_to_string<P: AsRef<Path>>(path: P) -> Option<String> {
    read_file_to_string(path).ok()
}

pub fn try_read_file_to_string_with_encoding<P: AsRef<Path>>(
    path: P,
    encoding: StringEncoding,
) -> Option<String> {
    read_file_to_string_with_encoding(path, encoding).ok()
}

pub fn try_read_file_to_bytes<P: AsRef<Path>>(path: P) -> Option<Vec<u8>> {
    read_file_to_bytes(path).ok()
}

pub fn ensure_dir_all<P: AsRef<Path>>(path: P) -> io::Result<()> {
    fs::create_dir_all(path)
}

pub fn file_exists<P: AsRef<Path>>(path: P) -> bool {
    path.as_ref().exists()
}

pub fn is_file<P: AsRef<Path>>(path: P) -> bool {
    path.as_ref().is_file()
}
