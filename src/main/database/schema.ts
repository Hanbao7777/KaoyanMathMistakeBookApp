// This versions the control_metadata row shape only. Existing migrations remain
// authoritative for application schema upgrades until a unified migrator lands.
export const controlMetadataSchemaVersion = 1;

export const controlMetadataSchemaSql = `
CREATE TABLE IF NOT EXISTS control_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data_epoch TEXT NOT NULL CHECK (length(trim(data_epoch)) > 0),
  data_revision INTEGER NOT NULL CHECK (
    typeof(data_revision) = 'integer'
    AND data_revision >= 0
    AND data_revision <= 9007199254740991
  ),
  control_revision INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(control_revision) = 'integer'
    AND control_revision >= 0
    AND control_revision <= 9007199254740991
  ),
  schema_version INTEGER NOT NULL CHECK (
    typeof(schema_version) = 'integer'
    AND schema_version >= 1
    AND schema_version <= 9007199254740991
  ),
  updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0)
);
`;

export const agentIdentitySchemaSql = `
CREATE TABLE IF NOT EXISTS agent_control_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  external_control_enabled INTEGER NOT NULL DEFAULT 0 CHECK (external_control_enabled IN (0, 1)),
  catalog_version TEXT NOT NULL CHECK (length(trim(catalog_version)) > 0),
  catalog_hash TEXT NOT NULL CHECK (
    substr(catalog_hash, 1, 10) = 'sha256-v1:' AND length(catalog_hash) = 74
    AND substr(catalog_hash, 11) NOT GLOB '*[^0-9a-f]*'
  ),
  policy_version TEXT NOT NULL CHECK (length(trim(policy_version)) > 0),
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json) AND json_type(policy_json) = 'array'),
  policy_hash TEXT NOT NULL CHECK (
    substr(policy_hash, 1, 10) = 'sha256-v1:' AND length(policy_hash) = 74
    AND substr(policy_hash, 11) NOT GLOB '*[^0-9a-f]*'
  ),
  privacy_revision INTEGER NOT NULL DEFAULT 1 CHECK (typeof(privacy_revision) = 'integer' AND privacy_revision >= 1),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
  UNIQUE (catalog_version, catalog_hash)
);

CREATE TABLE IF NOT EXISTS agent_clients (
  client_id TEXT PRIMARY KEY CHECK (length(trim(client_id)) > 0),
  subject_id TEXT NOT NULL CHECK (length(trim(subject_id)) > 0),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  credential_fingerprint TEXT NOT NULL UNIQUE CHECK (
    substr(credential_fingerprint, 1, 10) = 'sha256-v1:' AND length(credential_fingerprint) = 74
    AND substr(credential_fingerprint, 11) NOT GLOB '*[^0-9a-f]*'
  ),
  trust TEXT NOT NULL CHECK (trust IN ('observer', 'collaborator', 'autonomous', 'full_control')),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
  last_active_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_client_scopes (
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN (
    'system.read', 'control.manage', 'clients.read', 'clients.manage', 'sessions.read', 'sessions.manage',
    'r4.read', 'r4.manage', 'approvals.read', 'approvals.manage', 'changesets.read', 'changesets.manage',
    'policy.read', 'policy.manage', 'audit.read', 'audit.export', 'questions.read', 'questions.write',
    'questions.archive', 'reviews.read', 'reviews.submit', 'knowledge.write', 'operations.batch', 'tasks.read',
    'tasks.write', 'tasks.execute', 'focus.read', 'focus.control', 'files.images.read'
  )),
  catalog_version TEXT NOT NULL CHECK (length(trim(catalog_version)) > 0),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  PRIMARY KEY (client_id, scope),
  FOREIGN KEY (client_id) REFERENCES agent_clients(client_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  session_id TEXT PRIMARY KEY CHECK (length(trim(session_id)) > 0),
  client_id TEXT NOT NULL,
  app_instance_id TEXT NOT NULL CHECK (length(trim(app_instance_id)) > 0),
  session_fingerprint TEXT NOT NULL UNIQUE CHECK (
    substr(session_fingerprint, 1, 10) = 'sha256-v1:' AND length(session_fingerprint) = 74
    AND substr(session_fingerprint, 11) NOT GLOB '*[^0-9a-f]*'
  ),
  credential_fingerprint TEXT NOT NULL CHECK (
    substr(credential_fingerprint, 1, 10) = 'sha256-v1:' AND length(credential_fingerprint) = 74
    AND substr(credential_fingerprint, 11) NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  expires_at TEXT NOT NULL CHECK (length(trim(expires_at)) > 0),
  last_active_at TEXT NOT NULL CHECK (length(trim(last_active_at)) > 0),
  terminated_at TEXT,
  FOREIGN KEY (client_id) REFERENCES agent_clients(client_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_clients_revoked_active ON agent_clients(revoked_at, last_active_at);
CREATE INDEX IF NOT EXISTS idx_agent_client_scopes_scope ON agent_client_scopes(scope, client_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_client_expiry ON agent_sessions(client_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_instance_active ON agent_sessions(app_instance_id, terminated_at);
`;

