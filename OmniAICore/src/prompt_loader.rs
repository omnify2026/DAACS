use std::path::Path;

pub fn load_prompt_content<P: AsRef<Path>>(base_path: P, prompt_name: &str) -> Option<String> {
    omni_utilities::try_load_prompt(base_path, prompt_name).map(|d| d.content)
}
