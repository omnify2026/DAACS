use reqwest::Client;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tokio::time::sleep;

const LOCAL_MODEL_PATH_ENV_KEYS: [&str; 2] =
    ["DAACS_LOCAL_LLM_MODEL_PATH", "OMNI_LOCAL_LLM_MODEL_PATH"];
const LOCAL_MODEL_DIR_ENV_KEYS: [&str; 2] =
    ["DAACS_LOCAL_LLM_MODEL_DIR", "OMNI_LOCAL_LLM_MODEL_DIR"];
const MODEL_DISCOVERY_MAX_DEPTH: usize = 6;
const MIN_DISCOVERED_MODEL_BYTES: u64 = 64 * 1024 * 1024;
const MLX_IMPORT_CHECK_SCRIPT: &str = r#"
try:
    import mlx_vlm
except ImportError:
    import mlx_lm
"#;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelCandidate {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub size_bytes: u64,
}

pub fn get_llama_cli() -> Option<PathBuf> {
    if let Some(p) = env_var("DAACS_LLAMA_CLI_PATH") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }

    let home = env_var("HOME").unwrap_or_else(|| "/Users/david".to_string());
    let fallbacks = [
        PathBuf::from(&home)
            .join("Desktop/python/github/AI-summary/llama_build/llama.cpp/build/bin/llama-cli"),
        PathBuf::from(&home)
            .join("Desktop/python/github/AI-summary/models/llama.cpp/build_metal/bin/llama-cli"),
        PathBuf::from(&home)
            .join("Desktop/python/github/AI-summary/models/llama.cpp/build_cpu/bin/llama-cli"),
        PathBuf::from("/opt/homebrew/bin/llama-cli"),
    ];

    for f in fallbacks {
        if f.exists() {
            return Some(f);
        }
    }
    None
}

pub fn get_llama_server() -> Option<PathBuf> {
    if let Some(p) = env_var("DAACS_LLAMA_SERVER_PATH") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }

    let home = env_var("HOME").unwrap_or_else(|| "/Users/david".to_string());
    let fallbacks = [
        PathBuf::from(&home)
            .join("Desktop/python/github/AI-summary/llama_build/llama.cpp/build/bin/llama-server"),
        PathBuf::from(&home)
            .join("Desktop/python/github/AI-summary/models/llama.cpp/build_metal/bin/llama-server"),
        PathBuf::from(&home)
            .join("Desktop/python/github/AI-summary/models/llama.cpp/build_cpu/bin/llama-server"),
        PathBuf::from("/opt/homebrew/bin/llama-server"),
    ];

    for f in fallbacks {
        if f.exists() {
            return Some(f);
        }
    }
    None
}

