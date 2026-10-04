PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE _migrations (
      id         INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
INSERT INTO _migrations VALUES(1,'2026-10-04T17:21:02.302Z');
INSERT INTO _migrations VALUES(2,'2026-10-04T17:21:02.303Z');
INSERT INTO _migrations VALUES(3,'2026-10-04T17:21:02.303Z');
INSERT INTO _migrations VALUES(4,'2026-10-04T17:21:02.304Z');
INSERT INTO _migrations VALUES(5,'2026-10-04T17:21:02.304Z');
INSERT INTO _migrations VALUES(6,'2026-10-04T17:21:02.306Z');
INSERT INTO _migrations VALUES(7,'2026-10-04T17:21:02.307Z');
INSERT INTO _migrations VALUES(8,'2026-10-04T17:21:02.307Z');
INSERT INTO _migrations VALUES(9,'2026-10-04T17:21:02.308Z');
INSERT INTO _migrations VALUES(10,'2026-10-04T17:21:02.309Z');
CREATE TABLE workspaces (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
INSERT INTO workspaces VALUES('ws-pilot-a','pilot-a','2026-10-04T17:21:02.309Z');
CREATE TABLE projects (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name         TEXT NOT NULL,
    description  TEXT,
    status       TEXT NOT NULL CHECK(status IN ('active','paused','archived')),
    priority     INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
INSERT INTO projects VALUES('proj-pilot-a','ws-pilot-a','student-platform',NULL,'active',0,'2026-10-04T17:21:02.309Z','2026-10-04T17:21:02.309Z');
CREATE TABLE repositories (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id),
    provider        TEXT NOT NULL CHECK(provider IN ('github')),
    remote          TEXT NOT NULL,
    default_branch  TEXT NOT NULL,
    local_workspace TEXT,
    status          TEXT NOT NULL CHECK(status IN ('active','disabled'))
  );
CREATE TABLE objectives (
    id                   TEXT PRIMARY KEY,
    project_id           TEXT NOT NULL REFERENCES projects(id),
    title                TEXT NOT NULL,
    description          TEXT NOT NULL,
    priority             INTEGER NOT NULL DEFAULT 0,
    status               TEXT NOT NULL CHECK(status IN ('draft','active','completed','cancelled')),
    constraints_json     TEXT NOT NULL DEFAULT '[]',
    success_criteria_json TEXT NOT NULL DEFAULT '[]'
  , created_at TEXT, updated_at TEXT);
INSERT INTO objectives VALUES('obj-108','proj-pilot-a','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage',replace('## Summary\n\nWorker and API disagree on the failure payload keys, so every failure persists as a generic "Processing failed" with no stage.\n\n- Worker publishes `{"error": str(e)}`:\n  `apps/ai-server/rag-worker-service/main.py:1097`\n- rag-api''s failed branch reads different keys:\n  `apps/ai-server/rag-api-service/main.py:223-226`\n\n```python\nmain_update["error"] = details.get("error_message", "Processing failed")\nmain_update["error_stage"] = details.get("stage")\nmain_update["retryable"] = details.get("retryable", True)\n```\n\nResult: `error` persists as the fallback string, `error_stage` is `None`, and `retryable` silently defaults to `True` even though the worker never sends it.\n\n## Impact\n\nFailures are undisambiguatable from the persisted record — users and support cannot tell what failed or where, and retry semantics are fabricated rather than reported.\n\n## Acceptance criteria\n\n- [ ] Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).\n- [ ] A failed job persists the worker''s actual error message and failing stage.\n- [ ] `retryable` is either sent by the worker or derived deliberately — not defaulted silently.\n- [ ] Contract test covering worker failure → rag-api persistence path.\n\n_(Salvaged from #57''s task cards after maintainer triage; see also the D3 issue filed alongside this one. Original analysis recorded in plans/upload-flow.md as deviation D4.)_','\n',char(10)),0,'active','[]','["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','2026-10-04T17:21:02.309Z','2026-10-04T17:21:02.309Z');
CREATE TABLE work_items (
    id                    TEXT PRIMARY KEY,
    project_id            TEXT NOT NULL REFERENCES projects(id),
    objective_id          TEXT REFERENCES objectives(id),
    repository_ids_json   TEXT NOT NULL DEFAULT '[]',
    title                 TEXT NOT NULL,
    goal                  TEXT NOT NULL,
    workflow_id           TEXT NOT NULL,
    state                 TEXT NOT NULL,
    priority              INTEGER NOT NULL DEFAULT 0,
    acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
    constraints_json      TEXT NOT NULL DEFAULT '[]',
    required_evidence_json TEXT NOT NULL DEFAULT '[]',
    parent_id             TEXT REFERENCES work_items(id),
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
  , workflow_parameters_json TEXT);
INSERT INTO work_items VALUES('wi-define-108-a8','proj-pilot-a','obj-108','[]','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','define-work','completed',0,'["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','[]','[]',NULL,'2026-10-04T17:21:02.309Z','2026-09-21T14:39:56.875Z',NULL);
INSERT INTO work_items VALUES('wi-exec-108','proj-pilot-a','obj-108','[]','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','full-build','failed',0,'["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','[]','[]',NULL,'2026-10-04T17:21:02.718Z','2026-10-04T18:22:56.942Z','{"planning_depth":"minimal","max_iterations":5,"on_cap_hit":"halt","definitionSource":{"workItemId":"wi-define-108-a8"},"editPolicy":{"appliesToSteps":["build"],"allowedEditPaths":["apps/ai-server/rag-worker-service/main.py"],"requiredEditPaths":["apps/ai-server/rag-worker-service/main.py"]}}');
CREATE TABLE work_dependencies (
    work_item_id TEXT NOT NULL REFERENCES work_items(id),
    depends_on_id TEXT NOT NULL REFERENCES work_items(id),
    PRIMARY KEY (work_item_id, depends_on_id),
    CHECK(work_item_id != depends_on_id)
  );
INSERT INTO work_dependencies VALUES('wi-exec-108','wi-define-108-a8');
CREATE TABLE decisions (
    id                    TEXT PRIMARY KEY,
    project_id            TEXT NOT NULL REFERENCES projects(id),
    work_item_id          TEXT REFERENCES work_items(id),
    type                  TEXT NOT NULL,
    subject_ref_json      TEXT NOT NULL,
    title                 TEXT NOT NULL,
    summary               TEXT NOT NULL,
    options_json          TEXT NOT NULL DEFAULT '[]',
    recommended_option_id TEXT,
    recommendation_reason TEXT,
    impact                TEXT NOT NULL CHECK(impact IN ('low','medium','high','critical')),
    reversibility         TEXT NOT NULL CHECK(reversibility IN ('easy','medium','hard','irreversible')),
    urgency               TEXT NOT NULL CHECK(urgency IN ('normal','blocking','urgent')),
    status                TEXT NOT NULL CHECK(status IN ('pending','resolved','expired','cancelled')),
    resolution_json       TEXT
  );
INSERT INTO decisions VALUES('ce074f7e-2f21-402f-be61-cd47e7a2babe','proj-pilot-a','wi-exec-108','checkpoint','{"workflowRunId":"afc18a5b-f04f-49c6-a9c7-4f3f856203ea","workItemId":"wi-exec-108","stepId":"scoping.checkpoint"}','Workflow reached a checkpoint','Workflow ''full-build'' paused at step ''scoping.checkpoint'' and requires operator approval to continue.','[{"id":"approve","label":"Approve","description":"Accept the cycle charter and begin the cycle"}]','approve',NULL,'medium','easy','normal','resolved','{"selectedOptionId":"approve","rationale":"V10-2 preregistered operator checkpoint: charter accepted under frozen preregistration e997a4ee (BUILD effort=medium)","resolvedAt":"2026-10-04T17:31:10.532Z","resolvedBy":"operator"}');
INSERT INTO decisions VALUES('f8889ead-1914-49e0-b6ba-afa1835349bb','proj-pilot-a','wi-exec-108','checkpoint','{"workflowRunId":"afc18a5b-f04f-49c6-a9c7-4f3f856203ea","workItemId":"wi-exec-108","stepId":"confirm"}','Workflow reached another checkpoint','Workflow ''full-build'' paused at step ''confirm''.','[{"id":"approve","label":"Approve","description":"Continue to the build phase"},{"id":"revise","label":"Revise","description":"Send back for revision (increments revision counter)"}]','approve',NULL,'medium','easy','normal','resolved','{"selectedOptionId":"approve","rationale":"V10-2 operator confirm checkpoint: TEST cleared; authorizing BUILD 16384+medium treatment under frozen preregistration e997a4ee","resolvedAt":"2026-10-04T18:16:29.058Z","resolvedBy":"operator"}');
CREATE TABLE policies (
    project_id  TEXT PRIMARY KEY REFERENCES projects(id),
    config_json TEXT NOT NULL
  );
CREATE TABLE evidence (
    id                TEXT PRIMARY KEY,
    work_item_id      TEXT NOT NULL REFERENCES work_items(id),
    step_execution_id TEXT REFERENCES step_executions(id),
    type              TEXT NOT NULL,
    source            TEXT NOT NULL,
    subject_ref       TEXT,
    status            TEXT NOT NULL CHECK(status IN ('passed','failed','informational')),
    payload_json      TEXT NOT NULL,
    collected_at      TEXT NOT NULL
  , candidate_ref TEXT, collector_id  TEXT);
CREATE TABLE artifacts (
    id                TEXT PRIMARY KEY,
    work_item_id      TEXT REFERENCES work_items(id),
    workflow_run_id   TEXT,
    step_execution_id TEXT REFERENCES step_executions(id),
    type              TEXT NOT NULL,
    ref               TEXT,
    path              TEXT,
    hash              TEXT,
    created_at        TEXT NOT NULL
  );
INSERT INTO artifacts VALUES('1aeb5d03-b197-4f52-b367-ee9d331717be','wi-define-108-a8','23a3141f-2f93-49f5-99e7-02c59b346723',NULL,'definition','definition:obj-108','.sle/work/wi-define-108-a8/definition.md','71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5','2026-09-21T14:38:16.394Z');
INSERT INTO artifacts VALUES('d8c4f59a-3262-4b2d-9e1d-c078b5bb8501','wi-define-108-a8','23a3141f-2f93-49f5-99e7-02c59b346723',NULL,'definition-readiness','definition-readiness:obj-108','.sle/work/wi-define-108-a8/readiness.md','b5a96b175f5b67fbe697d6fa32ed58081070d1cfa47089c7b812c60bf495d2b7','2026-09-21T14:39:56.860Z');
INSERT INTO artifacts VALUES('033e0ef3-d159-4013-a5cc-6eeb8b46cbbf','wi-exec-108','afc18a5b-f04f-49c6-a9c7-4f3f856203ea',NULL,'cycle-charter','doc:cycle-charter','docs/cycle-charter.md','ca6a91850dfa963adfa6c70b59601b15b2454e3188855d88a56a0165a0ce2e8b','2026-10-04T17:23:53.972Z');
INSERT INTO artifacts VALUES('1952bb12-9d2f-4cb1-970a-6e34e2e7adbe','wi-exec-108','afc18a5b-f04f-49c6-a9c7-4f3f856203ea',NULL,'produced-file','produced-file:design:docs/requirements.md','docs/requirements.md','f5187fc9436956a6d1938316d316b053c111697d5ff403abdf92cd5a02aef7c5','2026-10-04T17:50:01.209Z');
INSERT INTO artifacts VALUES('efd4451e-033b-47ea-8e97-007643f9184d','wi-exec-108','afc18a5b-f04f-49c6-a9c7-4f3f856203ea',NULL,'produced-file','produced-file:design:docs/architecture.md','docs/architecture.md','f4327130a996d0c0799f8e476a7935ddf17ac843ba3ac92ff6dbff222df07d63','2026-10-04T17:50:01.209Z');
INSERT INTO artifacts VALUES('25fb6b3b-6156-4922-8b90-ca09e8ca1489','wi-exec-108','afc18a5b-f04f-49c6-a9c7-4f3f856203ea',NULL,'produced-file','produced-file:plan:docs/plan.md','docs/plan.md','e3ad80109fd60bad8edab7b976f3e85ba7570ea04fac266cee3f9b284bd2bd03','2026-10-04T18:00:05.946Z');
INSERT INTO artifacts VALUES('9ad59411-cc6e-4a1a-99df-c22ca152689e','wi-exec-108','afc18a5b-f04f-49c6-a9c7-4f3f856203ea',NULL,'produced-file','produced-file:plan:docs/test-plan.md','docs/test-plan.md','e3ad80109fd60bad8edab7b976f3e85ba7570ea04fac266cee3f9b284bd2bd03','2026-10-04T18:00:05.946Z');
INSERT INTO artifacts VALUES('d6500b74-5455-4e90-9999-dacfbc0b1cff','wi-exec-108','afc18a5b-f04f-49c6-a9c7-4f3f856203ea',NULL,'produced-file','produced-file:test:apps/ai-server/tests/integration/test_worker_failure_payload_contract.py','apps/ai-server/tests/integration/test_worker_failure_payload_contract.py','2a9243fc8b34d12350e57138daf4126d46fef69ab747b41750544fb1b7dced4a','2026-10-04T18:07:54.278Z');
CREATE TABLE events (
    id              TEXT PRIMARY KEY,
    schema_version  INTEGER NOT NULL DEFAULT 1 CHECK(schema_version = 1),
    type            TEXT NOT NULL,
    workspace_id    TEXT NOT NULL,
    project_id      TEXT,
    work_item_id    TEXT,
    workflow_run_id TEXT,
    occurred_at     TEXT NOT NULL,
    payload_json    TEXT NOT NULL
  );
INSERT INTO events VALUES('995223b6-4fce-4dd5-8981-d67b0e362870',1,'work.started','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-04T17:21:03.150Z','{"from":"running","to":"running"}');
INSERT INTO events VALUES('ece7b25e-a129-4160-aec1-82f972be56fc',1,'decision.requested','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-04T17:23:53.992Z','{"from":"needs_decision","decisionId":"ce074f7e-2f21-402f-be61-cd47e7a2babe","decisionType":"checkpoint"}');
INSERT INTO events VALUES('9923ef4b-7990-43d4-8668-c88dde39a76c',1,'decision.resolved','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-04T17:31:10.555Z','{"from":"running","decisionId":"ce074f7e-2f21-402f-be61-cd47e7a2babe","selectedOptionId":"approve","resumedTo":"running"}');
INSERT INTO events VALUES('7fd37260-dbbf-4f7b-9478-fcf106d1eb55',1,'decision.requested','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-04T18:07:54.294Z','{"from":"needs_decision","decisionId":"f8889ead-1914-49e0-b6ba-afa1835349bb","decisionType":"checkpoint"}');
INSERT INTO events VALUES('c6a61ec9-a974-41bc-9cfe-3e6caf1ccfea',1,'decision.resolved','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-04T18:16:29.077Z','{"from":"running","decisionId":"f8889ead-1914-49e0-b6ba-afa1835349bb","selectedOptionId":"approve","resumedTo":"running"}');
INSERT INTO events VALUES('98fd2a65-3de7-4afb-a0bd-459364a0410e',1,'work.state_changed','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-04T18:22:56.942Z','{"from":"failed","to":"failed","reason":"Agent exhausted max_tokens without producing a result block"}');
CREATE TABLE scheduler_leases (
    id            TEXT PRIMARY KEY,
    work_item_id  TEXT NOT NULL REFERENCES work_items(id),
    repository_id TEXT,
    lease_type    TEXT NOT NULL CHECK(lease_type IN ('write', 'read')),
    acquired_at   TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    heartbeat_at  TEXT NOT NULL
  );
CREATE TABLE api_tokens (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    created_at   TEXT NOT NULL,
    expires_at   TEXT,
    last_used_at TEXT,
    revoked_at   TEXT
  );
CREATE TABLE audit_events (
    id            TEXT PRIMARY KEY,
    token_id      TEXT REFERENCES api_tokens(id),
    action        TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id   TEXT NOT NULL,
    details_json  TEXT,
    ip_address    TEXT,
    occurred_at   TEXT NOT NULL
  );
CREATE TABLE notification_channels (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL CHECK(type IN ('webhook')),
    config_json TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL
  );
CREATE TABLE IF NOT EXISTS "step_executions" (
    id              TEXT PRIMARY KEY,
    work_item_id    TEXT NOT NULL REFERENCES work_items(id),
    workflow_run_id TEXT NOT NULL,
    step_id         TEXT NOT NULL,
    executor        TEXT NOT NULL,
    state           TEXT NOT NULL CHECK(state IN
                      ('dispatched','running','succeeded','failed','cancelled','waiting')),
    attempt         INTEGER NOT NULL DEFAULT 1 CHECK(attempt >= 1),
    started_at      TEXT,
    completed_at    TEXT,
    cost_json       TEXT,
    tokens          INTEGER,
    failure_json    TEXT
  );
INSERT INTO step_executions VALUES('209ce7bf-2a25-40d9-bd8a-de4cceda7d5e','wi-exec-108','afc18a5b-f04f-49c6-a9c7-4f3f856203ea','__start__','stratum-agent','succeeded',1,'2026-10-04T17:21:03.149Z','2026-10-04T17:31:10.533Z',NULL,NULL,NULL);
INSERT INTO step_executions VALUES('1cb4fc68-4916-49f3-8622-7f94c8117504','wi-exec-108','afc18a5b-f04f-49c6-a9c7-4f3f856203ea','design','stratum-agent','succeeded',1,'2026-10-04T17:31:10.533Z','2026-10-04T18:16:29.059Z',NULL,NULL,NULL);
INSERT INTO step_executions VALUES('7aa44004-2fc8-4cd4-9ab3-183428ce3ef6','wi-exec-108','afc18a5b-f04f-49c6-a9c7-4f3f856203ea','build','stratum-agent','failed',1,'2026-10-04T18:16:29.059Z','2026-10-04T18:22:56.941Z',NULL,NULL,'{"code":"workflow_error","message":"Agent exhausted max_tokens without producing a result block"}');
CREATE TABLE IF NOT EXISTS "workflow_runs" (
    run_id              TEXT PRIMARY KEY,
    workflow_id         TEXT NOT NULL,
    work_item_id        TEXT REFERENCES work_items(id),
    status              TEXT NOT NULL CHECK(status IN ('active','halted','complete')),
    current_step_id     TEXT NOT NULL,
    iteration           INTEGER NOT NULL DEFAULT 1,
    revision            INTEGER NOT NULL DEFAULT 0,
    awaiting_checkpoint TEXT,
    started_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
  , resolved_parameters_json TEXT);
INSERT INTO workflow_runs VALUES('23a3141f-2f93-49f5-99e7-02c59b346723','define-work','wi-define-108-a8','complete','commit',1,0,NULL,'2026-09-21T14:31:55.971Z','2026-09-21T14:39:56.865Z','{}');
INSERT INTO workflow_runs VALUES('afc18a5b-f04f-49c6-a9c7-4f3f856203ea','full-build','wi-exec-108','halted','build',1,0,NULL,'2026-10-04T17:21:03.156Z','2026-10-04T18:22:56.941Z','{"planning_depth":"minimal","max_iterations":5,"on_cap_hit":"halt","definitionSource":{"workItemId":"wi-define-108-a8"}}');
CREATE TABLE checkpoint_applications (
    decision_id          TEXT PRIMARY KEY REFERENCES decisions(id),
    workflow_run_id      TEXT NOT NULL REFERENCES workflow_runs(run_id),
    workflow_id          TEXT NOT NULL,
    step_id              TEXT NOT NULL,
    iteration            INTEGER NOT NULL,
    revision_before      INTEGER NOT NULL,
    selected_option_id   TEXT NOT NULL,
    rationale            TEXT,
    state                TEXT NOT NULL CHECK(state IN ('applying','applied')),
    continuation_step_id TEXT,
    remain_at_checkpoint INTEGER NOT NULL DEFAULT 0,
    increment_revision   INTEGER NOT NULL DEFAULT 0,
    cancel               INTEGER NOT NULL DEFAULT 0,
    started_at           TEXT NOT NULL,
    applied_at           TEXT
  );
INSERT INTO checkpoint_applications VALUES('ce074f7e-2f21-402f-be61-cd47e7a2babe','afc18a5b-f04f-49c6-a9c7-4f3f856203ea','full-build','scoping.checkpoint',1,0,'approve','V10-2 preregistered operator checkpoint: charter accepted under frozen preregistration e997a4ee (BUILD effort=medium)','applied','design',0,0,0,'2026-10-04T17:31:10.536Z','2026-10-04T17:31:10.554Z');
INSERT INTO checkpoint_applications VALUES('f8889ead-1914-49e0-b6ba-afa1835349bb','afc18a5b-f04f-49c6-a9c7-4f3f856203ea','full-build','confirm',1,0,'approve','V10-2 operator confirm checkpoint: TEST cleared; authorizing BUILD 16384+medium treatment under frozen preregistration e997a4ee','applied','build',0,0,0,'2026-10-04T18:16:29.061Z','2026-10-04T18:16:29.076Z');
CREATE INDEX idx_projects_workspace      ON projects(workspace_id);
CREATE INDEX idx_repositories_project    ON repositories(project_id);
CREATE INDEX idx_objectives_project      ON objectives(project_id);
CREATE INDEX idx_work_items_project      ON work_items(project_id);
CREATE INDEX idx_work_items_state        ON work_items(state);
CREATE INDEX idx_decisions_project       ON decisions(project_id);
CREATE INDEX idx_decisions_work_item     ON decisions(work_item_id);
CREATE INDEX idx_decisions_status        ON decisions(status);
CREATE INDEX idx_evidence_work_item      ON evidence(work_item_id);
CREATE INDEX idx_events_workspace        ON events(workspace_id);
CREATE INDEX idx_events_work_item        ON events(work_item_id);
CREATE INDEX idx_events_occurred_at      ON events(occurred_at);
CREATE INDEX idx_events_type             ON events(type);
CREATE INDEX idx_scheduler_leases_repo      ON scheduler_leases(repository_id, lease_type);
CREATE INDEX idx_scheduler_leases_work_item ON scheduler_leases(work_item_id);
CREATE INDEX idx_scheduler_leases_expires   ON scheduler_leases(expires_at);
CREATE INDEX idx_audit_events_occurred_at ON audit_events(occurred_at);
CREATE INDEX idx_audit_events_resource    ON audit_events(resource_type, resource_id);
CREATE INDEX idx_audit_events_token       ON audit_events(token_id);
CREATE INDEX idx_step_executions_wi  ON step_executions(work_item_id);
CREATE INDEX idx_step_executions_run ON step_executions(workflow_run_id);
CREATE INDEX idx_workflow_runs_work_item ON workflow_runs(work_item_id);
CREATE INDEX idx_workflow_runs_status    ON workflow_runs(status);
CREATE INDEX idx_checkpoint_applications_run ON checkpoint_applications(workflow_run_id);
COMMIT;
