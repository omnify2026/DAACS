-- 007_llm_configs_unique: upsert 지원을 위한 (user_id, provider_name) UNIQUE 인덱스
CREATE UNIQUE INDEX IF NOT EXISTS uq_llm_configs_user_provider
    ON llm_configs(user_id, provider_name);