fn env_var(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn get_python_bin() -> String {
    if let Some(path) = env_var("DAACS_MLX_PYTHON") {
        return path;
    }
    let mut candidates = vec![PathBuf::from("python3")];
    candidates.extend(discover_unsloth_python_bins());
    for candidate in candidates {
        if python_supports_mlx(&candidate) {
            return candidate.to_string_lossy().into_owned();
        }
    }
    "python3".to_string()
}

fn discover_unsloth_python_bins() -> Vec<PathBuf> {
    if let Some(home) = env_var("HOME") {
        let root = PathBuf::from(home).join(".unsloth");
        let Some(entries) = fs::read_dir(root).ok() else {
            return Vec::new();
        };
        let mut dirs = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect::<Vec<_>>();
        dirs.sort();
        return dirs
            .into_iter()
            .map(|dir| dir.join("bin").join("python3"))
            .filter(|python| python.exists())
            .collect();
    }
    Vec::new()
}

fn python_supports_mlx(python: &Path) -> bool {
    Command::new(python)
        .arg("-c")
        .arg(MLX_IMPORT_CHECK_SCRIPT)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn validate_model_path(path: PathBuf, source: &str) -> Result<PathBuf, String> {
    if !path.exists() {
        eprintln!(
            "⚠️ [local_llm] Note: Path from {} at {} does not exist as a local file. Assuming it's an Ollama identifier or HF repo ID.",
            source,
            path.to_string_lossy()
        );
    }
    Ok(path)
}

fn candidate_model_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for key in LOCAL_MODEL_DIR_ENV_KEYS {
        if let Some(path) = env_var(key) {
            roots.push(PathBuf::from(path));
        }
    }

    if let Some(home) = env_var("HOME") {
        let home = PathBuf::from(home);
        roots.extend([
            home.join(".local-os-agent").join("models"),
            home.join("Library").join("Caches").join("llama.cpp"),
            home.join("Models"),
            home.join("models"),
            home.join(".cache").join("lm-studio").join("models"),
            home.join(".lmstudio").join("models"),
            home.join(".cache").join("huggingface").join("hub"),
            home.join("Desktop")
                .join("python")
                .join("github")
                .join("AI-summary")
                .join("models"),
            home.join("Desktop")
                .join("python")
                .join("github")
                .join("AI-summary")
                .join("llama_build")
                .join("llama.cpp")
                .join("models"),
        ]);
    }
    roots
}

fn is_probable_model_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let lower = name.to_ascii_lowercase();
    if lower.contains("vocab") || lower.contains("tokenizer") {
        return false;
    }
    let Some(ext) = path.extension().and_then(|ext| ext.to_str()) else {
        return false;
    };
    let extension = ext.to_ascii_lowercase();
    if !matches!(extension.as_str(), "gguf" | "bin" | "safetensors") {
        return false;
    }
    if matches!(extension.as_str(), "bin" | "safetensors") && is_huggingface_model_cache_path(path)
    {
        return false;
    }
    fs::metadata(path)
        .map(|metadata| metadata.len() >= MIN_DISCOVERED_MODEL_BYTES)
        .unwrap_or(false)
}

fn is_probable_model_weight_file(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|ext| ext.to_str()) else {
        return false;
    };
    let extension = ext.to_ascii_lowercase();
    if !matches!(extension.as_str(), "gguf" | "bin" | "safetensors") {
        return false;
    }
    fs::metadata(path)
        .map(|metadata| metadata.len() >= MIN_DISCOVERED_MODEL_BYTES)
        .unwrap_or(false)
}

fn is_huggingface_model_cache_path(path: &Path) -> bool {
    path.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .map(|part| part.starts_with("models--"))
            .unwrap_or(false)
    })
}

fn huggingface_repo_label(path: &Path) -> Option<String> {
    path.components().find_map(|component| {
        let part = component.as_os_str().to_str()?;
        let repo = part.strip_prefix("models--")?;
        let label = repo.replace("--", "/");
        (!label.trim().is_empty()).then_some(label)
    })
}

fn is_probable_model_dir(path: &Path) -> bool {
    if !path.join("config.json").is_file() || !model_config_looks_like_local_llm(path) {
        return false;
    }
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .any(|entry| is_probable_model_weight_file(&entry))
}

fn json_string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn json_string_array_field(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|entry| entry.to_ascii_lowercase())
        .collect()
}

fn model_config_looks_like_local_llm(path: &Path) -> bool {
    let Ok(raw) = fs::read_to_string(path.join("config.json")) else {
        return false;
    };
    let Ok(config) = serde_json::from_str::<Value>(&raw) else {
        return false;
    };

    let model_type = json_string_field(&config, "model_type")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let architectures = json_string_array_field(&config, "architectures");
    let architecture_text = architectures.join(" ");
    let config_text = format!("{model_type} {architecture_text}");

    let non_chat_markers = [
        "bert",
        "blip",
        "clip",
        "classification",
        "encoderdecoder",
        "e5",
        "embedding",
        "reranker",
        "roberta",
        "speech",
        "vision",
        "vit",
        "wav2vec",
        "whisper",
    ];
    if non_chat_markers
        .iter()
        .any(|marker| config_text.contains(marker))
    {
        return false;
    }

    if architecture_text.contains("causallm") {
        return true;
    }
    if architecture_text.contains("forconditionalgeneration") {
        return true;
    }

    let chat_model_markers = [
        "baichuan", "chatglm", "command", "deepseek", "falcon", "gemma", "gpt", "internlm",
        "llama", "mistral", "mixtral", "mpt", "olmo", "phi", "smollm", "stablelm", "t5", "yi",
    ];
    chat_model_markers
        .iter()
        .any(|marker| config_text.contains(marker))
}

