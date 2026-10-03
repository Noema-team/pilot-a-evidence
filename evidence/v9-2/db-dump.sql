PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE _migrations (
      id         INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
INSERT INTO _migrations VALUES(1,'2026-10-03T13:26:30.758Z');
INSERT INTO _migrations VALUES(2,'2026-10-03T13:26:30.759Z');
INSERT INTO _migrations VALUES(3,'2026-10-03T13:26:30.759Z');
INSERT INTO _migrations VALUES(4,'2026-10-03T13:26:30.759Z');
INSERT INTO _migrations VALUES(5,'2026-10-03T13:26:30.760Z');
INSERT INTO _migrations VALUES(6,'2026-10-03T13:26:30.761Z');
INSERT INTO _migrations VALUES(7,'2026-10-03T13:26:30.762Z');
INSERT INTO _migrations VALUES(8,'2026-10-03T13:26:30.762Z');
INSERT INTO _migrations VALUES(9,'2026-10-03T13:26:30.763Z');
INSERT INTO _migrations VALUES(10,'2026-10-03T13:26:30.763Z');
CREATE TABLE workspaces (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
INSERT INTO workspaces VALUES('ws-pilot-a','pilot-a','2026-10-03T13:26:30.763Z');
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
INSERT INTO projects VALUES('proj-pilot-a','ws-pilot-a','student-platform',NULL,'active',0,'2026-10-03T13:26:30.763Z','2026-10-03T13:26:30.763Z');
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
INSERT INTO objectives VALUES('obj-108','proj-pilot-a','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage',replace('## Summary\n\nWorker and API disagree on the failure payload keys, so every failure persists as a generic "Processing failed" with no stage.\n\n- Worker publishes `{"error": str(e)}`:\n  `apps/ai-server/rag-worker-service/main.py:1097`\n- rag-api''s failed branch reads different keys:\n  `apps/ai-server/rag-api-service/main.py:223-226`\n\n```python\nmain_update["error"] = details.get("error_message", "Processing failed")\nmain_update["error_stage"] = details.get("stage")\nmain_update["retryable"] = details.get("retryable", True)\n```\n\nResult: `error` persists as the fallback string, `error_stage` is `None`, and `retryable` silently defaults to `True` even though the worker never sends it.\n\n## Impact\n\nFailures are undisambiguatable from the persisted record — users and support cannot tell what failed or where, and retry semantics are fabricated rather than reported.\n\n## Acceptance criteria\n\n- [ ] Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).\n- [ ] A failed job persists the worker''s actual error message and failing stage.\n- [ ] `retryable` is either sent by the worker or derived deliberately — not defaulted silently.\n- [ ] Contract test covering worker failure → rag-api persistence path.\n\n_(Salvaged from #57''s task cards after maintainer triage; see also the D3 issue filed alongside this one. Original analysis recorded in plans/upload-flow.md as deviation D4.)_','\n',char(10)),0,'active','[]','["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','2026-10-03T13:26:30.763Z','2026-10-03T13:26:30.763Z');
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
INSERT INTO work_items VALUES('wi-define-108-a8','proj-pilot-a','obj-108','[]','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','define-work','completed',0,'["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','[]','[]',NULL,'2026-10-03T13:26:30.763Z','2026-09-21T14:39:56.875Z',NULL);
INSERT INTO work_items VALUES('wi-exec-108','proj-pilot-a','obj-108','[]','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','full-build','failed',0,'["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','[]','[]',NULL,'2026-10-03T13:26:31.101Z','2026-10-03T14:27:18.287Z','{"planning_depth":"minimal","max_iterations":5,"on_cap_hit":"halt","definitionSource":{"workItemId":"wi-define-108-a8"},"editPolicy":{"appliesToSteps":["build"],"allowedEditPaths":["apps/ai-server/rag-worker-service/main.py"],"requiredEditPaths":["apps/ai-server/rag-worker-service/main.py"]}}');
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
INSERT INTO decisions VALUES('66636e24-91a7-495d-91c5-9895f9c67161','proj-pilot-a','wi-exec-108','checkpoint','{"workflowRunId":"385ed21a-8c3b-4e2b-8b62-a9a5b0375a00","workItemId":"wi-exec-108","stepId":"scoping.checkpoint"}','Workflow reached a checkpoint','Workflow ''full-build'' paused at step ''scoping.checkpoint'' and requires operator approval to continue.','[{"id":"approve","label":"Approve","description":"Accept the cycle charter and begin the cycle"}]','approve',NULL,'medium','easy','normal','resolved','{"selectedOptionId":"approve","rationale":"V9-2 preregistered operator checkpoint: charter accepted under frozen preregistration 769367b1 (BUILD effort=low)","resolvedAt":"2026-10-03T13:36:38.166Z","resolvedBy":"operator"}');
INSERT INTO decisions VALUES('6992fa6f-599e-423c-b19f-05768019ba81','proj-pilot-a','wi-exec-108','checkpoint','{"workflowRunId":"385ed21a-8c3b-4e2b-8b62-a9a5b0375a00","workItemId":"wi-exec-108","stepId":"confirm"}','Workflow reached another checkpoint','Workflow ''full-build'' paused at step ''confirm''.','[{"id":"approve","label":"Approve","description":"Continue to the build phase"},{"id":"revise","label":"Revise","description":"Send back for revision (increments revision counter)"}]','approve',NULL,'medium','easy','normal','resolved','{"selectedOptionId":"approve","rationale":"V9-2 operator confirm checkpoint: TEST cleared under effort=low; authorizing BUILD 16384+low treatment under frozen preregistration 769367b1","resolvedAt":"2026-10-03T14:08:08.295Z","resolvedBy":"operator"}');
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
INSERT INTO artifacts VALUES('04f6d1c7-0390-4577-b867-0c8997d17850','wi-exec-108','385ed21a-8c3b-4e2b-8b62-a9a5b0375a00',NULL,'cycle-charter','doc:cycle-charter','docs/cycle-charter.md','5268e895d33c3eff3e302f8c6aa0f2501e1f785117111917a9a6e1ac71df8074','2026-10-03T13:28:19.104Z');
INSERT INTO artifacts VALUES('1a6ac1f7-6f94-4da1-965b-0d022046d2d4','wi-exec-108','385ed21a-8c3b-4e2b-8b62-a9a5b0375a00',NULL,'produced-file','produced-file:design:docs/requirements.md','docs/requirements.md','43308c3b2516ca7eeded71a630c6e4504ce17ee33682245b958294b22e8f1628','2026-10-03T13:49:47.940Z');
INSERT INTO artifacts VALUES('ffbd5f22-5933-4b6c-9995-f230321ace93','wi-exec-108','385ed21a-8c3b-4e2b-8b62-a9a5b0375a00',NULL,'produced-file','produced-file:design:docs/architecture.md','docs/architecture.md','1535f91d788ae384a626932fa63b46163655255c3b396887c0fffa6b9b8711df','2026-10-03T13:49:47.940Z');
INSERT INTO artifacts VALUES('a1eb957d-8f05-4221-92db-52b9fcff42ba','wi-exec-108','385ed21a-8c3b-4e2b-8b62-a9a5b0375a00',NULL,'produced-file','produced-file:plan:docs/plan.md','docs/plan.md','08ea1fffff3dcbb59069d83d245249d0be4c4a29d3d830b7f9762e8c4655c67d','2026-10-03T13:53:37.330Z');
INSERT INTO artifacts VALUES('b120d59d-bf43-4226-9ae7-98d163944976','wi-exec-108','385ed21a-8c3b-4e2b-8b62-a9a5b0375a00',NULL,'produced-file','produced-file:plan:docs/test-plan.md','docs/test-plan.md','c12c4b66dc91f4e42ff8e3fd618dcd8f1a8ad445886e716a6195446d340d104f','2026-10-03T13:53:37.330Z');
INSERT INTO artifacts VALUES('505fe9f6-1e39-4552-929d-8439376b3ea1','wi-exec-108','385ed21a-8c3b-4e2b-8b62-a9a5b0375a00',NULL,'produced-file','produced-file:test:apps/ai-server/tests/integration/test_worker_failure_payload_contract.py','apps/ai-server/tests/integration/test_worker_failure_payload_contract.py','1c3a9fb92c2506a79859b2cbb8dabe45868edcb538be10493b25ef376cb07d5a','2026-10-03T14:01:24.602Z');
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
INSERT INTO events VALUES('3a87c17b-d7b6-46f0-abcf-618f60cd400f',1,'work.started','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-03T13:26:31.421Z','{"from":"running","to":"running"}');
INSERT INTO events VALUES('d54e7107-cfd5-4cf0-bc68-e37df42f8c12',1,'decision.requested','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-03T13:28:19.127Z','{"from":"needs_decision","decisionId":"66636e24-91a7-495d-91c5-9895f9c67161","decisionType":"checkpoint"}');
INSERT INTO events VALUES('c4edd5b9-2778-460a-9dd2-e4f2791c08a4',1,'decision.resolved','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-03T13:36:38.182Z','{"from":"running","decisionId":"66636e24-91a7-495d-91c5-9895f9c67161","selectedOptionId":"approve","resumedTo":"running"}');
INSERT INTO events VALUES('b05884d9-8cda-4a2f-8dc0-4ba74ecad86f',1,'decision.requested','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-03T14:01:24.617Z','{"from":"needs_decision","decisionId":"6992fa6f-599e-423c-b19f-05768019ba81","decisionType":"checkpoint"}');
INSERT INTO events VALUES('375d3214-8ea0-4fc3-a453-e6963e0a933a',1,'decision.resolved','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-03T14:08:08.318Z','{"from":"running","decisionId":"6992fa6f-599e-423c-b19f-05768019ba81","selectedOptionId":"approve","resumedTo":"running"}');
INSERT INTO events VALUES('1a41d604-4340-4545-8f11-f2c5da0e1b8a',1,'work.state_changed','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-03T14:27:18.287Z','{"from":"failed","to":"failed","reason":"Agent exhausted max_tokens without producing a result block"}');
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
INSERT INTO step_executions VALUES('6b780425-08fb-4f9d-82ab-75fcbff22bc3','wi-exec-108','385ed21a-8c3b-4e2b-8b62-a9a5b0375a00','__start__','stratum-agent','succeeded',1,'2026-10-03T13:26:31.421Z','2026-10-03T13:36:38.167Z',NULL,NULL,NULL);
INSERT INTO step_executions VALUES('e28e16fc-2824-4c59-8a96-f5f2a108e849','wi-exec-108','385ed21a-8c3b-4e2b-8b62-a9a5b0375a00','design','stratum-agent','succeeded',1,'2026-10-03T13:36:38.167Z','2026-10-03T14:08:08.297Z',NULL,NULL,NULL);
INSERT INTO step_executions VALUES('67603183-6108-4002-9e2f-1e749fc9f8a8','wi-exec-108','385ed21a-8c3b-4e2b-8b62-a9a5b0375a00','build','stratum-agent','failed',1,'2026-10-03T14:08:08.297Z','2026-10-03T14:27:18.286Z',NULL,NULL,'{"code":"workflow_error","message":"Agent exhausted max_tokens without producing a result block"}');
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
INSERT INTO workflow_runs VALUES('385ed21a-8c3b-4e2b-8b62-a9a5b0375a00','full-build','wi-exec-108','halted','build',1,0,NULL,'2026-10-03T13:26:31.430Z','2026-10-03T14:27:18.285Z','{"planning_depth":"minimal","max_iterations":5,"on_cap_hit":"halt","definitionSource":{"workItemId":"wi-define-108-a8"}}');
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
INSERT INTO checkpoint_applications VALUES('66636e24-91a7-495d-91c5-9895f9c67161','385ed21a-8c3b-4e2b-8b62-a9a5b0375a00','full-build','scoping.checkpoint',1,0,'approve','V9-2 preregistered operator checkpoint: charter accepted under frozen preregistration 769367b1 (BUILD effort=low)','applied','design',0,0,0,'2026-10-03T13:36:38.169Z','2026-10-03T13:36:38.181Z');
INSERT INTO checkpoint_applications VALUES('6992fa6f-599e-423c-b19f-05768019ba81','385ed21a-8c3b-4e2b-8b62-a9a5b0375a00','full-build','confirm',1,0,'approve','V9-2 operator confirm checkpoint: TEST cleared under effort=low; authorizing BUILD 16384+low treatment under frozen preregistration 769367b1','applied','build',0,0,0,'2026-10-03T14:08:08.299Z','2026-10-03T14:08:08.317Z');
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