export const agentDurabilitySchemaSql = `
CREATE TABLE IF NOT EXISTS agent_idempotency (
  receipt_id TEXT PRIMARY KEY CHECK (length(receipt_id) = 36),
  client_id TEXT NOT NULL CHECK (length(trim(client_id)) BETWEEN 1 AND 200),
  request_id TEXT NOT NULL CHECK (length(request_id) = 36),
  operation TEXT NOT NULL CHECK (length(trim(operation)) BETWEEN 1 AND 200),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  payload_hash TEXT NOT NULL CHECK (substr(payload_hash, 1, 10) = 'sha256-v1:' AND length(payload_hash) = 74 AND substr(payload_hash, 11) NOT GLOB '*[^0-9a-f]*'),
  affected_set_hash TEXT CHECK (affected_set_hash IS NULL OR (substr(affected_set_hash, 1, 10) = 'sha256-v1:' AND length(affected_set_hash) = 74 AND substr(affected_set_hash, 11) NOT GLOB '*[^0-9a-f]*')),
  catalog_version TEXT NOT NULL CHECK (length(trim(catalog_version)) BETWEEN 1 AND 100),
  catalog_hash TEXT NOT NULL CHECK (substr(catalog_hash, 1, 10) = 'sha256-v1:' AND length(catalog_hash) = 74 AND substr(catalog_hash, 11) NOT GLOB '*[^0-9a-f]*'),
  base_data_epoch TEXT,
  base_data_revision INTEGER CHECK (base_data_revision IS NULL OR (typeof(base_data_revision) = 'integer' AND base_data_revision BETWEEN 0 AND 9007199254740991)),
  risk TEXT NOT NULL CHECK (risk IN ('R0', 'R1', 'R2', 'R3', 'R4')),
  status TEXT NOT NULL CHECK (status IN ('admitted', 'completed', 'failed', 'indeterminate', 'interrupted_precommit')),
  terminal_outcome_json TEXT CHECK (terminal_outcome_json IS NULL OR json_valid(terminal_outcome_json)),
  terminal_outcome_hash TEXT CHECK (terminal_outcome_hash IS NULL OR (substr(terminal_outcome_hash, 1, 10) = 'sha256-v1:' AND length(terminal_outcome_hash) = 74 AND substr(terminal_outcome_hash, 11) NOT GLOB '*[^0-9a-f]*')),
  terminal_data_epoch TEXT,
  terminal_data_revision INTEGER CHECK (terminal_data_revision IS NULL OR (typeof(terminal_data_revision) = 'integer' AND terminal_data_revision BETWEEN 0 AND 9007199254740991)),
  reservation_id TEXT UNIQUE CHECK (reservation_id IS NULL OR length(reservation_id) = 36),
  grant_id TEXT CHECK (grant_id IS NULL OR length(grant_id) = 36),
  r4_target_hash TEXT CHECK (r4_target_hash IS NULL OR (substr(r4_target_hash, 1, 10) = 'sha256-v1:' AND length(r4_target_hash) = 74 AND substr(r4_target_hash, 11) NOT GLOB '*[^0-9a-f]*')),
  r4_recovery TEXT CHECK (r4_recovery IS NULL OR r4_recovery IN ('inverse', 'quarantine', 'consistency_bundle')),
  r4_max_affected_entities INTEGER CHECK (r4_max_affected_entities IS NULL OR (typeof(r4_max_affected_entities) = 'integer' AND r4_max_affected_entities BETWEEN 1 AND 500)),
  r4_reservation_expires_at TEXT CHECK (r4_reservation_expires_at IS NULL OR (length(r4_reservation_expires_at) = 24 AND substr(r4_reservation_expires_at, 24, 1) = 'Z')),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND substr(created_at, 24, 1) = 'Z'),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 24 AND substr(updated_at, 24, 1) = 'Z'),
  terminal_at TEXT CHECK (terminal_at IS NULL OR (length(terminal_at) = 24 AND substr(terminal_at, 24, 1) = 'Z')),
  retain_until TEXT CHECK (retain_until IS NULL OR (length(retain_until) = 24 AND substr(retain_until, 24, 1) = 'Z')),
  UNIQUE (client_id, request_id),
  CHECK ((base_data_epoch IS NULL) = (base_data_revision IS NULL)),
  CHECK (
    (grant_id IS NULL AND reservation_id IS NULL AND r4_target_hash IS NULL AND r4_recovery IS NULL AND r4_max_affected_entities IS NULL AND r4_reservation_expires_at IS NULL)
    OR
    (grant_id IS NOT NULL AND reservation_id IS NOT NULL AND r4_target_hash IS NOT NULL AND r4_recovery IS NOT NULL AND r4_max_affected_entities IS NOT NULL AND r4_reservation_expires_at IS NOT NULL)
  ),
  CHECK ((terminal_data_epoch IS NULL) = (terminal_data_revision IS NULL)),
  CHECK (
    (status = 'admitted' AND terminal_outcome_json IS NULL AND terminal_outcome_hash IS NULL AND terminal_at IS NULL AND retain_until IS NULL)
    OR
    (status <> 'admitted' AND terminal_outcome_json IS NOT NULL AND terminal_outcome_hash IS NOT NULL AND terminal_at IS NOT NULL AND retain_until IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS agent_r4_grants (
  grant_id TEXT PRIMARY KEY CHECK (length(grant_id) = 36),
  client_id TEXT NOT NULL CHECK (length(trim(client_id)) BETWEEN 1 AND 200),
  operation TEXT NOT NULL CHECK (length(trim(operation)) BETWEEN 1 AND 200),
  payload_hash TEXT NOT NULL CHECK (substr(payload_hash, 1, 10) = 'sha256-v1:' AND length(payload_hash) = 74 AND substr(payload_hash, 11) NOT GLOB '*[^0-9a-f]*'),
  target_hash TEXT NOT NULL CHECK (substr(target_hash, 1, 10) = 'sha256-v1:' AND length(target_hash) = 74 AND substr(target_hash, 11) NOT GLOB '*[^0-9a-f]*'),
  catalog_version TEXT NOT NULL CHECK (length(trim(catalog_version)) BETWEEN 1 AND 100),
  catalog_hash TEXT NOT NULL CHECK (substr(catalog_hash, 1, 10) = 'sha256-v1:' AND length(catalog_hash) = 74 AND substr(catalog_hash, 11) NOT GLOB '*[^0-9a-f]*'),
  recovery TEXT NOT NULL CHECK (recovery IN ('inverse', 'quarantine', 'consistency_bundle')),
  max_affected_entities INTEGER NOT NULL CHECK (typeof(max_affected_entities) = 'integer' AND max_affected_entities BETWEEN 1 AND 500),
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses = 1),
  status TEXT NOT NULL CHECK (status IN ('active', 'reserved', 'consumed', 'revoked', 'expired')),
  issued_at TEXT NOT NULL CHECK (length(issued_at) = 24 AND substr(issued_at, 24, 1) = 'Z'),
  expires_at TEXT NOT NULL CHECK (
    length(expires_at) = 24 AND substr(expires_at, 24, 1) = 'Z' AND expires_at > issued_at
    AND (julianday(expires_at) - julianday(issued_at)) * 86400000 <= 900000.5
  ),
  reservation_id TEXT UNIQUE CHECK (reservation_id IS NULL OR length(reservation_id) = 36),
  reserved_client_id TEXT,
  reserved_request_id TEXT CHECK (reserved_request_id IS NULL OR length(reserved_request_id) = 36),
  reserved_payload_hash TEXT CHECK (reserved_payload_hash IS NULL OR (substr(reserved_payload_hash, 1, 10) = 'sha256-v1:' AND length(reserved_payload_hash) = 74 AND substr(reserved_payload_hash, 11) NOT GLOB '*[^0-9a-f]*')),
  reserved_affected_set_hash TEXT CHECK (reserved_affected_set_hash IS NULL OR (substr(reserved_affected_set_hash, 1, 10) = 'sha256-v1:' AND length(reserved_affected_set_hash) = 74 AND substr(reserved_affected_set_hash, 11) NOT GLOB '*[^0-9a-f]*')),
  reserved_base_epoch TEXT,
  reserved_base_revision INTEGER CHECK (reserved_base_revision IS NULL OR (typeof(reserved_base_revision) = 'integer' AND reserved_base_revision BETWEEN 0 AND 9007199254740991)),
  reserved_catalog_version TEXT,
  reserved_catalog_hash TEXT CHECK (reserved_catalog_hash IS NULL OR (substr(reserved_catalog_hash, 1, 10) = 'sha256-v1:' AND length(reserved_catalog_hash) = 74 AND substr(reserved_catalog_hash, 11) NOT GLOB '*[^0-9a-f]*')),
  reserved_at TEXT CHECK (reserved_at IS NULL OR (length(reserved_at) = 24 AND substr(reserved_at, 24, 1) = 'Z')),
  reservation_expires_at TEXT CHECK (reservation_expires_at IS NULL OR (length(reservation_expires_at) = 24 AND substr(reservation_expires_at, 24, 1) = 'Z')),
  consumed_at TEXT CHECK (consumed_at IS NULL OR (length(consumed_at) = 24 AND substr(consumed_at, 24, 1) = 'Z')),
  revoked_at TEXT CHECK (revoked_at IS NULL OR (length(revoked_at) = 24 AND substr(revoked_at, 24, 1) = 'Z')),
  UNIQUE (client_id, reserved_request_id),
  CHECK ((reserved_base_epoch IS NULL) = (reserved_base_revision IS NULL)),
  CHECK (
    (status IN ('active', 'revoked', 'expired') AND reservation_id IS NULL AND reserved_client_id IS NULL AND reserved_request_id IS NULL AND reserved_payload_hash IS NULL AND reserved_affected_set_hash IS NULL AND reserved_base_epoch IS NULL AND reserved_catalog_version IS NULL AND reserved_catalog_hash IS NULL AND reserved_at IS NULL AND reservation_expires_at IS NULL)
    OR
    (status IN ('reserved', 'consumed') AND reservation_id IS NOT NULL AND reserved_client_id IS NOT NULL AND reserved_request_id IS NOT NULL AND reserved_payload_hash IS NOT NULL AND reserved_affected_set_hash IS NOT NULL AND reserved_base_epoch IS NOT NULL AND reserved_catalog_version IS NOT NULL AND reserved_catalog_hash IS NOT NULL AND reserved_at IS NOT NULL AND reservation_expires_at IS NOT NULL)
  ),
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (reservation_expires_at IS NULL OR (reservation_expires_at > reserved_at AND reservation_expires_at <= expires_at))
);

CREATE TABLE IF NOT EXISTS agent_approvals (
  approval_id TEXT PRIMARY KEY CHECK (length(approval_id) = 36),
  nonce TEXT NOT NULL UNIQUE CHECK (length(nonce) BETWEEN 16 AND 500),
  client_id TEXT NOT NULL CHECK (length(trim(client_id)) BETWEEN 1 AND 200),
  credential_binding TEXT NOT NULL CHECK (length(credential_binding) BETWEEN 1 AND 500),
  operation TEXT NOT NULL CHECK (length(trim(operation)) BETWEEN 1 AND 200),
  payload_hash TEXT NOT NULL CHECK (substr(payload_hash, 1, 10) = 'sha256-v1:' AND length(payload_hash) = 74 AND substr(payload_hash, 11) NOT GLOB '*[^0-9a-f]*'),
  affected_set_hash TEXT NOT NULL CHECK (substr(affected_set_hash, 1, 10) = 'sha256-v1:' AND length(affected_set_hash) = 74 AND substr(affected_set_hash, 11) NOT GLOB '*[^0-9a-f]*'),
  base_data_epoch TEXT NOT NULL CHECK (length(trim(base_data_epoch)) BETWEEN 1 AND 200),
  base_data_revision INTEGER NOT NULL CHECK (typeof(base_data_revision) = 'integer' AND base_data_revision BETWEEN 0 AND 9007199254740991),
  catalog_version TEXT NOT NULL CHECK (length(trim(catalog_version)) BETWEEN 1 AND 100),
  catalog_hash TEXT NOT NULL CHECK (substr(catalog_hash, 1, 10) = 'sha256-v1:' AND length(catalog_hash) = 74 AND substr(catalog_hash, 11) NOT GLOB '*[^0-9a-f]*'),
  policy_version TEXT NOT NULL CHECK (length(trim(policy_version)) BETWEEN 1 AND 100),
  risk TEXT NOT NULL CHECK (risk IN ('R0', 'R1', 'R2', 'R3', 'R4')),
  required_scopes_json TEXT NOT NULL CHECK (json_valid(required_scopes_json) AND json_type(required_scopes_json) = 'array'),
  required_scopes_hash TEXT NOT NULL CHECK (substr(required_scopes_hash, 1, 10) = 'sha256-v1:' AND length(required_scopes_hash) = 74 AND substr(required_scopes_hash, 11) NOT GLOB '*[^0-9a-f]*'),
  recovery TEXT NOT NULL CHECK (recovery IN ('inverse', 'quarantine', 'consistency_bundle', 'none')),
  source TEXT CHECK (source IS NULL OR source IN ('user', 'policy')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'consumed', 'revoked', 'expired')),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND substr(created_at, 24, 1) = 'Z'),
  expires_at TEXT NOT NULL CHECK (length(expires_at) = 24 AND substr(expires_at, 24, 1) = 'Z' AND expires_at > created_at),
  decided_at TEXT CHECK (decided_at IS NULL OR (length(decided_at) = 24 AND substr(decided_at, 24, 1) = 'Z')),
  consumed_at TEXT CHECK (consumed_at IS NULL OR (length(consumed_at) = 24 AND substr(consumed_at, 24, 1) = 'Z')),
  revoked_at TEXT CHECK (revoked_at IS NULL OR (length(revoked_at) = 24 AND substr(revoked_at, 24, 1) = 'Z')),
  CHECK ((status IN ('approved', 'rejected')) = (decided_at IS NOT NULL)),
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS agent_changesets (
  change_set_id TEXT PRIMARY KEY CHECK (length(change_set_id) = 36),
  client_id TEXT NOT NULL CHECK (length(trim(client_id)) BETWEEN 1 AND 200),
  status TEXT NOT NULL CHECK (status IN ('draft', 'waiting_approval', 'approved', 'applied', 'rejected', 'expired', 'rolled_back')),
  catalog_version TEXT NOT NULL CHECK (length(trim(catalog_version)) BETWEEN 1 AND 100),
  catalog_hash TEXT NOT NULL CHECK (substr(catalog_hash, 1, 10) = 'sha256-v1:' AND length(catalog_hash) = 74 AND substr(catalog_hash, 11) NOT GLOB '*[^0-9a-f]*'),
  base_data_epoch TEXT NOT NULL CHECK (length(trim(base_data_epoch)) BETWEEN 1 AND 200),
  base_data_revision INTEGER NOT NULL CHECK (typeof(base_data_revision) = 'integer' AND base_data_revision BETWEEN 0 AND 9007199254740991),
  risk TEXT NOT NULL CHECK (risk IN ('R2', 'R3', 'R4')),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 2000),
  affected_set_hash TEXT NOT NULL CHECK (substr(affected_set_hash, 1, 10) = 'sha256-v1:' AND length(affected_set_hash) = 74 AND substr(affected_set_hash, 11) NOT GLOB '*[^0-9a-f]*'),
  recovery TEXT NOT NULL CHECK (recovery IN ('inverse', 'quarantine', 'consistency_bundle', 'none')),
  recovery_asset_id TEXT CHECK (recovery_asset_id IS NULL OR length(recovery_asset_id) = 36),
  operation_count INTEGER NOT NULL CHECK (typeof(operation_count) = 'integer' AND operation_count BETWEEN 1 AND 500),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND substr(created_at, 24, 1) = 'Z'),
  expires_at TEXT NOT NULL CHECK (length(expires_at) = 24 AND substr(expires_at, 24, 1) = 'Z' AND expires_at > created_at),
  applied_at TEXT,
  CHECK ((status = 'applied') = (applied_at IS NOT NULL)),
  CHECK (risk <> 'R4' OR recovery <> 'none')
);

CREATE TABLE IF NOT EXISTS agent_changeset_operations (
  change_set_id TEXT NOT NULL,
  operation_index INTEGER NOT NULL CHECK (typeof(operation_index) = 'integer' AND operation_index BETWEEN 0 AND 499),
  operation TEXT NOT NULL CHECK (length(trim(operation)) BETWEEN 1 AND 200),
  operation_json TEXT NOT NULL CHECK (json_valid(operation_json) AND json_type(operation_json) = 'object'),
  operation_hash TEXT NOT NULL CHECK (substr(operation_hash, 1, 10) = 'sha256-v1:' AND length(operation_hash) = 74 AND substr(operation_hash, 11) NOT GLOB '*[^0-9a-f]*'),
  payload_hash TEXT NOT NULL CHECK (substr(payload_hash, 1, 10) = 'sha256-v1:' AND length(payload_hash) = 74 AND substr(payload_hash, 11) NOT GLOB '*[^0-9a-f]*'),
  affected_entities_json TEXT NOT NULL CHECK (json_valid(affected_entities_json) AND json_type(affected_entities_json) = 'array'),
  affected_entities_hash TEXT NOT NULL CHECK (substr(affected_entities_hash, 1, 10) = 'sha256-v1:' AND length(affected_entities_hash) = 74 AND substr(affected_entities_hash, 11) NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (change_set_id, operation_index),
  FOREIGN KEY (change_set_id) REFERENCES agent_changesets(change_set_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS agent_audit_segments (
  segment_id TEXT PRIMARY KEY CHECK (length(segment_id) = 36),
  segment_number INTEGER NOT NULL UNIQUE CHECK (typeof(segment_number) = 'integer' AND segment_number >= 0),
  previous_segment_id TEXT UNIQUE CHECK (previous_segment_id IS NULL OR length(previous_segment_id) = 36),
  previous_closing_hash TEXT CHECK (previous_closing_hash IS NULL OR (substr(previous_closing_hash, 1, 10) = 'sha256-v1:' AND length(previous_closing_hash) = 74 AND substr(previous_closing_hash, 11) NOT GLOB '*[^0-9a-f]*')),
  opened_sequence INTEGER NOT NULL CHECK (typeof(opened_sequence) = 'integer' AND opened_sequence >= 0),
  last_sequence INTEGER CHECK (last_sequence IS NULL OR (typeof(last_sequence) = 'integer' AND last_sequence >= opened_sequence)),
  last_hash TEXT CHECK (last_hash IS NULL OR (substr(last_hash, 1, 10) = 'sha256-v1:' AND length(last_hash) = 74 AND substr(last_hash, 11) NOT GLOB '*[^0-9a-f]*')),
  closed_sequence INTEGER CHECK (closed_sequence IS NULL OR (typeof(closed_sequence) = 'integer' AND closed_sequence >= opened_sequence)),
  closing_hash TEXT CHECK (closing_hash IS NULL OR (substr(closing_hash, 1, 10) = 'sha256-v1:' AND length(closing_hash) = 74 AND substr(closing_hash, 11) NOT GLOB '*[^0-9a-f]*')),
  opened_at TEXT NOT NULL CHECK (length(opened_at) = 24 AND substr(opened_at, 24, 1) = 'Z'),
  closed_at TEXT,
  pruned_at TEXT,
  CHECK ((previous_segment_id IS NULL) = (previous_closing_hash IS NULL)),
  CHECK ((last_sequence IS NULL) = (last_hash IS NULL)),
  CHECK ((closed_sequence IS NULL) = (closing_hash IS NULL)),
  CHECK ((closed_sequence IS NULL) = (closed_at IS NULL)),
  CHECK (closed_sequence IS NULL OR (closed_sequence = last_sequence AND closing_hash = last_hash)),
  FOREIGN KEY (previous_segment_id) REFERENCES agent_audit_segments(segment_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS agent_audit_events (
  sequence INTEGER PRIMARY KEY CHECK (typeof(sequence) = 'integer' AND sequence >= 0),
  audit_id TEXT NOT NULL UNIQUE CHECK (length(audit_id) = 36),
  segment_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('authentication', 'pairing', 'admission', 'denial', 'query', 'success', 'failure', 'indeterminate', 'reconciliation', 'grant_reserved', 'grant_released', 'grant_consumed', 'client_revoked', 'session_terminated', 'policy_changed', 'catalog_changed', 'control_changed', 'segment_closed', 'segment_opened')),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) = 24 AND substr(occurred_at, 24, 1) = 'Z'),
  client_id TEXT NOT NULL CHECK (length(trim(client_id)) BETWEEN 1 AND 200),
  request_id TEXT CHECK (request_id IS NULL OR length(request_id) = 36),
  operation TEXT CHECK (operation IS NULL OR length(trim(operation)) BETWEEN 1 AND 200),
  risk TEXT CHECK (risk IS NULL OR risk IN ('R0', 'R1', 'R2', 'R3', 'R4')),
  catalog_version TEXT NOT NULL CHECK (length(trim(catalog_version)) BETWEEN 1 AND 100),
  catalog_hash TEXT NOT NULL CHECK (substr(catalog_hash, 1, 10) = 'sha256-v1:' AND length(catalog_hash) = 74 AND substr(catalog_hash, 11) NOT GLOB '*[^0-9a-f]*'),
  policy_version TEXT CHECK (policy_version IS NULL OR length(trim(policy_version)) BETWEEN 1 AND 100),
  receipt_id TEXT CHECK (receipt_id IS NULL OR length(receipt_id) = 36),
  receipt_client_id TEXT,
  receipt_request_id TEXT CHECK (receipt_request_id IS NULL OR length(receipt_request_id) = 36),
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json) AND json_type(summary_json) = 'object'),
  affected_entities_json TEXT NOT NULL CHECK (json_valid(affected_entities_json) AND json_type(affected_entities_json) = 'array'),
  event_json TEXT NOT NULL CHECK (json_valid(event_json) AND json_type(event_json) = 'object'),
  previous_hash TEXT CHECK (previous_hash IS NULL OR (substr(previous_hash, 1, 10) = 'sha256-v1:' AND length(previous_hash) = 74 AND substr(previous_hash, 11) NOT GLOB '*[^0-9a-f]*')),
  record_hash TEXT NOT NULL UNIQUE CHECK (substr(record_hash, 1, 10) = 'sha256-v1:' AND length(record_hash) = 74 AND substr(record_hash, 11) NOT GLOB '*[^0-9a-f]*'),
  retention_class TEXT NOT NULL CHECK (retention_class IN ('ordinary_180d', 'protected_1y')),
  retain_until TEXT NOT NULL CHECK (length(retain_until) = 24 AND substr(retain_until, 24, 1) = 'Z' AND retain_until > occurred_at),
  UNIQUE (segment_id, sequence),
  CHECK ((receipt_client_id IS NULL) = (receipt_request_id IS NULL)),
  FOREIGN KEY (segment_id) REFERENCES agent_audit_segments(segment_id) ON DELETE RESTRICT
);

CREATE TRIGGER IF NOT EXISTS agent_changeset_operations_immutable_update
BEFORE UPDATE ON agent_changeset_operations
BEGIN
  SELECT RAISE(ABORT, 'agent_changeset_operations are immutable');
END;

CREATE TRIGGER IF NOT EXISTS agent_changeset_operations_immutable_delete
BEFORE DELETE ON agent_changeset_operations
BEGIN
  SELECT RAISE(ABORT, 'agent_changeset_operations are immutable');
END;

CREATE INDEX IF NOT EXISTS idx_agent_idempotency_status_updated ON agent_idempotency(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_idempotency_retention ON agent_idempotency(retain_until, status);
CREATE INDEX IF NOT EXISTS idx_agent_r4_grants_client_status_expiry ON agent_r4_grants(client_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_agent_r4_grants_reserve_lookup ON agent_r4_grants(client_id, operation, payload_hash, target_hash, catalog_hash, status, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_r4_grants_unique_authority ON agent_r4_grants(client_id, operation, payload_hash, target_hash, catalog_hash) WHERE status IN ('active', 'reserved');
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_r4_grants_reserved_request ON agent_r4_grants(reserved_request_id) WHERE reserved_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_approvals_status_expiry ON agent_approvals(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_agent_approvals_client_status ON agent_approvals(client_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_agent_changesets_client_status_expiry ON agent_changesets(client_id, status, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_audit_segments_open ON agent_audit_segments((1)) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_agent_audit_events_search ON agent_audit_events(occurred_at, client_id, risk, operation);
CREATE INDEX IF NOT EXISTS idx_agent_audit_events_receipt ON agent_audit_events(receipt_client_id, receipt_request_id);
CREATE INDEX IF NOT EXISTS idx_agent_audit_events_retention ON agent_audit_events(retain_until, segment_id);
`;