fn auto_model_candidate_size(path: &Path) -> u64 {
    if path.is_file() {
        return fs::metadata(path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
    }
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|entry| is_probable_model_weight_file(entry))
        .filter_map(|entry| fs::metadata(entry).ok().map(|metadata| metadata.len()))
        .sum()
}

fn model_candidate_kind(path: &Path) -> String {
    if path.is_dir() {
        let lower = path.to_string_lossy().to_ascii_lowercase();
        if lower.contains("mlx") {
            return "mlx".to_string();
        }
        return "directory".to_string();
    }
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_else(|| "file".to_string())
}

fn model_candidate_name(path: &Path) -> String {
    if let Some(label) = huggingface_repo_label(path) {
        return label;
    }
    path.file_name()
        .and_then(|name| name.to_str())
        .map(ToOwned::to_owned)
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn model_candidate_identity(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

fn model_candidate_from_path(path: &Path) -> Option<LocalModelCandidate> {
    let size_bytes = auto_model_candidate_size(path);
    if size_bytes < MIN_DISCOVERED_MODEL_BYTES {
        return None;
    }
    Some(LocalModelCandidate {
        path: path.to_string_lossy().into_owned(),
        name: model_candidate_name(path),
        kind: model_candidate_kind(path),
        size_bytes,
    })
}

fn push_model_candidate(
    candidates: &mut Vec<LocalModelCandidate>,
    seen: &mut HashSet<String>,
    path: &Path,
) {
    let identity = model_candidate_identity(path);
    if !seen.insert(identity) {
        return;
    }
    if let Some(candidate) = model_candidate_from_path(path) {
        candidates.push(candidate);
    }
}

fn sort_model_candidates(candidates: &mut [LocalModelCandidate]) {
    candidates.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then_with(|| left.kind.cmp(&right.kind))
            .then_with(|| left.path.cmp(&right.path))
    });
}

fn dedupe_model_candidates_by_display_identity(candidates: &mut Vec<LocalModelCandidate>) {
    let mut seen = HashSet::new();
    candidates.retain(|candidate| {
        let identity = format!(
            "{}|{}|{}",
            candidate.name.to_ascii_lowercase(),
            candidate.kind,
            candidate.size_bytes
        );
        seen.insert(identity)
    });
}

pub fn list_local_model_candidates() -> Vec<LocalModelCandidate> {
    discover_model_candidates_from_roots(&candidate_model_roots())
}

fn discover_model_candidates_from_roots(roots: &[PathBuf]) -> Vec<LocalModelCandidate> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    for root in roots {
        discover_model_candidates_inner(root, 0, &mut candidates, &mut seen);
    }
    dedupe_model_candidates_by_display_identity(&mut candidates);
    sort_model_candidates(&mut candidates);
    candidates
}

fn discover_model_candidates_inner(
    path: &Path,
    depth: usize,
    candidates: &mut Vec<LocalModelCandidate>,
    seen: &mut HashSet<String>,
) {
    if depth > MODEL_DISCOVERY_MAX_DEPTH || !path.exists() {
        return;
    }
    if path.is_file() {
        if is_probable_model_file(path) {
            push_model_candidate(candidates, seen, path);
        }
        return;
    }
    if !path.is_dir() {
        return;
    }
    if path.join("config.json").is_file() && !model_config_looks_like_local_llm(path) {
        return;
    }
    if is_probable_model_dir(path) {
        push_model_candidate(candidates, seen, path);
        return;
    }

    let Ok(entries) = fs::read_dir(path) else {
        return;
    };
    let mut entries = entries.filter_map(Result::ok).collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.path());
    for entry in entries {
        discover_model_candidates_inner(&entry.path(), depth + 1, candidates, seen);
    }
}

