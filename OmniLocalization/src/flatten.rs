use serde_json::Value;
use std::collections::HashMap;

pub fn flatten_json_to_string_map(value: &Value) -> HashMap<String, String> {
    let mut out = HashMap::new();
    flatten_value(value, "", &mut out);
    out
}

fn flatten_value(value: &Value, prefix: &str, out: &mut HashMap<String, String>) {
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                let key = if prefix.is_empty() {
                    k.clone()
                } else {
                    format!("{}.{}", prefix, k)
                };
                flatten_value(v, &key, out);
            }
        }
        Value::String(s) => {
            if !prefix.is_empty() {
                out.insert(prefix.to_string(), s.clone());
            }
        }
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                out.insert(prefix.to_string(), i.to_string());
            } else if let Some(f) = n.as_f64() {
                out.insert(prefix.to_string(), f.to_string());
            }
        }
        Value::Bool(b) => {
            out.insert(prefix.to_string(), b.to_string());
        }
        Value::Null | Value::Array(_) => {}
    }
}
