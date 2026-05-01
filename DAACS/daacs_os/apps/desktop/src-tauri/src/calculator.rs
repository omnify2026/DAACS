#[tauri::command]
pub fn add(a: f64, b: f64) -> f64 {
    a + b
}

#[tauri::command]
pub fn subtract(a: f64, b: f64) -> f64 {
    a - b
}

#[tauri::command]
pub fn multiply(a: f64, b: f64) -> f64 {
    a * b
}

#[tauri::command]
pub fn divide(a: f64, b: f64) -> Result<f64, String> {
    if b == 0.0 {
        Err("Cannot divide by zero".to_string())
    } else {
        Ok(a / b)
    }
}
