PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE _migrations (
      id         INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
INSERT INTO _migrations VALUES(1,'2026-09-30T11:39:13.698Z');
INSERT INTO _migrations VALUES(2,'2026-09-30T11:39:13.699Z');
INSERT INTO _migrations VALUES(3,'2026-09-30T11:39:13.699Z');
INSERT INTO _migrations VALUES(4,'2026-09-30T11:39:13.699Z');
INSERT INTO _migrations VALUES(5,'2026-09-30T11:39:13.700Z');
INSERT INTO _migrations VALUES(6,'2026-09-30T11:39:13.701Z');
INSERT INTO _migrations VALUES(7,'2026-09-30T11:39:13.702Z');
INSERT INTO _migrations VALUES(8,'2026-09-30T11:39:13.702Z');
INSERT INTO _migrations VALUES(9,'2026-09-30T11:39:13.703Z');
INSERT INTO _migrations VALUES(10,'2026-09-30T11:39:13.703Z');
CREATE TABLE workspaces (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
INSERT INTO workspaces VALUES('ws-pilot-a','pilot-a','2026-09-30T11:39:13.703Z');
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
INSERT INTO projects VALUES('proj-pilot-a','ws-pilot-a','student-platform',NULL,'active',0,'2026-09-30T11:39:13.703Z','2026-09-30T11:39:13.703Z');
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
INSERT INTO objectives VALUES('obj-108','proj-pilot-a','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage',replace('## Summary\n\nWorker and API disagree on the failure payload keys, so every failure persists as a generic "Processing failed" with no stage.\n\n- Worker publishes `{"error": str(e)}`:\n  `apps/ai-server/rag-worker-service/main.py:1097`\n- rag-api''s failed branch reads different keys:\n  `apps/ai-server/rag-api-service/main.py:223-226`\n\n```python\nmain_update["error"] = details.get("error_message", "Processing failed")\nmain_update["error_stage"] = details.get("stage")\nmain_update["retryable"] = details.get("retryable", True)\n```\n\nResult: `error` persists as the fallback string, `error_stage` is `None`, and `retryable` silently defaults to `True` even though the worker never sends it.\n\n## Impact\n\nFailures are undisambiguatable from the persisted record — users and support cannot tell what failed or where, and retry semantics are fabricated rather than reported.\n\n## Acceptance criteria\n\n- [ ] Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).\n- [ ] A failed job persists the worker''s actual error message and failing stage.\n- [ ] `retryable` is either sent by the worker or derived deliberately — not defaulted silently.\n- [ ] Contract test covering worker failure → rag-api persistence path.\n\n_(Salvaged from #57''s task cards after maintainer triage; see also the D3 issue filed alongside this one. Original analysis recorded in plans/upload-flow.md as deviation D4.)_','\n',char(10)),0,'active','[]','["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','2026-09-30T11:39:13.703Z','2026-09-30T11:39:13.703Z');
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
INSERT INTO work_items VALUES('wi-define-108-a8','proj-pilot-a','obj-108','[]','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','define-work','completed',0,'["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','[]','[]',NULL,'2026-09-30T11:39:13.703Z','2026-09-21T14:39:56.875Z',NULL);
INSERT INTO work_items VALUES('wi-exec-108','proj-pilot-a','obj-108','[]','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','full-build','failed',0,'["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','[]','[]',NULL,'2026-09-30T11:39:13.992Z','2026-09-30T13:19:15.076Z','{"planning_depth":"minimal","max_iterations":5,"on_cap_hit":"halt","definitionSource":{"workItemId":"wi-define-108-a8"},"editPolicy":{"appliesToSteps":["build"],"allowedEditPaths":["apps/ai-server/rag-worker-service/main.py"],"requiredEditPaths":["apps/ai-server/rag-worker-service/main.py"]}}');
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
INSERT INTO decisions VALUES('13c687b8-3865-4f0a-b5e7-d4473d1d40b9','proj-pilot-a','wi-exec-108','checkpoint','{"workflowRunId":"847bb303-de95-4853-80e9-8bc63f7f4199","workItemId":"wi-exec-108","stepId":"scoping.checkpoint"}','Workflow reached a checkpoint','Workflow ''full-build'' paused at step ''scoping.checkpoint'' and requires operator approval to continue.','[{"id":"approve","label":"Approve","description":"Accept the cycle charter and begin the cycle"}]','approve',NULL,'medium','easy','normal','resolved','{"selectedOptionId":"approve","rationale":"V5-2 preregistered operator checkpoint: charter accepted under frozen preregistration dccf6f98 (baseline cf4926be, design budget 32768)","resolvedAt":"2026-09-30T11:56:26.591Z","resolvedBy":"operator"}');
INSERT INTO decisions VALUES('a1f00920-de67-4d8e-8564-f1f15aa5d1b5','proj-pilot-a','wi-exec-108','checkpoint','{"workflowRunId":"847bb303-de95-4853-80e9-8bc63f7f4199","workItemId":"wi-exec-108","stepId":"confirm"}','Workflow reached another checkpoint','Workflow ''full-build'' paused at step ''confirm''.','[{"id":"approve","label":"Approve","description":"Continue to the build phase"},{"id":"revise","label":"Revise","description":"Send back for revision (increments revision counter)"}]','approve',NULL,'medium','easy','normal','resolved','{"selectedOptionId":"approve","rationale":"V5-2 preregistered operator confirm checkpoint: proceeding to build under frozen preregistration dccf6f98","resolvedAt":"2026-09-30T13:13:03.790Z","resolvedBy":"operator"}');
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
INSERT INTO artifacts VALUES('6c1b7077-d0e0-471e-a858-cbc788ff4ac3','wi-exec-108','847bb303-de95-4853-80e9-8bc63f7f4199',NULL,'cycle-charter','doc:cycle-charter','docs/cycle-charter.md','8df47271350332eae92b4dd3897f2d0923282c0fe896dc85f80f2526b3758e11','2026-09-30T11:49:44.942Z');
INSERT INTO artifacts VALUES('ae8b52e2-f63a-43a3-ae4d-f2e3ef126a93','wi-exec-108','847bb303-de95-4853-80e9-8bc63f7f4199',NULL,'produced-file','produced-file:design:docs/requirements.md','docs/requirements.md','d42719f7d598b1fb9024cd6a779170b7dc334f08573f263d13ab175182566ef8','2026-09-30T12:15:10.693Z');
INSERT INTO artifacts VALUES('a61a4ecd-f520-43a8-92f8-57397094558c','wi-exec-108','847bb303-de95-4853-80e9-8bc63f7f4199',NULL,'produced-file','produced-file:design:docs/architecture.md','docs/architecture.md','7d8db7f146a38d7ea64a29aea506bccd48bdaa8e6481ec3c4b718313f9067fbf','2026-09-30T12:15:10.700Z');
INSERT INTO artifacts VALUES('df7c7016-d40b-48f9-8370-6c4219f17670','wi-exec-108','847bb303-de95-4853-80e9-8bc63f7f4199',NULL,'produced-file','produced-file:plan:docs/plan.md','docs/plan.md','abd3da0d3888862018401dcc3be568fe85ef131dee0a4efaab6c4b0569e083ea','2026-09-30T12:29:20.703Z');
INSERT INTO artifacts VALUES('0519a62f-5e36-4ebd-a30b-be7a4b0edeb1','wi-exec-108','847bb303-de95-4853-80e9-8bc63f7f4199',NULL,'produced-file','produced-file:plan:docs/test-plan.md','docs/test-plan.md','9860eab654462e3984c5e94ac688323c705b8afeb1cf90efbb56bbdc24a5184c','2026-09-30T12:29:20.703Z');
INSERT INTO artifacts VALUES('52a76485-3078-4de5-85f3-1684e0042b1b','wi-exec-108','847bb303-de95-4853-80e9-8bc63f7f4199',NULL,'produced-file','produced-file:test:apps/ai-server/tests/integration/test_failure_payload_contract.py','apps/ai-server/tests/integration/test_failure_payload_contract.py','5d75ee2ac9a9199caf2e42d42dca98184e95eba95bc8549ed327c43c14833bf3','2026-09-30T12:59:59.530Z');
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
INSERT INTO events VALUES('3a015b3f-ae40-4d66-bad6-f2ee1d779121',1,'work.started','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-09-30T11:39:14.312Z','{"from":"running","to":"running"}');
INSERT INTO events VALUES('73287c18-486b-4c18-9a52-b3c5abca9589',1,'decision.requested','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-09-30T11:49:44.963Z','{"from":"needs_decision","decisionId":"13c687b8-3865-4f0a-b5e7-d4473d1d40b9","decisionType":"checkpoint"}');
INSERT INTO events VALUES('34b11f60-cb0d-40c0-88a9-c1999e361430',1,'decision.resolved','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-09-30T11:56:26.607Z','{"from":"running","decisionId":"13c687b8-3865-4f0a-b5e7-d4473d1d40b9","selectedOptionId":"approve","resumedTo":"running"}');
INSERT INTO events VALUES('6ff7a8e3-1367-4e9d-8b7c-0b916b5409e0',1,'decision.requested','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-09-30T12:59:59.546Z','{"from":"needs_decision","decisionId":"a1f00920-de67-4d8e-8564-f1f15aa5d1b5","decisionType":"checkpoint"}');
INSERT INTO events VALUES('9d36b410-84b6-4f9e-a682-9a8457b74630',1,'decision.resolved','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-09-30T13:13:03.808Z','{"from":"running","decisionId":"a1f00920-de67-4d8e-8564-f1f15aa5d1b5","selectedOptionId":"approve","resumedTo":"running"}');
INSERT INTO events VALUES('1c57485a-8229-4f59-b63a-9aec74c27ce5',1,'work.state_changed','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-09-30T13:19:15.076Z','{"from":"failed","to":"failed","reason":"Agent exhausted max_tokens without producing a result block"}');
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
INSERT INTO step_executions VALUES('86d65002-eb71-4b4c-9d30-baa7502611e8','wi-exec-108','847bb303-de95-4853-80e9-8bc63f7f4199','__start__','stratum-agent','succeeded',1,'2026-09-30T11:39:14.311Z','2026-09-30T11:56:26.591Z',NULL,NULL,NULL);
INSERT INTO step_executions VALUES('6e148922-e8cc-48be-b120-0fce02519c42','wi-exec-108','847bb303-de95-4853-80e9-8bc63f7f4199','design','stratum-agent','succeeded',1,'2026-09-30T11:56:26.591Z','2026-09-30T13:13:03.791Z',NULL,NULL,NULL);
INSERT INTO step_executions VALUES('c1992807-f3a3-486b-90cc-9e862aa3abc3','wi-exec-108','847bb303-de95-4853-80e9-8bc63f7f4199','build','stratum-agent','failed',1,'2026-09-30T13:13:03.791Z','2026-09-30T13:19:15.076Z',NULL,NULL,'{"code":"workflow_error","message":"Agent exhausted max_tokens without producing a result block"}');
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
INSERT INTO workflow_runs VALUES('847bb303-de95-4853-80e9-8bc63f7f4199','full-build','wi-exec-108','halted','build',1,0,NULL,'2026-09-30T11:39:14.320Z','2026-09-30T13:19:15.075Z','{"planning_depth":"minimal","max_iterations":5,"on_cap_hit":"halt","definitionSource":{"workItemId":"wi-define-108-a8"}}');
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
INSERT INTO checkpoint_applications VALUES('13c687b8-3865-4f0a-b5e7-d4473d1d40b9','847bb303-de95-4853-80e9-8bc63f7f4199','full-build','scoping.checkpoint',1,0,'approve','V5-2 preregistered operator checkpoint: charter accepted under frozen preregistration dccf6f98 (baseline cf4926be, design budget 32768)','applied','design',0,0,0,'2026-09-30T11:56:26.593Z','2026-09-30T11:56:26.606Z');
INSERT INTO checkpoint_applications VALUES('a1f00920-de67-4d8e-8564-f1f15aa5d1b5','847bb303-de95-4853-80e9-8bc63f7f4199','full-build','confirm',1,0,'approve','V5-2 preregistered operator confirm checkpoint: proceeding to build under frozen preregistration dccf6f98','applied','build',0,0,0,'2026-09-30T13:13:03.794Z','2026-09-30T13:13:03.807Z');
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
