#[tokio::test]
async fn test_async_skill_loader() {
    use daacs::skills::loader::SkillLoader;
    use std::path::PathBuf;

    // Use the actual project path or a mock
    let project_path = PathBuf::from("."); 
    let mut loader = SkillLoader::new(&project_path);
    
    // We can't easily mock the filesystem here without more complex setup, 
    // so we test if it runs without crashing and returns *something* (or nothing if dir missing)
    let result = loader.load_all().await;
    assert!(result.is_ok());
}

#[test]
fn test_bundle_config_loading() {
    use daacs::config::bundles::BundlesConfig;
    
    // Test default loading (fallback)
    let config = BundlesConfig::load();
    assert!(config.bundles.contains_key("essentials"));
    assert!(config.bundles.get("essentials").unwrap().skills.contains(&"concise-planning".to_string()));
}
