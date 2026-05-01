//! 코드 파서 (Tree-sitter 기반)
//! 
//! 소스 코드를 파싱하여 구조(함수 시그니처, 임포트 등)를 추출합니다.
//! 토큰 최적화를 위해 "함수 본문"과 "인터페이스"를 분리하는 역할을 합니다.

use anyhow::Result;
use std::path::Path;
use tree_sitter::{Parser, Language, Query, QueryCursor, Node};

/// 파싱된 파일 정보
#[derive(Debug, Clone)]
pub struct ParsedFile {
    /// 파일 경로
    pub path: String,
    /// 전체 코드 (수정용)
    pub full_content: String,
    /// 요약된 코드 (컨텍스트용 - 함수 본문 생략)
    pub skeleton: String,
    /// 임포트 구문 목록
    pub imports: Vec<String>,
    /// 정의된 심볼 (함수/클래스명)
    pub symbols: Vec<String>,
}

/// 지원하는 언어
#[derive(Debug, Clone, Copy)]
enum SupportedLanguage {
    Rust,
    Python,
    TypeScript,
    Unknown,
}

impl SupportedLanguage {
    fn from_path(path: &Path) -> Self {
        match path.extension().and_then(|e| e.to_str()) {
            Some("rs") => SupportedLanguage::Rust,
            Some("py") => SupportedLanguage::Python,
            Some("ts") | Some("tsx") => SupportedLanguage::TypeScript,
            _ => SupportedLanguage::Unknown,
        }
    }

    fn get_language(&self) -> Option<Language> {
        match self {
            SupportedLanguage::Rust => Some(tree_sitter_rust::language()),
            SupportedLanguage::Python => Some(tree_sitter_python::language()),
            SupportedLanguage::TypeScript => Some(tree_sitter_typescript::language_typescript()),
            SupportedLanguage::Unknown => None,
        }
    }
}

/// 파일 파싱
pub fn parse_file(path: &str, content: &str) -> Result<ParsedFile> {
    let path_obj = Path::new(path);
    let lang_type = SupportedLanguage::from_path(path_obj);
    
    // 지원하지 않는 언어는 원본 그대로 반환
    let language = match lang_type.get_language() {
        Some(l) => l,
        None => return Ok(ParsedFile {
            path: path.to_string(),
            full_content: content.to_string(),
            skeleton: content.to_string(), // 요약 없음
            imports: Vec::new(),
            symbols: Vec::new(),
        }),
    };

    let mut parser = Parser::new();
    parser.set_language(language)?;

    let tree = parser.parse(content, None).ok_or_else(|| anyhow::anyhow!("파싱 실패"))?;
    let root_node = tree.root_node();

    let (skeleton, imports, symbols) = extract_info(lang_type, root_node, content)?;

    Ok(ParsedFile {
        path: path.to_string(),
        full_content: content.to_string(),
        skeleton,
        imports,
        symbols,
    })
}

/// 정보 추출 (스켈레톤, 임포트, 심볼)
fn extract_info(
    lang: SupportedLanguage,
    root: Node,
    source: &str,
) -> Result<(String, Vec<String>, Vec<String>)> {
    let mut imports = Vec::new();
    let mut symbols = Vec::new();
    
    // 1. 쿼리 정의 (언어별)
    // 주의: Tree-sitter 쿼리는 공백/괄호에 민감함
    let query_str = match lang {
        SupportedLanguage::Rust => r#"
            (use_declaration) @import
            (function_item name: (identifier) @symbol) @func
            (struct_item name: (type_identifier) @symbol) @struct
            (enum_item name: (type_identifier) @symbol) @enum
            (impl_item type: (type_identifier) @symbol) @impl
            (mod_item name: (identifier) @symbol) @mod
        "#,
        SupportedLanguage::Python => r#"
            (import_statement) @import
            (import_from_statement) @import
            (function_definition name: (identifier) @symbol) @func
            (class_definition name: (identifier) @symbol) @class
        "#,
        SupportedLanguage::TypeScript => r#"
            (import_statement) @import
            (function_declaration name: (identifier) @symbol) @func
            (class_declaration name: (type_identifier) @symbol) @class
            (interface_declaration name: (type_identifier) @symbol) @interface
        "#,
        _ => return Ok((source.to_string(), imports, symbols)),
    };

    let query = Query::new(lang.get_language().unwrap(), query_str)?;
    let mut cursor = QueryCursor::new();
    let matches = cursor.matches(&query, root, source.as_bytes());

    // 2. 스켈레톤 생성을 위한 범위 수집
    // (삭제할 범위: 함수 본문 등)
    let mut ranges_to_hide = Vec::new();

    for m in matches {
        for capture in m.captures {
            let capture_name = query.capture_names()[capture.index as usize].as_str();
            let node = capture.node;
            let text = &source[node.start_byte()..node.end_byte()];

            if capture_name == "import" {
                imports.push(text.to_string());
            } else if capture_name == "symbol" {
                symbols.push(text.to_string());
            } else if ["func", "class", "struct", "enum", "impl", "mod", "interface"].contains(&capture_name) {
                // 본문 찾기 (블록)
                // Rust: block, Python: block, TS: statement_block
                if let Some(body) = node.child_by_field_name("body") {
                    ranges_to_hide.push((body.start_byte(), body.end_byte()));
                } else {
                    // Python의 경우 body 필드가 없을 수 있음 (children 순회)
                    // 단순화를 위해 마지막 자식이 블록이면 숨김 처리
                    if node.child_count() > 0 {
                        let last_child = node.child(node.child_count() - 1).unwrap();
                        if last_child.kind().contains("block") {
                            ranges_to_hide.push((last_child.start_byte(), last_child.end_byte()));
                        }
                    }
                }
            }
        }
    }

    // 3. 스켈레톤 코드 생성
    // 범위를 정렬하고 중복 제거
    ranges_to_hide.sort_by_key(|k| k.0);
    
    let mut skeleton = String::new();
    let mut last_pos = 0;

    // 언어별 대체 문자열
    let replacement = match lang {
        SupportedLanguage::Python => ": ...",
        _ => " { ... }",
    };

    for (start, end) in ranges_to_hide {
        if start < last_pos { continue; } // 겹치는 범위 무시
        
        // 본문 앞부분 추가
        skeleton.push_str(&source[last_pos..start]);
        
        // 본문 대체
        skeleton.push_str(replacement);
        
        last_pos = end;
    }
    
    // 남은 뒷부분 추가
    skeleton.push_str(&source[last_pos..]);

    Ok((skeleton, imports, symbols))
}
