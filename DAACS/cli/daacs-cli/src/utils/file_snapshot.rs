use std::collections::HashMap;
use std::path::Path;
use std::time::SystemTime;

#[derive(Clone)]
pub struct FileSnapshot {
    files: HashMap<String, FileMeta>,
}

#[derive(Clone)]
struct FileMeta {
    modified: SystemTime,
    len: u64,
}

pub fn capture(root: &Path) -> FileSnapshot {
    let mut files = HashMap::new();
    collect_files(root, root, &mut files);
    FileSnapshot {
        files,
    }
}

pub fn diff(before: &FileSnapshot, after: &FileSnapshot) -> Vec<String> {
    let mut changed = Vec::new();

    for (path, meta) in &after.files {
        match before.files.get(path) {
            None => changed.push(path.clone()),
            Some(prev) => {
                if prev.len != meta.len || prev.modified != meta.modified {
                    changed.push(path.clone());
                }
            }
        }
    }

    changed.sort();
    changed
}

fn collect_files(root: &Path, current: &Path, out: &mut HashMap<String, FileMeta>) {
    let entries = match std::fs::read_dir(current) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n,
            None => continue,
        };

        if should_skip(name) {
            continue;
        }

        if path.is_dir() {
            collect_files(root, &path, out);
        } else if let Ok(meta) = std::fs::metadata(&path) {
            let rel = path.strip_prefix(root).unwrap_or(&path);
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            out.insert(
                rel_str,
                FileMeta {
                    modified: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    len: meta.len(),
                },
            );
        }
    }
}

fn should_skip(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "target"
            | "node_modules"
            | ".daacs"
            | "dist"
            | "build"
            | ".next"
            | ".venv"
            | "venv"
            | "__pycache__"
    )
}