pub fn resolve_model_path(custom_model_path: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(path) = custom_model_path {
        return validate_model_path(path.to_path_buf(), "selected path");
    }

    for key in LOCAL_MODEL_PATH_ENV_KEYS {
        if let Some(path) = env_var(key) {
            return validate_model_path(PathBuf::from(path), key);
        }
    }

    let candidates = list_local_model_candidates();
    if candidates.len() == 1 {
        return validate_model_path(PathBuf::from(&candidates[0].path), "auto discovery");
    }
    if candidates.len() > 1 {
        let names = candidates
            .iter()
            .take(5)
            .map(|candidate| candidate.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "Error: Multiple local LLM models were found ({}): {}. Choose one in DAACS Local LLM selector.",
            candidates.len(),
            names
        ));
    }

    Err(format!(
        "Error: Local LLM model file is not configured. Choose a model file in DAACS, set {}, or place a model under ~/.local-os-agent/models.",
        LOCAL_MODEL_PATH_ENV_KEYS[0]
    ))
}

#[cfg(target_os = "macos")]

pub fn has_mlx_lm() -> bool {
    let py_bin = get_python_bin();
    std::process::Command::new(py_bin)
        .arg("-c")
        .arg(MLX_IMPORT_CHECK_SCRIPT)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
pub fn has_mlx_lm() -> bool {
    false
}

#[cfg(target_os = "macos")]
fn run_mlx_sync(model_path: &Path, full_prompt: &str) -> std::io::Result<std::process::Output> {
    let script = r#"
import sys

try:
    import mlx_vlm
    from mlx_vlm import load, generate
    is_vlm = True
except ImportError:
    try:
        from mlx_lm import load, generate
        is_vlm = False
    except ImportError:
        sys.exit(17)

try:
    model, processor = load(sys.argv[1])
    # For verification/sync calls, we cap tokens to avoid long yapping during connection check
    response = generate(model, processor, prompt=sys.argv[2], max_tokens=20, verbose=False)
    print(response)
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(18)
"#;
    let py_bin = get_python_bin();
    println!("\n[OmniAICore] 로컬 LLM 모델을 로딩 중입니다... (약 30-60초 소요)");
    Command::new(py_bin)
        .arg("-c")
        .arg(script)
        .arg(model_path.to_string_lossy().as_ref())
        .arg(full_prompt)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .output()
}

#[cfg(not(target_os = "macos"))]
fn run_mlx_sync(_model_path: &Path, _full_prompt: &str) -> std::io::Result<std::process::Output> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Other,
        "MLX not supported",
    ))
}

pub fn generate_response(
    prompt: &str,
    system_prompt: &str,
    custom_model_path: Option<&Path>,
) -> String {
    let model_path = match resolve_model_path(custom_model_path) {
        Ok(path) => path,
        Err(error) => return error,
    };
    let model_path_str = model_path.to_string_lossy().into_owned();

    let mut full_prompt = format!(
        "<start_of_turn>user\n{}<end_of_turn>\n<start_of_turn>model\n",
        prompt
    );
    if !system_prompt.is_empty() {
        full_prompt = format!(
            "<start_of_turn>system\n{}<end_of_turn>\n{}",
            system_prompt, full_prompt
        );
    }

    if has_mlx_lm() {
        // model_path_str is passed directly to the python script
        if let Ok(out) = run_mlx_sync(Path::new(&model_path_str), &full_prompt) {
            println!("[OmniAICore] MLX 실행 종료. 상태: {}", out.status);
            let res = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if out.status.success() {
                println!("[OmniAICore] MLX 응답 성공 (길이: {})", res.len());
                if res.len() > 50 {
                    println!("[OmniAICore] 응답 일부: {}...", &res[0..50]);
                } else {
                    println!("[OmniAICore] 응답 결과: {}", res);
                }
                return res;
            } else {
                println!(
                    "[OmniAICore] MLX 실행 실패 (Exit Code: {})",
                    out.status.code().unwrap_or(-1)
                );
            }
        }
    }

    let cli_path = match get_llama_cli() {
        Some(p) => p,
        None => return "Error: Could not find llama-cli. Please ensure AI-summary project dependencies are built.".to_string(),
    };

    let output = Command::new(cli_path)
        .arg("-m")
        .arg(&model_path_str)
        .arg("-p")
        .arg(&full_prompt)
        .arg("-n")
        .arg("4096")
        .arg("--temp")
        .arg("0.2")
        .arg("-c")
        .arg("16384")
        .arg("--no-display-prompt")
        .arg("--simple-io")
        .arg("-no-cnv")
        .arg("--no-perf")
        .arg("-ngl")
        .arg("99")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();

    match output {
        Ok(out) => {
            if !out.status.success() {
                let err = String::from_utf8_lossy(&out.stderr);
                let err_lines: Vec<&str> = err.lines().collect();
                let snippet: Vec<&str> = err_lines.into_iter().rev().take(5).rev().collect();
                return format!(
                    "Error executing model (exit code {}): {}",
                    out.status.code().unwrap_or(-1),
                    snippet.join("\n")
                );
            }

            let stdout_str = String::from_utf8_lossy(&out.stdout);
            let lines: Vec<&str> = stdout_str
                .lines()
                .filter(|l| !l.contains("EOF") && !l.starts_with(">"))
                .collect();

            lines.join("\n").trim().to_string()
        }
        Err(e) => format!("Exception occurred: {}", e),
    }
}

