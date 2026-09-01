-- Layra 穿搭助手 · MySQL 初始化脚本
-- 说明：应用启动时会通过 app/lib/db.ts 惰性创建同样的表结构；
-- 本脚本供部署阶段在火山引擎云数据库 MySQL 上手动初始化，两者保持一致。

CREATE TABLE IF NOT EXISTS wardrobe_items (
  id VARCHAR(36) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  name VARCHAR(80) NOT NULL,
  category VARCHAR(40) NOT NULL,
  color_name VARCHAR(40) NOT NULL,
  color_hex VARCHAR(12) NOT NULL,
  season VARCHAR(40) NOT NULL,
  style VARCHAR(40) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'available',
  ai_tags TEXT NOT NULL,
  tag_version INT NOT NULL DEFAULT 0,
  image_key VARCHAR(255) NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id),
  KEY idx_wardrobe_items_owner_created (owner_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS model_profiles (
  owner_id VARCHAR(64) NOT NULL,
  image_key VARCHAR(255) NOT NULL,
  content_type VARCHAR(64) NOT NULL,
  quality VARCHAR(20) NOT NULL DEFAULT 'ready',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (owner_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_tasks (
  id VARCHAR(36) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  kind VARCHAR(40) NOT NULL,
  idempotency_key VARCHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  request_json TEXT NOT NULL,
  result_json TEXT NULL,
  result_key VARCHAR(255) NULL,
  result_content_type VARCHAR(64) NULL,
  error_message VARCHAR(512) NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY idx_ai_tasks_owner_kind_key (owner_id, kind, idempotency_key),
  KEY idx_ai_tasks_owner_kind_updated (owner_id, kind, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS saved_outfits (
  id VARCHAR(36) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  title VARCHAR(80) NOT NULL,
  scene VARCHAR(40) NOT NULL,
  item_ids TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id),
  KEY idx_saved_outfits_owner_created (owner_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chat_history (
  id VARCHAR(36) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  scene VARCHAR(40) NOT NULL,
  prompt VARCHAR(200) NOT NULL,
  result_json TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id),
  KEY idx_chat_history_owner_created (owner_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_profiles (
  owner_id VARCHAR(64) NOT NULL,
  nickname VARCHAR(40) NOT NULL,
  gender VARCHAR(10) NOT NULL,
  height VARCHAR(10) NOT NULL,
  weight VARCHAR(10) NOT NULL,
  body_type VARCHAR(20) NOT NULL,
  style_prefs TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (owner_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
