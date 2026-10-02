PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE _migrations (
      id         INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
INSERT INTO _migrations VALUES(1,'2026-10-02T14:21:16.896Z');
INSERT INTO _migrations VALUES(2,'2026-10-02T14:21:16.897Z');
INSERT INTO _migrations VALUES(3,'2026-10-02T14:21:16.898Z');
INSERT INTO _migrations VALUES(4,'2026-10-02T14:21:16.898Z');
INSERT INTO _migrations VALUES(5,'2026-10-02T14:21:16.898Z');
INSERT INTO _migrations VALUES(6,'2026-10-02T14:21:16.900Z');
INSERT INTO _migrations VALUES(7,'2026-10-02T14:21:16.901Z');
INSERT INTO _migrations VALUES(8,'2026-10-02T14:21:16.901Z');
INSERT INTO _migrations VALUES(9,'2026-10-02T14:21:16.902Z');
INSERT INTO _migrations VALUES(10,'2026-10-02T14:21:16.902Z');
CREATE TABLE workspaces (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
INSERT INTO workspaces VALUES('ws-pilot-a','pilot-a','2026-10-02T14:21:16.902Z');
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
INSERT INTO projects VALUES('proj-pilot-a','ws-pilot-a','student-platform',NULL,'active',0,'2026-10-02T14:21:16.902Z','2026-10-02T14:21:16.902Z');
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
INSERT INTO objectives VALUES('obj-108','proj-pilot-a','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage',replace('## Summary\n\nWorker and API disagree on the failure payload keys, so every failure persists as a generic "Processing failed" with no stage.\n\n- Worker publishes `{"error": str(e)}`:\n  `apps/ai-server/rag-worker-service/main.py:1097`\n- rag-api''s failed branch reads different keys:\n  `apps/ai-server/rag-api-service/main.py:223-226`\n\n```python\nmain_update["error"] = details.get("error_message", "Processing failed")\nmain_update["error_stage"] = details.get("stage")\nmain_update["retryable"] = details.get("retryable", True)\n```\n\nResult: `error` persists as the fallback string, `error_stage` is `None`, and `retryable` silently defaults to `True` even though the worker never sends it.\n\n## Impact\n\nFailures are undisambiguatable from the persisted record — users and support cannot tell what failed or where, and retry semantics are fabricated rather than reported.\n\n## Acceptance criteria\n\n- [ ] Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).\n- [ ] A failed job persists the worker''s actual error message and failing stage.\n- [ ] `retryable` is either sent by the worker or derived deliberately — not defaulted silently.\n- [ ] Contract test covering worker failure → rag-api persistence path.\n\n_(Salvaged from #57''s task cards after maintainer triage; see also the D3 issue filed alongside this one. Original analysis recorded in plans/upload-flow.md as deviation D4.)_','\n',char(10)),0,'active','[]','["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','2026-10-02T14:21:16.902Z','2026-10-02T14:21:16.902Z');
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
INSERT INTO work_items VALUES('wi-define-108-a8','proj-pilot-a','obj-108','[]','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','define-work','completed',0,'["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','[]','[]',NULL,'2026-10-02T14:21:16.902Z','2026-09-21T14:39:56.875Z',NULL);
INSERT INTO work_items VALUES('wi-exec-108','proj-pilot-a','obj-108','[]','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','full-build','failed',0,'["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','[]','[]',NULL,'2026-10-02T14:21:17.194Z','2026-10-02T15:09:38.247Z','{"planning_depth":"minimal","max_iterations":5,"on_cap_hit":"halt","definitionSource":{"workItemId":"wi-define-108-a8"},"editPolicy":{"appliesToSteps":["build"],"allowedEditPaths":["apps/ai-server/rag-worker-service/main.py"],"requiredEditPaths":["apps/ai-server/rag-worker-service/main.py"]}}');
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
INSERT INTO decisions VALUES('c5503a61-c4bd-4b86-9eac-88defa4e6031','proj-pilot-a','wi-exec-108','checkpoint','{"workflowRunId":"a9489598-2261-42b9-9595-f78367c5d6f4","workItemId":"wi-exec-108","stepId":"scoping.checkpoint"}','Workflow reached a checkpoint','Workflow ''full-build'' paused at step ''scoping.checkpoint'' and requires operator approval to continue.','[{"id":"approve","label":"Approve","description":"Accept the cycle charter and begin the cycle"}]','approve',NULL,'medium','easy','normal','resolved','{"selectedOptionId":"approve","rationale":"V8-2 preregistered operator checkpoint: charter accepted under frozen preregistration 5159cdaa (baseline b6dbcd36, TEST effort=low)","resolvedAt":"2026-10-02T14:31:25.912Z","resolvedBy":"operator"}');
INSERT INTO decisions VALUES('6b5fcd58-2d7e-4afd-b31b-d3adf1d91ed5','proj-pilot-a','wi-exec-108','checkpoint','{"workflowRunId":"a9489598-2261-42b9-9595-f78367c5d6f4","workItemId":"wi-exec-108","stepId":"confirm"}','Workflow reached another checkpoint','Workflow ''full-build'' paused at step ''confirm''.','[{"id":"approve","label":"Approve","description":"Continue to the build phase"},{"id":"revise","label":"Revise","description":"Send back for revision (increments revision counter)"}]','approve',NULL,'medium','easy','normal','resolved','{"selectedOptionId":"approve","rationale":"V8-2 operator confirm checkpoint: TEST cleared under effort=low; authorizing BUILD (unchanged 16k sentinel) under frozen preregistration 5159cdaa","resolvedAt":"2026-10-02T15:02:06.262Z","resolvedBy":"operator"}');
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
INSERT INTO artifacts VALUES('31650ae8-7348-47cb-8365-1ee79b6dfe8a','wi-exec-108','a9489598-2261-42b9-9595-f78367c5d6f4',NULL,'cycle-charter','doc:cycle-charter','docs/cycle-charter.md','8328266819a87165dd6f132d0f46d06f4cf75f62ba2985b15ab8d909e007feb0','2026-10-02T14:22:30.571Z');
INSERT INTO artifacts VALUES('7943bd77-d693-4c63-94cb-ce149933e1ae','wi-exec-108','a9489598-2261-42b9-9595-f78367c5d6f4',NULL,'produced-file','produced-file:design:docs/requirements.md','docs/requirements.md','a8c2308d81609badb95c824a9a3c5a346a2246e345fb1a8e3e97fb20c00bff06','2026-10-02T14:38:53.317Z');
INSERT INTO artifacts VALUES('a7999d78-2465-42c9-b20a-cccfe17d54f3','wi-exec-108','a9489598-2261-42b9-9595-f78367c5d6f4',NULL,'produced-file','produced-file:design:docs/architecture.md','docs/architecture.md','37bc60c39aeb9fb4872f24bf712ff81bcdcd97878458013dc6a226f8365420a2','2026-10-02T14:38:53.317Z');
INSERT INTO artifacts VALUES('551ae4f2-f257-4c7b-9781-3f5124007040','wi-exec-108','a9489598-2261-42b9-9595-f78367c5d6f4',NULL,'produced-file','produced-file:plan:docs/plan.md','docs/plan.md','96f691cd137c18d3cf2a1204e8ed529434a4c781c534988d4a28751d649bf17e','2026-10-02T14:47:08.065Z');
INSERT INTO artifacts VALUES('e937ed44-4288-482c-bc60-9210ae77a910','wi-exec-108','a9489598-2261-42b9-9595-f78367c5d6f4',NULL,'produced-file','produced-file:plan:docs/test-plan.md','docs/test-plan.md','ba37e51019d032a88574997073741bff7f9c197e36a988090aa8239a757ec589','2026-10-02T14:47:08.065Z');
INSERT INTO artifacts VALUES('12745970-d118-48a3-b0d3-2c9f2aa4ca91','wi-exec-108','a9489598-2261-42b9-9595-f78367c5d6f4',NULL,'produced-file','produced-file:test:apps/ai-server/tests/integration/test_failure_payload_contract.py','apps/ai-server/tests/integration/test_failure_payload_contract.py','de0fe92ba4e93346554c7ac21b132bf721c287ae552d690dba3ea36475160a53','2026-10-02T14:58:39.126Z');
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
INSERT INTO events VALUES('2358d1aa-c9e1-4c0d-889f-8286202e7e24',1,'work.started','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-02T14:21:17.506Z','{"from":"running","to":"running"}');
INSERT INTO events VALUES('4ed890e5-99e9-4f50-9cad-2f772ebd01c4',1,'decision.requested','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-02T14:22:30.588Z','{"from":"needs_decision","decisionId":"c5503a61-c4bd-4b86-9eac-88defa4e6031","decisionType":"checkpoint"}');
INSERT INTO events VALUES('21da3528-ae12-4a4a-9e2e-2aa94f1a7c73',1,'decision.resolved','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-02T14:31:25.930Z','{"from":"running","decisionId":"c5503a61-c4bd-4b86-9eac-88defa4e6031","selectedOptionId":"approve","resumedTo":"running"}');
INSERT INTO events VALUES('19aee3c6-a433-44af-be32-0bff347008d9',1,'decision.requested','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-02T14:58:39.139Z','{"from":"needs_decision","decisionId":"6b5fcd58-2d7e-4afd-b31b-d3adf1d91ed5","decisionType":"checkpoint"}');
INSERT INTO events VALUES('8c4340c0-c678-4723-8908-09008f07fdd6',1,'decision.resolved','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-02T15:02:06.278Z','{"from":"running","decisionId":"6b5fcd58-2d7e-4afd-b31b-d3adf1d91ed5","selectedOptionId":"approve","resumedTo":"running"}');
INSERT INTO events VALUES('71959c0f-3c33-41f0-b2ba-4b738fcbb2e9',1,'work.state_changed','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-02T15:09:38.247Z','{"from":"failed","to":"failed","reason":"Agent exhausted max_tokens without producing a result block"}');
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
INSERT INTO step_executions VALUES('bfa3976e-c365-4c35-86c7-4adaf2ad8499','wi-exec-108','a9489598-2261-42b9-9595-f78367c5d6f4','__start__','stratum-agent','succeeded',1,'2026-10-02T14:21:17.506Z','2026-10-02T14:31:25.913Z',NULL,NULL,NULL);
INSERT INTO step_executions VALUES('0c7a988a-f5b5-444d-a81e-682f2b1d37c2','wi-exec-108','a9489598-2261-42b9-9595-f78367c5d6f4','design','stratum-agent','succeeded',1,'2026-10-02T14:31:25.913Z','2026-10-02T15:02:06.263Z',NULL,NULL,NULL);
INSERT INTO step_executions VALUES('7db96893-fcf1-4ae7-806a-51d2106b806c','wi-exec-108','a9489598-2261-42b9-9595-f78367c5d6f4','build','stratum-agent','failed',1,'2026-10-02T15:02:06.263Z','2026-10-02T15:09:38.246Z',NULL,NULL,'{"code":"workflow_error","message":"Agent exhausted max_tokens without producing a result block"}');
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
INSERT INTO workflow_runs VALUES('a9489598-2261-42b9-9595-f78367c5d6f4','full-build','wi-exec-108','halted','build',1,0,NULL,'2026-10-02T14:21:17.512Z','2026-10-02T15:09:38.246Z','{"planning_depth":"minimal","max_iterations":5,"on_cap_hit":"halt","definitionSource":{"workItemId":"wi-define-108-a8"}}');
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
INSERT INTO checkpoint_applications VALUES('c5503a61-c4bd-4b86-9eac-88defa4e6031','a9489598-2261-42b9-9595-f78367c5d6f4','full-build','scoping.checkpoint',1,0,'approve','V8-2 preregistered operator checkpoint: charter accepted under frozen preregistration 5159cdaa (baseline b6dbcd36, TEST effort=low)','applied','design',0,0,0,'2026-10-02T14:31:25.915Z','2026-10-02T14:31:25.929Z');
INSERT INTO checkpoint_applications VALUES('6b5fcd58-2d7e-4afd-b31b-d3adf1d91ed5','a9489598-2261-42b9-9595-f78367c5d6f4','full-build','confirm',1,0,'approve','V8-2 operator confirm checkpoint: TEST cleared under effort=low; authorizing BUILD (unchanged 16k sentinel) under frozen preregistration 5159cdaa','applied','build',0,0,0,'2026-10-02T15:02:06.265Z','2026-10-02T15:02:06.277Z');
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