pub fn generate_response_stream<F>(
    prompt: &str,
    system_prompt: &str,
    custom_model_path: Option<&Path>,
    mut callback: F,
) where
    F: FnMut(&str),
{
    let model_path = match resolve_model_path(custom_model_path) {
        Ok(path) => path,
        Err(error) => {
            callback(&error);
            return;
        }
    };
    let model_path_str = model_path.to_string_lossy().into_owned();

    let intelligence_instruction = concat!(
        "\nYou are a DAACS agent capable of interacting with the project filesystem.",
        "\nIf you need to create, modify, or delete files, you MUST use the [AGENT_COMMANDS] tag at the END of your response.",
        "\nFormat: [AGENT_COMMANDS] followed by valid shell commands (one per line).",
        "\nExample:",
        "\n'I will create the index.js file.'",
        "\n[AGENT_COMMANDS]",
        "\necho 'console.log(\"hello\");' > index.js",
        "\n\nAlways finish your conversational response before outputting the [AGENT_COMMANDS] block."
    );

    let full_system_prompt = format!("{}{}", system_prompt, intelligence_instruction);
    let full_prompt = format!(
        "<start_of_turn>system\n{}<end_of_turn>\n<start_of_turn>user\n{}<end_of_turn>\n<start_of_turn>model\n",
        full_system_prompt, prompt
    );

    let mut child_opt = None;

    if has_mlx_lm() {
        #[cfg(target_os = "macos")]
        {
            let script = r#"
import sys
try:
    import mlx_vlm
    from mlx_vlm import load, stream_generate
except ImportError:
    try:
        from mlx_lm import load, stream_generate
    except ImportError:
        sys.exit(17)

try:
    model, processor = load(sys.argv[1])
    for text in stream_generate(model, processor, prompt=sys.argv[2], max_tokens=4096):
        sys.stdout.write(text)
        sys.stdout.flush()
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(18)
"#;
            let py_bin = get_python_bin();
            println!("\n[OmniAICore] 로컬 LLM 모델 스트리밍 모드 로딩 중...");
            child_opt = Command::new(py_bin)
                .arg("-c")
                .arg(script)
                .arg(&model_path_str)
                .arg(&full_prompt)
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .ok();
        }
    }

    let mut child = if let Some(c) = child_opt {
        c
    } else {
        let cli_path = match get_llama_cli() {
            Some(p) => p,
            None => {
                callback("Error: Could not find llama-cli.");
                return;
            }
        };

        match Command::new(cli_path)
            .arg("-m")
            .arg(&model_path_str)
            .arg("-p")
            .arg(&full_prompt)
            .arg("-n")
            .arg("4096")
            .arg("--temp")
            .arg("0.2")
            .arg("-c")
            .arg("16384")
            .arg("--no-display-prompt")
            .arg("--simple-io")
            .arg("-no-cnv")
            .arg("--no-perf")
            .arg("-ngl")
            .arg("99")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                callback(&format!("\n[Error: {}]", e));
                return;
            }
        }
    };

    let mut stdout = if let Some(s) = child.stdout.take() {
        s
    } else {
        return;
    };

    let stop_patterns = [
        "[end of text]",
        "[endoftext]",
        "<end_of_turn>",
        "<eos>",
        "</s>",
        "[/inst]",
        "eof",
    ];

    let clean_buffer = |text: &str| -> String {
        let mut result = text.to_string();
        for &pattern in &stop_patterns {
            result = result.replace(pattern, "");
            result = result.replace(&pattern.to_lowercase(), "");
            result = result.replace(&pattern.to_uppercase(), "");
        }
        result
    };

    let mut buffer = String::new();
    let mut utf8_buf = Vec::new();
    let mut chunk = [0u8; 1];

    while let Ok(n) = stdout.read(&mut chunk) {
        if n == 0 {
            break;
        }
        utf8_buf.push(chunk[0]);

        let valid_char = match std::str::from_utf8(&utf8_buf) {
            Ok(s) => Some(s.to_string()),
            Err(e) if e.error_len().is_none() => None, // Incomplete UTF-8 sequence, keep reading
            Err(_) => {
                // Invalid UTF-8 sequence encountered
                utf8_buf.clear();
                None
            }
        };

        if let Some(s) = valid_char {
            utf8_buf.clear();
            buffer.push_str(&s);

            let lower_buf = buffer.to_lowercase();
            let mut should_stop = false;

            for &stop in &stop_patterns {
                if lower_buf.contains(stop) {
                    let idx = lower_buf.find(stop).unwrap();
                    let clean = &buffer[..idx];
                    if !clean.trim().is_empty() {
                        callback(clean);
                    }
                    should_stop = true;
                    break;
                }
            }

            if should_stop {
                break;
            }

            if s == " "
                || s == "\n"
                || s == "."
                || s == ","
                || s == "!"
                || s == "?"
                || s == ":"
                || s == ";"
            {
                if buffer.contains("[[") && !buffer.contains("]]") {
                    continue; // Buffering inside action tag
                }

                let cleaned = clean_buffer(&buffer);
                if !cleaned.trim().is_empty() && !cleaned.starts_with('>') {
                    callback(&cleaned);
                }
                buffer.clear();
            }
        }
    }

    if !buffer.trim().is_empty() {
        let mut cleaned = clean_buffer(&buffer);
        if cleaned.contains("[[") && !cleaned.contains("]]") {
            cleaned = cleaned.split("[[").next().unwrap_or("").to_string();
        }
        if !cleaned.trim().is_empty() {
            callback(&cleaned);
        }
    }

    let _ = child.wait();
}

