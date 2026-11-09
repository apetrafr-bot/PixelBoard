CREATE TABLE IF NOT EXISTS unity_projects (
  workspace_id BIGINT UNSIGNED NOT NULL,
  project_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  project_name VARCHAR(120) NOT NULL,
  owner_id BIGINT UNSIGNED NOT NULL,
  pair_hash CHAR(64) DEFAULT NULL,
  pair_expires DATETIME DEFAULT NULL,
  token_hash CHAR(64) DEFAULT NULL,
  snapshot LONGTEXT DEFAULT NULL,
  snapshot_hash CHAR(64) DEFAULT NULL,
  published_at DATETIME DEFAULT NULL,
  PRIMARY KEY (workspace_id, project_id),
  UNIQUE KEY unity_pair_unique (pair_hash),
  UNIQUE KEY unity_token_unique (token_hash),
  CONSTRAINT unity_projects_workspace_fk FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS unity_jobs (
  id CHAR(36) NOT NULL,
  workspace_id BIGINT UNSIGNED NOT NULL,
  project_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  kind ENUM('refresh', 'import') NOT NULL,
  state ENUM('queued', 'claimed', 'succeeded', 'failed', 'declined', 'cancelled', 'expired') NOT NULL DEFAULT 'queued',
  payload LONGTEXT NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  result LONGTEXT DEFAULT NULL,
  catalogue_notes LONGTEXT DEFAULT NULL,
  created_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY unity_request_unique (workspace_id, project_id, request_id),
  KEY unity_poll_idx (workspace_id, project_id, state, created_at),
  CONSTRAINT unity_jobs_project_fk FOREIGN KEY (workspace_id, project_id) REFERENCES unity_projects (workspace_id, project_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