export const schemaSql = `
${controlMetadataSchemaSql}
${agentIdentitySchemaSql}
${agentDurabilitySchemaSql}

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT DEFAULT '',
  wrong_thinking TEXT DEFAULT '',
  wrong_solution TEXT DEFAULT '',
  correct_solution TEXT DEFAULT '',
  answer TEXT DEFAULT '',
  subject TEXT DEFAULT '高等数学',
  category TEXT NOT NULL,
  question_type TEXT NOT NULL,
  error_reason TEXT NOT NULL,
  source TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  mastery_level TEXT NOT NULL,
  note TEXT DEFAULT '',
  review_count INTEGER NOT NULL DEFAULT 0,
  correct_count INTEGER NOT NULL DEFAULT 0,
  wrong_count INTEGER NOT NULL DEFAULT 0,
  no_idea_count INTEGER NOT NULL DEFAULT 0,
  consecutive_correct INTEGER NOT NULL DEFAULT 0,
  last_reviewed_at TEXT,
  next_review_at TEXT,
  import_batch_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS question_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL,
  image_type TEXT NOT NULL CHECK (image_type IN ('original', 'question', 'solution')),
  file_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS review_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL,
  result TEXT NOT NULL,
  mastery_before TEXT,
  mastery_after TEXT,
  reviewed_at TEXT,
  next_review_at TEXT,
  note TEXT DEFAULT '',
  review_date TEXT,
  review_round INTEGER,
  duration_minutes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS question_tags (
  question_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (question_id, tag_id),
  FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS textbooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  subject TEXT DEFAULT '高等数学',
  edition TEXT DEFAULT '',
  file_name TEXT DEFAULT '',
  file_path TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  textbook_id INTEGER,
  node_id TEXT UNIQUE NOT NULL,
  parent_node_id TEXT,
  title TEXT NOT NULL,
  subject TEXT DEFAULT '高等数学',
  category TEXT DEFAULT '',
  level INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  book_page INTEGER,
  pdf_page INTEGER,
  summary TEXT DEFAULT '',
  core_formulas TEXT DEFAULT '[]',
  common_question_types TEXT DEFAULT '[]',
  common_error_reasons TEXT DEFAULT '[]',
  tags TEXT DEFAULT '[]',
  import_batch_id TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (textbook_id) REFERENCES textbooks(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS question_knowledge_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL,
  knowledge_node_id TEXT NOT NULL,
  match_type TEXT DEFAULT 'gpt',
  created_at TEXT NOT NULL,
  FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE,
  FOREIGN KEY (knowledge_node_id) REFERENCES knowledge_points(node_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('wrong_questions', 'question_bank', 'knowledge_map', 'textbook', 'unknown')),
  name TEXT DEFAULT '',
  source_file_name TEXT DEFAULT '',
  source TEXT DEFAULT '',
  imported_at TEXT NOT NULL,
  item_count INTEGER DEFAULT 0,
  asset_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'deleted', 'failed')),
  metadata_json TEXT DEFAULT '',
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS import_batch_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  target_table TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action TEXT DEFAULT 'created',
  created_at TEXT NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES import_batches(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS import_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (batch_id) REFERENCES import_batches(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS external_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT DEFAULT '',
  options TEXT DEFAULT '',
  answer TEXT DEFAULT '',
  solution TEXT DEFAULT '',
  subject TEXT DEFAULT '高等数学',
  category TEXT DEFAULT '其他',
  question_format TEXT DEFAULT '解答题',
  question_type TEXT DEFAULT '其他',
  difficulty TEXT DEFAULT '中等',
  knowledge_points TEXT DEFAULT '',
  source TEXT DEFAULT '',
  year INTEGER,
  exam_type TEXT DEFAULT '',
  question_number INTEGER,
  section TEXT DEFAULT '',
  tags TEXT DEFAULT '',
  raw_file_path TEXT DEFAULT '',
  paper_pdf_path TEXT DEFAULT '',
  solution_pdf_path TEXT DEFAULT '',
  import_batch_id TEXT DEFAULT '',
  asset_base_path TEXT DEFAULT '',
  added_to_mistakes INTEGER NOT NULL DEFAULT 0,
  created_question_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (created_question_id) REFERENCES questions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS external_question_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_question_id INTEGER NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('correct', 'wrong', 'no_idea')),
  attempted_at TEXT NOT NULL,
  note TEXT DEFAULT '',
  added_to_mistakes INTEGER NOT NULL DEFAULT 0,
  created_question_id INTEGER,
  FOREIGN KEY (external_question_id) REFERENCES external_questions(id) ON DELETE CASCADE,
  FOREIGN KEY (created_question_id) REFERENCES questions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS study_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  exam_date TEXT,
  daily_target_minutes INTEGER DEFAULT 240,
  supervision_mode TEXT DEFAULT 'strict',
  auto_rollover_enabled INTEGER DEFAULT 1,
  last_rollover_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS study_subjects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS study_materials (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  name TEXT NOT NULL,
  material_type TEXT DEFAULT '其他',
  progress_unit TEXT NOT NULL,
  custom_unit_name TEXT,
  total_amount REAL NOT NULL DEFAULT 0,
  current_amount REAL NOT NULL DEFAULT 0,
  start_date TEXT,
  target_date TEXT,
  priority TEXT DEFAULT '中',
  status TEXT DEFAULT '进行中',
  note TEXT DEFAULT '',
  is_deleted INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (subject_id) REFERENCES study_subjects(id)
);

CREATE TABLE IF NOT EXISTS study_tasks (
  id TEXT PRIMARY KEY,
  task_date TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  material_id TEXT,
  title TEXT NOT NULL,
  task_type TEXT DEFAULT '其他',
  estimated_minutes INTEGER DEFAULT 0,
  actual_minutes INTEGER DEFAULT 0,
  priority TEXT DEFAULT '中',
  status TEXT DEFAULT '未开始',
  completion_quality TEXT,
  defer_count INTEGER DEFAULT 0,
  original_date TEXT,
  skipped_reason TEXT,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (subject_id) REFERENCES study_subjects(id),
  FOREIGN KEY (material_id) REFERENCES study_materials(id)
);

CREATE TABLE IF NOT EXISTS study_sessions (
  id TEXT PRIMARY KEY,
  session_date TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  task_id TEXT,
  material_id TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT,
  duration_minutes INTEGER DEFAULT 0,
  quality TEXT,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (subject_id) REFERENCES study_subjects(id),
  FOREIGN KEY (task_id) REFERENCES study_tasks(id),
  FOREIGN KEY (material_id) REFERENCES study_materials(id)
);

CREATE TABLE IF NOT EXISTS daily_reviews (
  id TEXT PRIMARY KEY,
  review_date TEXT NOT NULL UNIQUE,
  completion_rate REAL DEFAULT 0,
  total_study_minutes INTEGER DEFAULT 0,
  completed_task_count INTEGER DEFAULT 0,
  total_task_count INTEGER DEFAULT 0,
  mood TEXT,
  today_summary TEXT DEFAULT '',
  main_problem TEXT DEFAULT '',
  tomorrow_priority TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_questions_created_at ON questions(created_at);
CREATE INDEX IF NOT EXISTS idx_questions_category ON questions(category);
CREATE INDEX IF NOT EXISTS idx_questions_mastery ON questions(mastery_level);
CREATE INDEX IF NOT EXISTS idx_review_logs_question ON review_logs(question_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_points_node ON knowledge_points(node_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_points_parent ON knowledge_points(parent_node_id);
CREATE INDEX IF NOT EXISTS idx_question_knowledge_question ON question_knowledge_points(question_id);
CREATE INDEX IF NOT EXISTS idx_question_knowledge_node ON question_knowledge_points(knowledge_node_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_question_knowledge_unique ON question_knowledge_points(question_id, knowledge_node_id);
CREATE INDEX IF NOT EXISTS idx_import_batches_type ON import_batches(type);
CREATE INDEX IF NOT EXISTS idx_import_batches_status ON import_batches(status);
CREATE INDEX IF NOT EXISTS idx_import_batch_items_batch ON import_batch_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_import_assets_batch ON import_assets(batch_id);
CREATE INDEX IF NOT EXISTS idx_external_questions_subject ON external_questions(subject);
CREATE INDEX IF NOT EXISTS idx_external_questions_year ON external_questions(year);
CREATE INDEX IF NOT EXISTS idx_external_questions_format ON external_questions(question_format);
CREATE INDEX IF NOT EXISTS idx_external_questions_type ON external_questions(question_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_external_questions_unique_source ON external_questions(source, exam_type, year, question_number);
CREATE INDEX IF NOT EXISTS idx_external_attempts_question ON external_question_attempts(external_question_id);
CREATE INDEX IF NOT EXISTS idx_external_attempts_created_question ON external_question_attempts(created_question_id);
CREATE INDEX IF NOT EXISTS idx_study_materials_subject ON study_materials(subject_id);
CREATE INDEX IF NOT EXISTS idx_study_materials_status ON study_materials(status);
CREATE INDEX IF NOT EXISTS idx_study_tasks_date ON study_tasks(task_date);
CREATE INDEX IF NOT EXISTS idx_study_tasks_subject ON study_tasks(subject_id);
CREATE INDEX IF NOT EXISTS idx_study_tasks_material ON study_tasks(material_id);
CREATE INDEX IF NOT EXISTS idx_study_tasks_status ON study_tasks(status);
CREATE INDEX IF NOT EXISTS idx_study_sessions_date ON study_sessions(session_date);
CREATE INDEX IF NOT EXISTS idx_study_sessions_subject ON study_sessions(subject_id);
CREATE INDEX IF NOT EXISTS idx_daily_reviews_date ON daily_reviews(review_date);

CREATE TABLE IF NOT EXISTS ticktick_lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#4a90d9',
  icon TEXT DEFAULT 'list',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_folder INTEGER NOT NULL DEFAULT 0,
  parent_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ticktick_tasks (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  title TEXT NOT NULL,
  note TEXT DEFAULT '',
  due_date TEXT,
  due_time TEXT CHECK(due_time IS NULL OR due_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  priority TEXT CHECK(priority IN ('none','低','中','高')) DEFAULT 'none',
  is_completed INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  parent_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  tags TEXT DEFAULT '[]',
  recurrence_rule TEXT,
  estimated_minutes INTEGER NOT NULL DEFAULT 0,
  actual_minutes INTEGER NOT NULL DEFAULT 0,
  pomodoro_sessions INTEGER NOT NULL DEFAULT 0,
  source TEXT CHECK(source IN ('manual','auto_review','ai_plan')) DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (list_id) REFERENCES ticktick_lists(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES ticktick_tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ticktick_tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#999999'
);

CREATE TABLE IF NOT EXISTS ticktick_focus_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT,
  duration_minutes INTEGER NOT NULL DEFAULT 0,
  session_type TEXT CHECK(session_type IN ('focus','short_break','long_break')) DEFAULT 'focus',
  completed INTEGER NOT NULL DEFAULT 1,
  white_noise TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES ticktick_tasks(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ticktick_bridge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticktick_task_id TEXT NOT NULL,
  linked_type TEXT NOT NULL CHECK(linked_type IN ('question','knowledge_point','subject','study_task')),
  linked_id TEXT NOT NULL,
  sync_review INTEGER NOT NULL DEFAULT 1,
  sync_mastery INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (ticktick_task_id) REFERENCES ticktick_tasks(id) ON DELETE CASCADE,
  UNIQUE(ticktick_task_id, linked_type, linked_id)
);

CREATE TABLE IF NOT EXISTS ticktick_ai_plans (
  id TEXT PRIMARY KEY,
  plan_date TEXT NOT NULL,
  raw_response TEXT NOT NULL,
  tasks_json TEXT NOT NULL,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  reviewed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ticktick_tasks_list ON ticktick_tasks(list_id);
CREATE INDEX IF NOT EXISTS idx_ticktick_tasks_date ON ticktick_tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_ticktick_tasks_parent ON ticktick_tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_ticktick_bridge_task ON ticktick_bridge(ticktick_task_id);
CREATE INDEX IF NOT EXISTS idx_ticktick_bridge_linked ON ticktick_bridge(linked_type, linked_id);
CREATE INDEX IF NOT EXISTS idx_ticktick_focus_task ON ticktick_focus_sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_ticktick_ai_plans_date ON ticktick_ai_plans(plan_date);

CREATE TABLE IF NOT EXISTS ticktick_habits (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT DEFAULT 'check',
  color TEXT NOT NULL DEFAULT '#4a90d9',
  goal_description TEXT DEFAULT '',
  frequency TEXT DEFAULT 'daily' CHECK(frequency IN ('daily','weekly')),
  target_count INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ticktick_habit_logs (
  id TEXT PRIMARY KEY,
  habit_id TEXT NOT NULL,
  log_date TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 1,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (habit_id) REFERENCES ticktick_habits(id) ON DELETE CASCADE,
  UNIQUE(habit_id, log_date)
);

CREATE INDEX IF NOT EXISTS idx_habit_logs_habit ON ticktick_habit_logs(habit_id);
CREATE INDEX IF NOT EXISTS idx_habit_logs_date ON ticktick_habit_logs(log_date);
`;