/// Default port for local llama-server
const DEFAULT_PORT: u16 = 8090;

/// Check if llama-server is already running on the configured port
pub fn is_running() -> bool {
    let port = get_port();
    std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_ok()
}

/// Get the configured port
fn get_port() -> u16 {
    std::env::var("STEER_LLAMA_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

/// Start a local LLM server in the background if not already running.
/// Dynamically uses `mlx_lm.server` for MLX format directories or `llama-server` for `.gguf` files.
/// Returns true if server is ready, false otherwise.
pub async fn ensure_running() -> bool {
    if is_running() {
        return true;
    }

    let port = get_port();

    let model_path = match resolve_model_path(None) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("⚠️ [local_llm] {}", e);
            return false;
        }
    };

    let is_dir = model_path.is_dir();

    if is_dir && has_mlx_lm() {
        let py_bin = get_python_bin();
        eprintln!(
            "🚀 [local_llm] Starting mlx_lm.server on port {} with {:?}...",
            port,
            model_path.file_name().unwrap_or_default()
        );

        let result = Command::new(&py_bin)
            .args([
                "-m",
                "mlx_lm.server",
                "--model",
                &model_path.to_string_lossy(),
                "--port",
                &port.to_string(),
                "--host",
                "127.0.0.1",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();

        return wait_for_server(result).await;
    }

    // Fallback to llama-server
    let server_path = match get_llama_server() {
        Some(p) => p,
        None => {
            eprintln!("⚠️ [local_llm] llama-server binary not found. Set DAACS_LLAMA_SERVER_PATH.");
            return false;
        }
    };

    // We no longer return false here because it might be an HF repo ID or Ollama identifier
    if !model_path.exists() {
        eprintln!(
            "⚠️ [local_llm] Model not found locally at: {:?}",
            model_path
        );
    }

    eprintln!(
        "🦙 [local_llm] Starting llama-server on port {} with {:?}...",
        port,
        model_path.file_name().unwrap_or_default()
    );

    // GPU layers: -1 = offload all layers to Metal
    let gpu_layers = std::env::var("STEER_LLAMA_GPU_LAYERS")
        .ok()
        .and_then(|s| s.parse::<i32>().ok())
        .unwrap_or(-1);

    let result = Command::new(&server_path)
        .args([
            "-m",
            &model_path.to_string_lossy(),
            "--port",
            &port.to_string(),
            "-ngl",
            &gpu_layers.to_string(),
            "-c",
            "4096",
            "--host",
            "127.0.0.1",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();

    wait_for_server(result).await
}

async fn wait_for_server(result: std::io::Result<std::process::Child>) -> bool {
    match result {
        Ok(_child) => {
            // Wait for server to be ready (max 30 seconds)
            for i in 0..60 {
                sleep(Duration::from_millis(500)).await;
                if is_running() {
                    eprintln!(
                        "✅ [local_llm] server ready after {:.1}s",
                        (i + 1) as f64 * 0.5
                    );
                    return true;
                }
            }
            eprintln!("❌ [local_llm] server failed to start within 30s");
            false
        }
        Err(e) => {
            eprintln!("❌ [local_llm] Failed to spawn server: {}", e);
            false
        }
    }
}

/// Call the local llama-server using OpenAI-compatible chat completion API.
/// Returns the assistant message content.
pub async fn chat_completion(messages: &[Value]) -> anyhow::Result<String> {
    let port = get_port();
    let url = format!("http://127.0.0.1:{}/v1/chat/completions", port);

    let body = json!({
        "model": "local",
        "messages": messages,
        "temperature": 0.3,
        "max_tokens": 2048
    });

    let client = Client::builder()
        .timeout(Duration::from_secs(120))
        .build()?;

    let res = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await?;

    if !res.status().is_success() {
        let err_text = res.text().await.unwrap_or_default();
        return Err(anyhow::anyhow!(
            "llama-server API error ({}): {}",
            port,
            err_text
        ));
    }

    let res_json: Value = res.json().await?;
    let content = res_json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string();

    if content.is_empty() {
        return Err(anyhow::anyhow!("llama-server returned empty response"));
    }

    Ok(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_model_path_uses_user_selected_existing_file() {
        let path =
            std::env::temp_dir().join(format!("omni-local-model-{}.gguf", std::process::id()));
        std::fs::write(&path, b"test model placeholder").expect("write temp model placeholder");

        let resolved = resolve_model_path(Some(path.as_path())).expect("selected model resolves");
        assert_eq!(resolved, path);

        std::fs::remove_file(resolved).ok();
    }

    #[test]
    fn resolve_model_path_accepts_missing_selected_file() {
        let path =
            std::env::temp_dir().join(format!("omni-missing-model-{}.gguf", std::process::id()));

        let resolved =
            resolve_model_path(Some(path.as_path())).expect("missing model should not fail");
        assert_eq!(resolved, path);
    }

    #[test]
    fn discover_model_candidates_lists_multiple_models_without_brand_bias() {
        let root =
            std::env::temp_dir().join(format!("omni-local-model-discovery-{}", std::process::id()));
        let local_models = root.join(".local-os-agent").join("models");
        let mlx_snapshot = root
            .join(".cache")
            .join("huggingface")
            .join("hub")
            .join("models--vendor--portable-mlx-model")
            .join("snapshots")
            .join("test-snapshot");
        let duplicate_mlx_snapshot = root
            .join(".cache")
            .join("huggingface")
            .join("hub")
            .join("models--vendor--portable-mlx-model")
            .join("snapshots")
            .join("duplicate-snapshot");
        let vision_snapshot = root
            .join(".cache")
            .join("huggingface")
            .join("hub")
            .join("models--vendor--image-captioning")
            .join("snapshots")
            .join("test-snapshot");
        std::fs::create_dir_all(&local_models).expect("create local model discovery test dir");
        std::fs::create_dir_all(&mlx_snapshot).expect("create mlx discovery test dir");
        std::fs::create_dir_all(&duplicate_mlx_snapshot)
            .expect("create duplicate mlx discovery test dir");
        std::fs::create_dir_all(&vision_snapshot).expect("create vision discovery test dir");

        let vocab = local_models.join("ggml-vocab-placeholder.gguf");
        std::fs::write(&vocab, b"not a runnable model").expect("write vocab placeholder");

        let tiny_gguf = local_models.join("tiny-story-model.gguf");
        let file = std::fs::File::create(&tiny_gguf).expect("create tiny gguf placeholder");
        file.set_len(MIN_DISCOVERED_MODEL_BYTES - 1)
            .expect("size tiny gguf placeholder");

        let gguf = local_models.join("custom-model-q4_k_m.gguf");
        let file = std::fs::File::create(&gguf).expect("create gguf placeholder");
        file.set_len(MIN_DISCOVERED_MODEL_BYTES + 10)
            .expect("size gguf placeholder");

        std::fs::write(
            mlx_snapshot.join("config.json"),
            br#"{"model_type":"portable","architectures":["PortableForCausalLM"]}"#,
        )
        .expect("write mlx config");
        let model = mlx_snapshot.join("model-00001-of-00002.safetensors");
        let file = std::fs::File::create(&model).expect("create mlx placeholder");
        file.set_len(MIN_DISCOVERED_MODEL_BYTES + 1)
            .expect("size mlx placeholder");
        std::fs::write(
            duplicate_mlx_snapshot.join("config.json"),
            br#"{"model_type":"portable","architectures":["PortableForCausalLM"]}"#,
        )
        .expect("write duplicate mlx config");
        let duplicate_model = duplicate_mlx_snapshot.join("model-00001-of-00002.safetensors");
        let file =
            std::fs::File::create(&duplicate_model).expect("create duplicate mlx placeholder");
        file.set_len(MIN_DISCOVERED_MODEL_BYTES + 1)
            .expect("size duplicate mlx placeholder");

        std::fs::write(
            vision_snapshot.join("config.json"),
            br#"{"model_type":"blip","architectures":["BlipForConditionalGeneration"]}"#,
        )
        .expect("write vision config");
        let vision_model = vision_snapshot.join("model.safetensors");
        let file = std::fs::File::create(&vision_model).expect("create vision placeholder");
        file.set_len(MIN_DISCOVERED_MODEL_BYTES + 1)
            .expect("size vision placeholder");

        let candidates = discover_model_candidates_from_roots(std::slice::from_ref(&root));
        let paths = candidates
            .iter()
            .map(|candidate| candidate.path.clone())
            .collect::<Vec<_>>();
        let names = candidates
            .iter()
            .map(|candidate| candidate.name.clone())
            .collect::<Vec<_>>();
        assert_eq!(candidates.len(), 2);
        assert!(paths.contains(&gguf.to_string_lossy().into_owned()));
        assert!(
            paths.contains(&mlx_snapshot.to_string_lossy().into_owned())
                || paths.contains(&duplicate_mlx_snapshot.to_string_lossy().into_owned())
        );
        assert!(names.contains(&"vendor/portable-mlx-model".to_string()));
        assert_eq!(
            names
                .iter()
                .filter(|name| *name == "vendor/portable-mlx-model")
                .count(),
            1,
            "duplicate snapshots of the same model should be shown once"
        );
        assert!(
            !paths.contains(&vocab.to_string_lossy().into_owned()),
            "vocab/tokenizer files should not be listed as runnable models"
        );
        assert!(
            !paths.contains(&tiny_gguf.to_string_lossy().into_owned()),
            "tiny files should not be listed as useful local LLM candidates"
        );
        assert!(
            !paths.contains(&vision_snapshot.to_string_lossy().into_owned()),
            "non-chat image/vision models should not be listed as local LLM candidates"
        );
        assert!(
            !paths
                .iter()
                .any(|path| path.starts_with(&vision_snapshot.to_string_lossy().into_owned())),
            "non-chat image/vision model files should not be listed as local LLM candidates"
        );

        std::fs::remove_dir_all(root).ok();
    }
}
