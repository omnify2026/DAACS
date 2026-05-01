-- 006_llm_configs: 사용자별 LLM 프로바이더 설정 테이블
CREATE TABLE IF NOT EXISTS llm_configs (
    id             TEXT PRIMARY KEY NOT NULL,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_name  TEXT NOT NULL,
    base_url       TEXT NOT NULL,
    api_key        TEXT NOT NULL,
    is_active      INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ix_llm_configs_user_id ON llm_configs(user_id);
