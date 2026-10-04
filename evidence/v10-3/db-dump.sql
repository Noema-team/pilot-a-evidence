PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE _migrations (
      id         INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
INSERT INTO _migrations VALUES(1,'2026-10-04T18:32:09.794Z');
INSERT INTO _migrations VALUES(2,'2026-10-04T18:32:09.795Z');
INSERT INTO _migrations VALUES(3,'2026-10-04T18:32:09.795Z');
INSERT INTO _migrations VALUES(4,'2026-10-04T18:32:09.796Z');
INSERT INTO _migrations VALUES(5,'2026-10-04T18:32:09.796Z');
INSERT INTO _migrations VALUES(6,'2026-10-04T18:32:09.799Z');
INSERT INTO _migrations VALUES(7,'2026-10-04T18:32:09.799Z');
INSERT INTO _migrations VALUES(8,'2026-10-04T18:32:09.800Z');
INSERT INTO _migrations VALUES(9,'2026-10-04T18:32:09.801Z');
INSERT INTO _migrations VALUES(10,'2026-10-04T18:32:09.801Z');
CREATE TABLE workspaces (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
INSERT INTO workspaces VALUES('ws-pilot-a','pilot-a','2026-10-04T18:32:09.801Z');
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
INSERT INTO projects VALUES('proj-pilot-a','ws-pilot-a','student-platform',NULL,'active',0,'2026-10-04T18:32:09.801Z','2026-10-04T18:32:09.801Z');
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
INSERT INTO objectives VALUES('obj-108','proj-pilot-a','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage',replace('## Summary\n\nWorker and API disagree on the failure payload keys, so every failure persists as a generic "Processing failed" with no stage.\n\n- Worker publishes `{"error": str(e)}`:\n  `apps/ai-server/rag-worker-service/main.py:1097`\n- rag-api''s failed branch reads different keys:\n  `apps/ai-server/rag-api-service/main.py:223-226`\n\n```python\nmain_update["error"] = details.get("error_message", "Processing failed")\nmain_update["error_stage"] = details.get("stage")\nmain_update["retryable"] = details.get("retryable", True)\n```\n\nResult: `error` persists as the fallback string, `error_stage` is `None`, and `retryable` silently defaults to `True` even though the worker never sends it.\n\n## Impact\n\nFailures are undisambiguatable from the persisted record — users and support cannot tell what failed or where, and retry semantics are fabricated rather than reported.\n\n## Acceptance criteria\n\n- [ ] Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).\n- [ ] A failed job persists the worker''s actual error message and failing stage.\n- [ ] `retryable` is either sent by the worker or derived deliberately — not defaulted silently.\n- [ ] Contract test covering worker failure → rag-api persistence path.\n\n_(Salvaged from #57''s task cards after maintainer triage; see also the D3 issue filed alongside this one. Original analysis recorded in plans/upload-flow.md as deviation D4.)_','\n',char(10)),0,'active','[]','["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','2026-10-04T18:32:09.801Z','2026-10-04T18:32:09.801Z');
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
INSERT INTO work_items VALUES('wi-define-108-a8','proj-pilot-a','obj-108','[]','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','define-work','completed',0,'["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','[]','[]',NULL,'2026-10-04T18:32:09.801Z','2026-09-21T14:39:56.875Z',NULL);
INSERT INTO work_items VALUES('wi-exec-108','proj-pilot-a','obj-108','[]','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','full-build','failed',0,'["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','[]','[]',NULL,'2026-10-04T18:32:10.098Z','2026-10-04T19:25:23.053Z','{"planning_depth":"minimal","max_iterations":5,"on_cap_hit":"halt","definitionSource":{"workItemId":"wi-define-108-a8"},"editPolicy":{"appliesToSteps":["build"],"allowedEditPaths":["apps/ai-server/rag-worker-service/main.py"],"requiredEditPaths":["apps/ai-server/rag-worker-service/main.py"]}}');
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
INSERT INTO decisions VALUES('3f34d05b-0991-4142-a45f-564a464967fb','proj-pilot-a','wi-exec-108','checkpoint','{"workflowRunId":"a5671743-a862-47ad-9afd-68be70591486","workItemId":"wi-exec-108","stepId":"scoping.checkpoint"}','Workflow reached a checkpoint','Workflow ''full-build'' paused at step ''scoping.checkpoint'' and requires operator approval to continue.','[{"id":"approve","label":"Approve","description":"Accept the cycle charter and begin the cycle"}]','approve',NULL,'medium','easy','normal','resolved','{"selectedOptionId":"approve","rationale":"V10-3 preregistered operator checkpoint: charter accepted under frozen preregistration e997a4ee (BUILD effort=medium)","resolvedAt":"2026-10-04T18:42:17.587Z","resolvedBy":"operator"}');
INSERT INTO decisions VALUES('b4a045d6-d5dc-44c4-9966-ef04587c01e1','proj-pilot-a','wi-exec-108','checkpoint','{"workflowRunId":"a5671743-a862-47ad-9afd-68be70591486","workItemId":"wi-exec-108","stepId":"confirm"}','Workflow reached another checkpoint','Workflow ''full-build'' paused at step ''confirm''.','[{"id":"approve","label":"Approve","description":"Continue to the build phase"},{"id":"revise","label":"Revise","description":"Send back for revision (increments revision counter)"}]','approve',NULL,'medium','easy','normal','resolved','{"selectedOptionId":"approve","rationale":"V10-3 operator confirm checkpoint: TEST cleared; authorizing BUILD 16384+medium treatment under frozen preregistration e997a4ee","resolvedAt":"2026-10-04T19:12:43.097Z","resolvedBy":"operator"}');
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
INSERT INTO artifacts VALUES('1f844e35-8567-4995-9746-d83c0b8923d3','wi-exec-108','a5671743-a862-47ad-9afd-68be70591486',NULL,'cycle-charter','doc:cycle-charter','docs/cycle-charter.md','f83d4a81c1a2f2e956811d054b6d3469590e1ff9eb307421dc94289c622dde1e','2026-10-04T18:34:31.513Z');
INSERT INTO artifacts VALUES('8c852638-2d88-4379-a871-2c081233a3b3','wi-exec-108','a5671743-a862-47ad-9afd-68be70591486',NULL,'produced-file','produced-file:design:docs/requirements.md','docs/requirements.md','fda8bbd1482398cfaf9fc7ca38eba23d4a2498e5e4a1795ebb859861b4f54fe8','2026-10-04T18:47:56.682Z');
INSERT INTO artifacts VALUES('c218bd03-a69f-4f80-ac39-8d9c408aaead','wi-exec-108','a5671743-a862-47ad-9afd-68be70591486',NULL,'produced-file','produced-file:design:docs/architecture.md','docs/architecture.md','f5c11aa6090d3156c5bf6e2b797456fdc191c6b41b0d36c0919ea20895ceb548','2026-10-04T18:47:56.683Z');
INSERT INTO artifacts VALUES('ca432232-1f79-4ecd-b9c0-f2a691be02af','wi-exec-108','a5671743-a862-47ad-9afd-68be70591486',NULL,'produced-file','produced-file:plan:docs/plan.md','docs/plan.md','6681fe860d0f7de2a9c277a467b9f41e5d8d0b772867923d96483a13cf44503d','2026-10-04T18:52:54.068Z');
INSERT INTO artifacts VALUES('f077a7f7-92d9-4afd-a400-8bfbe3efe725','wi-exec-108','a5671743-a862-47ad-9afd-68be70591486',NULL,'produced-file','produced-file:plan:docs/test-plan.md','docs/test-plan.md','c515b90ea220442a1a7be56d53918463beb580c512097c4fa4befaed5634abe5','2026-10-04T18:52:54.068Z');
INSERT INTO artifacts VALUES('430a6250-e499-4206-b7e5-9d4b456f8be9','wi-exec-108','a5671743-a862-47ad-9afd-68be70591486',NULL,'produced-file','produced-file:test:apps/ai-server/tests/integration/test_worker_failure_payload_contract.py','apps/ai-server/tests/integration/test_worker_failure_payload_contract.py','30f751697c1015182aa9226279606e41fa240cd361694d869a54cfd0f5b667c4','2026-10-04T19:09:52.800Z');
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
INSERT INTO events VALUES('a4493660-984c-4943-a319-aa3e64bdc446',1,'work.started','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-04T18:32:10.395Z','{"from":"running","to":"running"}');
INSERT INTO events VALUES('0efcc7c6-4bb3-4fce-bbbf-a75722632e62',1,'decision.requested','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-04T18:34:31.532Z','{"from":"needs_decision","decisionId":"3f34d05b-0991-4142-a45f-564a464967fb","decisionType":"checkpoint"}');
INSERT INTO events VALUES('a4427e74-1e45-4e70-baef-4be26176d4aa',1,'decision.resolved','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-04T18:42:17.606Z','{"from":"running","decisionId":"3f34d05b-0991-4142-a45f-564a464967fb","selectedOptionId":"approve","resumedTo":"running"}');
INSERT INTO events VALUES('6723e84d-991b-4487-84af-4fff5f83d39e',1,'decision.requested','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-04T19:09:52.816Z','{"from":"needs_decision","decisionId":"b4a045d6-d5dc-44c4-9966-ef04587c01e1","decisionType":"checkpoint"}');
INSERT INTO events VALUES('40b2cbf3-bcff-4f09-8b5a-ef541c619762',1,'decision.resolved','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-04T19:12:43.117Z','{"from":"running","decisionId":"b4a045d6-d5dc-44c4-9966-ef04587c01e1","selectedOptionId":"approve","resumedTo":"running"}');
INSERT INTO events VALUES('4d8d957e-257c-4c05-90cb-57b29434ff06',1,'work.state_changed','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-04T19:25:23.053Z','{"from":"failed","to":"failed","reason":"Agent reply carried a malformed result block and format repair is exhausted (20 provider turn(s), 1 format-repair attempt(s)): Malformed patch marker (expected ''<<<SLE-PATCH path=\"<path>\" base=\"<sha256>\">>>''): <<<SLE-PATCH path=\"apps/ai-server/rag-worker-service/main.py\" base=\"7d7718bcbeb2e219dab14e285a66e62ea5883c209981a0be91cc29b490569988\">>"}');
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
INSERT INTO step_executions VALUES('f10dacc1-6b2d-454c-8a3d-8a6961f2c2a4','wi-exec-108','a5671743-a862-47ad-9afd-68be70591486','__start__','stratum-agent','succeeded',1,'2026-10-04T18:32:10.395Z','2026-10-04T18:42:17.588Z',NULL,NULL,NULL);
INSERT INTO step_executions VALUES('b4283f4e-1850-4a20-abe4-58828a94f615','wi-exec-108','a5671743-a862-47ad-9afd-68be70591486','design','stratum-agent','succeeded',1,'2026-10-04T18:42:17.588Z','2026-10-04T19:12:43.098Z',NULL,NULL,NULL);
INSERT INTO step_executions VALUES('9671904e-e0fd-483d-b3e2-4cdf043f0d74','wi-exec-108','a5671743-a862-47ad-9afd-68be70591486','build','stratum-agent','failed',1,'2026-10-04T19:12:43.098Z','2026-10-04T19:25:23.053Z',NULL,NULL,'{"code":"workflow_error","message":"Agent reply carried a malformed result block and format repair is exhausted (20 provider turn(s), 1 format-repair attempt(s)): Malformed patch marker (expected ''<<<SLE-PATCH path=\"<path>\" base=\"<sha256>\">>>''): <<<SLE-PATCH path=\"apps/ai-server/rag-worker-service/main.py\" base=\"7d7718bcbeb2e219dab14e285a66e62ea5883c209981a0be91cc29b490569988\">>"}');
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
INSERT INTO workflow_runs VALUES('a5671743-a862-47ad-9afd-68be70591486','full-build','wi-exec-108','halted','build',1,0,NULL,'2026-10-04T18:32:10.401Z','2026-10-04T19:25:23.052Z','{"planning_depth":"minimal","max_iterations":5,"on_cap_hit":"halt","definitionSource":{"workItemId":"wi-define-108-a8"}}');
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
INSERT INTO checkpoint_applications VALUES('3f34d05b-0991-4142-a45f-564a464967fb','a5671743-a862-47ad-9afd-68be70591486','full-build','scoping.checkpoint',1,0,'approve','V10-3 preregistered operator checkpoint: charter accepted under frozen preregistration e997a4ee (BUILD effort=medium)','applied','design',0,0,0,'2026-10-04T18:42:17.591Z','2026-10-04T18:42:17.605Z');
INSERT INTO checkpoint_applications VALUES('b4a045d6-d5dc-44c4-9966-ef04587c01e1','a5671743-a862-47ad-9afd-68be70591486','full-build','confirm',1,0,'approve','V10-3 operator confirm checkpoint: TEST cleared; authorizing BUILD 16384+medium treatment under frozen preregistration e997a4ee','applied','build',0,0,0,'2026-10-04T19:12:43.101Z','2026-10-04T19:12:43.116Z');
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
