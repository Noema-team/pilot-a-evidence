PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE _migrations (
      id         INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
INSERT INTO _migrations VALUES(1,'2026-10-03T14:39:43.174Z');
INSERT INTO _migrations VALUES(2,'2026-10-03T14:39:43.175Z');
INSERT INTO _migrations VALUES(3,'2026-10-03T14:39:43.175Z');
INSERT INTO _migrations VALUES(4,'2026-10-03T14:39:43.176Z');
INSERT INTO _migrations VALUES(5,'2026-10-03T14:39:43.176Z');
INSERT INTO _migrations VALUES(6,'2026-10-03T14:39:43.178Z');
INSERT INTO _migrations VALUES(7,'2026-10-03T14:39:43.178Z');
INSERT INTO _migrations VALUES(8,'2026-10-03T14:39:43.178Z');
INSERT INTO _migrations VALUES(9,'2026-10-03T14:39:43.179Z');
INSERT INTO _migrations VALUES(10,'2026-10-03T14:39:43.179Z');
CREATE TABLE workspaces (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
INSERT INTO workspaces VALUES('ws-pilot-a','pilot-a','2026-10-03T14:39:43.179Z');
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
INSERT INTO projects VALUES('proj-pilot-a','ws-pilot-a','student-platform',NULL,'active',0,'2026-10-03T14:39:43.179Z','2026-10-03T14:39:43.179Z');
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
INSERT INTO objectives VALUES('obj-108','proj-pilot-a','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage',replace('## Summary\n\nWorker and API disagree on the failure payload keys, so every failure persists as a generic "Processing failed" with no stage.\n\n- Worker publishes `{"error": str(e)}`:\n  `apps/ai-server/rag-worker-service/main.py:1097`\n- rag-api''s failed branch reads different keys:\n  `apps/ai-server/rag-api-service/main.py:223-226`\n\n```python\nmain_update["error"] = details.get("error_message", "Processing failed")\nmain_update["error_stage"] = details.get("stage")\nmain_update["retryable"] = details.get("retryable", True)\n```\n\nResult: `error` persists as the fallback string, `error_stage` is `None`, and `retryable` silently defaults to `True` even though the worker never sends it.\n\n## Impact\n\nFailures are undisambiguatable from the persisted record — users and support cannot tell what failed or where, and retry semantics are fabricated rather than reported.\n\n## Acceptance criteria\n\n- [ ] Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).\n- [ ] A failed job persists the worker''s actual error message and failing stage.\n- [ ] `retryable` is either sent by the worker or derived deliberately — not defaulted silently.\n- [ ] Contract test covering worker failure → rag-api persistence path.\n\n_(Salvaged from #57''s task cards after maintainer triage; see also the D3 issue filed alongside this one. Original analysis recorded in plans/upload-flow.md as deviation D4.)_','\n',char(10)),0,'active','[]','["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','2026-10-03T14:39:43.179Z','2026-10-03T14:39:43.179Z');
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
INSERT INTO work_items VALUES('wi-define-108-a8','proj-pilot-a','obj-108','[]','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','define-work','completed',0,'["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','[]','[]',NULL,'2026-10-03T14:39:43.179Z','2026-09-21T14:39:56.875Z',NULL);
INSERT INTO work_items VALUES('wi-exec-108','proj-pilot-a','obj-108','[]','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','full-build','failed',0,'["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','[]','[]',NULL,'2026-10-03T14:39:43.462Z','2026-10-03T15:24:57.233Z','{"planning_depth":"minimal","max_iterations":5,"on_cap_hit":"halt","definitionSource":{"workItemId":"wi-define-108-a8"},"editPolicy":{"appliesToSteps":["build"],"allowedEditPaths":["apps/ai-server/rag-worker-service/main.py"],"requiredEditPaths":["apps/ai-server/rag-worker-service/main.py"]}}');
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
INSERT INTO decisions VALUES('c527cce6-09c8-4bbb-9922-6f9e77249656','proj-pilot-a','wi-exec-108','checkpoint','{"workflowRunId":"cdfcab43-8917-462e-ba68-24f8a5ea2e1d","workItemId":"wi-exec-108","stepId":"scoping.checkpoint"}','Workflow reached a checkpoint','Workflow ''full-build'' paused at step ''scoping.checkpoint'' and requires operator approval to continue.','[{"id":"approve","label":"Approve","description":"Accept the cycle charter and begin the cycle"}]','approve',NULL,'medium','easy','normal','resolved','{"selectedOptionId":"approve","rationale":"V9-3 preregistered operator checkpoint: charter accepted under frozen preregistration 769367b1 (BUILD effort=low)","resolvedAt":"2026-10-03T14:49:52.063Z","resolvedBy":"operator"}');
INSERT INTO decisions VALUES('434a54ae-2e25-42e3-85bf-97c89d9eacf8','proj-pilot-a','wi-exec-108','checkpoint','{"workflowRunId":"cdfcab43-8917-462e-ba68-24f8a5ea2e1d","workItemId":"wi-exec-108","stepId":"confirm"}','Workflow reached another checkpoint','Workflow ''full-build'' paused at step ''confirm''.','[{"id":"approve","label":"Approve","description":"Continue to the build phase"},{"id":"revise","label":"Revise","description":"Send back for revision (increments revision counter)"}]','approve',NULL,'medium','easy','normal','resolved','{"selectedOptionId":"approve","rationale":"V9-3 operator confirm checkpoint: TEST cleared under effort=low; authorizing the FINAL BUILD 16384+low treatment opportunity under frozen preregistration 769367b1","resolvedAt":"2026-10-03T15:20:28.477Z","resolvedBy":"operator"}');
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
INSERT INTO artifacts VALUES('1464b9ba-49b6-4038-97db-fb4e967a3d0a','wi-exec-108','cdfcab43-8917-462e-ba68-24f8a5ea2e1d',NULL,'cycle-charter','doc:cycle-charter','docs/cycle-charter.md','d059dc0ab19c025cb76aa7d7c5f05df4d9fb9e1a28809e7b22f7e5ad51655ebe','2026-10-03T14:41:40.896Z');
INSERT INTO artifacts VALUES('0bcd3f84-69d7-4424-9b4f-43e42d4d0735','wi-exec-108','cdfcab43-8917-462e-ba68-24f8a5ea2e1d',NULL,'produced-file','produced-file:design:docs/requirements.md','docs/requirements.md','532e3281f2ca3a23172b996938a447ad2155db1ec4edfc726ebe6471a3943587','2026-10-03T14:57:47.145Z');
INSERT INTO artifacts VALUES('14928b5f-e3fa-4998-a5e8-6fd88c610e86','wi-exec-108','cdfcab43-8917-462e-ba68-24f8a5ea2e1d',NULL,'produced-file','produced-file:design:docs/architecture.md','docs/architecture.md','9da10d010facdf20d3a81bff868792db3c45aa6bc7ba01c67c1d8f97c7799d1e','2026-10-03T14:57:47.145Z');
INSERT INTO artifacts VALUES('6765a131-2c7d-4515-99d2-a7280b018e41','wi-exec-108','cdfcab43-8917-462e-ba68-24f8a5ea2e1d',NULL,'produced-file','produced-file:plan:docs/plan.md','docs/plan.md','d594288d5f6eef8b1368dfcb221f031a658baeaf41d50e3de6c327bfb0d3d1fa','2026-10-03T15:03:33.896Z');
INSERT INTO artifacts VALUES('0fc4c5fd-66ba-443e-8078-0229f4a95604','wi-exec-108','cdfcab43-8917-462e-ba68-24f8a5ea2e1d',NULL,'produced-file','produced-file:plan:docs/test-plan.md','docs/test-plan.md','4110fdad2f91b2a7795d425b869bb2ec8c5cb4c32ea4e90972cd4b2bdbfc6ed3','2026-10-03T15:03:33.896Z');
INSERT INTO artifacts VALUES('2bbed319-9eae-4104-837b-c16a5d9352de','wi-exec-108','cdfcab43-8917-462e-ba68-24f8a5ea2e1d',NULL,'produced-file','produced-file:test:apps/ai-server/tests/integration/test_failure_payload_contract.py','apps/ai-server/tests/integration/test_failure_payload_contract.py','bf040327cafde8d433df75f46f025c3313e5f0c25e5cc070d7f195ecc2a75916','2026-10-03T15:19:00.492Z');
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
INSERT INTO events VALUES('3c477e85-624f-4b7b-b354-713e487ab1c9',1,'work.started','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-03T14:39:43.792Z','{"from":"running","to":"running"}');
INSERT INTO events VALUES('f8767b88-ccb9-481d-9f4d-8fdcc4acc8fd',1,'decision.requested','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-03T14:41:40.916Z','{"from":"needs_decision","decisionId":"c527cce6-09c8-4bbb-9922-6f9e77249656","decisionType":"checkpoint"}');
INSERT INTO events VALUES('412222d4-3747-4c7c-9c82-dcae106bcc6a',1,'decision.resolved','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-03T14:49:52.083Z','{"from":"running","decisionId":"c527cce6-09c8-4bbb-9922-6f9e77249656","selectedOptionId":"approve","resumedTo":"running"}');
INSERT INTO events VALUES('957e6999-fe18-4e32-bf0f-9c63aa711fd6',1,'decision.requested','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-03T15:19:00.506Z','{"from":"needs_decision","decisionId":"434a54ae-2e25-42e3-85bf-97c89d9eacf8","decisionType":"checkpoint"}');
INSERT INTO events VALUES('4630da0e-7166-48a8-bf91-61c21b02d6ff',1,'decision.resolved','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-03T15:20:28.493Z','{"from":"running","decisionId":"434a54ae-2e25-42e3-85bf-97c89d9eacf8","selectedOptionId":"approve","resumedTo":"running"}');
INSERT INTO events VALUES('c0ca73d9-6cbc-4fad-8f0d-73eec83eadf1',1,'work.state_changed','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-03T15:24:57.233Z','{"from":"failed","to":"failed","reason":"Patch 1/1 for ''apps/ai-server/rag-worker-service/main.py'' rejected: Malformed hunk header at diff line 21: ''             # Step 5: Generate Embeddings''"}');
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
INSERT INTO step_executions VALUES('9e825544-62a6-403a-848b-137b2018f9d0','wi-exec-108','cdfcab43-8917-462e-ba68-24f8a5ea2e1d','__start__','stratum-agent','succeeded',1,'2026-10-03T14:39:43.791Z','2026-10-03T14:49:52.064Z',NULL,NULL,NULL);
INSERT INTO step_executions VALUES('e1e0fcc4-1c56-48aa-aaab-120e0691c1e4','wi-exec-108','cdfcab43-8917-462e-ba68-24f8a5ea2e1d','design','stratum-agent','succeeded',1,'2026-10-03T14:49:52.064Z','2026-10-03T15:20:28.478Z',NULL,NULL,NULL);
INSERT INTO step_executions VALUES('2c7fa4cf-3673-49bd-a432-cf96027697f2','wi-exec-108','cdfcab43-8917-462e-ba68-24f8a5ea2e1d','build','stratum-agent','failed',1,'2026-10-03T15:20:28.478Z','2026-10-03T15:24:57.232Z',NULL,NULL,'{"code":"workflow_error","message":"Patch 1/1 for ''apps/ai-server/rag-worker-service/main.py'' rejected: Malformed hunk header at diff line 21: ''             # Step 5: Generate Embeddings''"}');
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
INSERT INTO workflow_runs VALUES('cdfcab43-8917-462e-ba68-24f8a5ea2e1d','full-build','wi-exec-108','halted','build',1,0,NULL,'2026-10-03T14:39:43.798Z','2026-10-03T15:24:57.205Z','{"planning_depth":"minimal","max_iterations":5,"on_cap_hit":"halt","definitionSource":{"workItemId":"wi-define-108-a8"}}');
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
INSERT INTO checkpoint_applications VALUES('c527cce6-09c8-4bbb-9922-6f9e77249656','cdfcab43-8917-462e-ba68-24f8a5ea2e1d','full-build','scoping.checkpoint',1,0,'approve','V9-3 preregistered operator checkpoint: charter accepted under frozen preregistration 769367b1 (BUILD effort=low)','applied','design',0,0,0,'2026-10-03T14:49:52.066Z','2026-10-03T14:49:52.082Z');
INSERT INTO checkpoint_applications VALUES('434a54ae-2e25-42e3-85bf-97c89d9eacf8','cdfcab43-8917-462e-ba68-24f8a5ea2e1d','full-build','confirm',1,0,'approve','V9-3 operator confirm checkpoint: TEST cleared under effort=low; authorizing the FINAL BUILD 16384+low treatment opportunity under frozen preregistration 769367b1','applied','build',0,0,0,'2026-10-03T15:20:28.479Z','2026-10-03T15:20:28.492Z');
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
