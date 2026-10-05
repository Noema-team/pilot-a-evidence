PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE _migrations (
      id         INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
INSERT INTO _migrations VALUES(1,'2026-10-05T07:26:00.016Z');
INSERT INTO _migrations VALUES(2,'2026-10-05T07:26:00.017Z');
INSERT INTO _migrations VALUES(3,'2026-10-05T07:26:00.017Z');
INSERT INTO _migrations VALUES(4,'2026-10-05T07:26:00.018Z');
INSERT INTO _migrations VALUES(5,'2026-10-05T07:26:00.018Z');
INSERT INTO _migrations VALUES(6,'2026-10-05T07:26:00.020Z');
INSERT INTO _migrations VALUES(7,'2026-10-05T07:26:00.020Z');
INSERT INTO _migrations VALUES(8,'2026-10-05T07:26:00.021Z');
INSERT INTO _migrations VALUES(9,'2026-10-05T07:26:00.021Z');
INSERT INTO _migrations VALUES(10,'2026-10-05T07:26:00.021Z');
CREATE TABLE workspaces (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
INSERT INTO workspaces VALUES('ws-pilot-a','pilot-a','2026-10-05T07:26:00.021Z');
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
INSERT INTO projects VALUES('proj-pilot-a','ws-pilot-a','student-platform',NULL,'active',0,'2026-10-05T07:26:00.021Z','2026-10-05T07:26:00.021Z');
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
INSERT INTO objectives VALUES('obj-108','proj-pilot-a','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage',replace('## Summary\n\nWorker and API disagree on the failure payload keys, so every failure persists as a generic "Processing failed" with no stage.\n\n- Worker publishes `{"error": str(e)}`:\n  `apps/ai-server/rag-worker-service/main.py:1097`\n- rag-api''s failed branch reads different keys:\n  `apps/ai-server/rag-api-service/main.py:223-226`\n\n```python\nmain_update["error"] = details.get("error_message", "Processing failed")\nmain_update["error_stage"] = details.get("stage")\nmain_update["retryable"] = details.get("retryable", True)\n```\n\nResult: `error` persists as the fallback string, `error_stage` is `None`, and `retryable` silently defaults to `True` even though the worker never sends it.\n\n## Impact\n\nFailures are undisambiguatable from the persisted record — users and support cannot tell what failed or where, and retry semantics are fabricated rather than reported.\n\n## Acceptance criteria\n\n- [ ] Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).\n- [ ] A failed job persists the worker''s actual error message and failing stage.\n- [ ] `retryable` is either sent by the worker or derived deliberately — not defaulted silently.\n- [ ] Contract test covering worker failure → rag-api persistence path.\n\n_(Salvaged from #57''s task cards after maintainer triage; see also the D3 issue filed alongside this one. Original analysis recorded in plans/upload-flow.md as deviation D4.)_','\n',char(10)),0,'active','[]','["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','2026-10-05T07:26:00.021Z','2026-10-05T07:26:00.021Z');
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
INSERT INTO work_items VALUES('wi-define-108-a8','proj-pilot-a','obj-108','[]','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','define-work','completed',0,'["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','[]','[]',NULL,'2026-10-05T07:26:00.021Z','2026-09-21T14:39:56.875Z',NULL);
INSERT INTO work_items VALUES('wi-exec-108','proj-pilot-a','obj-108','[]','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','full-build','failed',0,'["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','[]','[]',NULL,'2026-10-05T07:26:00.301Z','2026-10-05T08:25:25.971Z','{"planning_depth":"minimal","max_iterations":5,"on_cap_hit":"halt","definitionSource":{"workItemId":"wi-define-108-a8"},"editPolicy":{"appliesToSteps":["build"],"allowedEditPaths":["apps/ai-server/rag-worker-service/main.py"],"requiredEditPaths":["apps/ai-server/rag-worker-service/main.py"]}}');
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
INSERT INTO decisions VALUES('fbea8c50-92b6-4e05-94a7-66923dee6e2f','proj-pilot-a','wi-exec-108','checkpoint','{"workflowRunId":"af5a015c-e9c4-439d-a97d-5c20625db661","workItemId":"wi-exec-108","stepId":"scoping.checkpoint"}','Workflow reached a checkpoint','Workflow ''full-build'' paused at step ''scoping.checkpoint'' and requires operator approval to continue.','[{"id":"approve","label":"Approve","description":"Accept the cycle charter and begin the cycle"}]','approve',NULL,'medium','easy','normal','resolved','{"selectedOptionId":"approve","rationale":"V11-1 preregistered operator checkpoint: charter accepted under frozen preregistration ee2fd57b (BUILD 32768+low sole intervention)","resolvedAt":"2026-10-05T07:36:08.842Z","resolvedBy":"operator"}');
INSERT INTO decisions VALUES('c41cbe76-81ea-49b1-be0d-b1fb0e836de5','proj-pilot-a','wi-exec-108','checkpoint','{"workflowRunId":"af5a015c-e9c4-439d-a97d-5c20625db661","workItemId":"wi-exec-108","stepId":"confirm"}','Workflow reached another checkpoint','Workflow ''full-build'' paused at step ''confirm''.','[{"id":"approve","label":"Approve","description":"Continue to the build phase"},{"id":"revise","label":"Revise","description":"Send back for revision (increments revision counter)"}]','approve',NULL,'medium','easy','normal','resolved','{"selectedOptionId":"approve","rationale":"V11-1 operator confirm checkpoint: TEST cleared; authorizing BUILD 32768+low treatment under frozen preregistration ee2fd57b","resolvedAt":"2026-10-05T08:21:26.322Z","resolvedBy":"operator"}');
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
INSERT INTO artifacts VALUES('00e1967c-177b-4ca1-ae9a-45a4121720e6','wi-exec-108','af5a015c-e9c4-439d-a97d-5c20625db661',NULL,'cycle-charter','doc:cycle-charter','docs/cycle-charter.md','da257de95009e4fd1d3e0ac32994080df9009d2a940d10dddea7fe6f11db79b1','2026-10-05T07:29:48.622Z');
INSERT INTO artifacts VALUES('64a927fa-eb3c-41c0-a4a9-6fdcba0d1d8b','wi-exec-108','af5a015c-e9c4-439d-a97d-5c20625db661',NULL,'produced-file','produced-file:design:docs/requirements.md','docs/requirements.md','9fd62ddf005c99556c087c83833f9ebbb0b841e24145be5ecaa3783cb03ac209','2026-10-05T07:45:20.903Z');
INSERT INTO artifacts VALUES('04743bd8-b5f6-4372-aefd-3faf45d9c206','wi-exec-108','af5a015c-e9c4-439d-a97d-5c20625db661',NULL,'produced-file','produced-file:design:docs/architecture.md','docs/architecture.md','97e30f89ea9513c64b3518e94e631a0a49256f43abc1fe4453c167353874e4eb','2026-10-05T07:45:20.903Z');
INSERT INTO artifacts VALUES('6ba7b2d5-d49a-41a9-a149-f0c5a0b0691f','wi-exec-108','af5a015c-e9c4-439d-a97d-5c20625db661',NULL,'produced-file','produced-file:plan:docs/plan.md','docs/plan.md','98055fb8491d646c9d2aba1f4d57559ae3941ab0529102be1118689e19cfe45f','2026-10-05T07:54:38.900Z');
INSERT INTO artifacts VALUES('21fcd60d-89d1-44b1-b68b-b7affbfc6949','wi-exec-108','af5a015c-e9c4-439d-a97d-5c20625db661',NULL,'produced-file','produced-file:plan:docs/test-plan.md','docs/test-plan.md','b90d520d8620bfe93a471399bac9b36c1212d777f856e30dd6ac2ea8041c537a','2026-10-05T07:54:38.900Z');
INSERT INTO artifacts VALUES('d3e3b09c-af4d-4b5c-bf6f-7e816e57e3a0','wi-exec-108','af5a015c-e9c4-439d-a97d-5c20625db661',NULL,'produced-file','produced-file:test:apps/ai-server/tests/integration/test_failure_payload_contract.py','apps/ai-server/tests/integration/test_failure_payload_contract.py','4456eaf4794968b152abfad5de365048bca67ccfa4fad2df19caf6c5e3c02a67','2026-10-05T08:07:39.605Z');
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
INSERT INTO events VALUES('568c648b-4ae6-4838-8bb4-afaf4afaf84f',1,'work.started','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-05T07:26:00.625Z','{"from":"running","to":"running"}');
INSERT INTO events VALUES('a1fba2cd-438e-48fb-9576-5c752bf3ab61',1,'decision.requested','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-05T07:29:48.635Z','{"from":"needs_decision","decisionId":"fbea8c50-92b6-4e05-94a7-66923dee6e2f","decisionType":"checkpoint"}');
INSERT INTO events VALUES('33b7ece3-1732-4bb6-9741-793632dba2e6',1,'decision.resolved','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-05T07:36:08.861Z','{"from":"running","decisionId":"fbea8c50-92b6-4e05-94a7-66923dee6e2f","selectedOptionId":"approve","resumedTo":"running"}');
INSERT INTO events VALUES('c89aeb88-7479-4d67-ac25-bbe5f83192fd',1,'decision.requested','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-05T08:07:39.612Z','{"from":"needs_decision","decisionId":"c41cbe76-81ea-49b1-be0d-b1fb0e836de5","decisionType":"checkpoint"}');
INSERT INTO events VALUES('da6783d9-212c-4d46-90e5-fc8dce50f93c',1,'decision.resolved','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-05T08:21:26.338Z','{"from":"running","decisionId":"c41cbe76-81ea-49b1-be0d-b1fb0e836de5","selectedOptionId":"approve","resumedTo":"running"}');
INSERT INTO events VALUES('83aacb3b-31fc-4f49-b31a-3946b095e299',1,'work.state_changed','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-05T08:25:25.971Z','{"from":"failed","to":"failed","reason":"Patch 1/1 for ''apps/ai-server/rag-worker-service/main.py'' rejected: Malformed hunk header at diff line 12: '' # ========================================''"}');
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
INSERT INTO step_executions VALUES('085ff135-0330-40c9-bbb6-a3ab3e63503b','wi-exec-108','af5a015c-e9c4-439d-a97d-5c20625db661','__start__','stratum-agent','succeeded',1,'2026-10-05T07:26:00.624Z','2026-10-05T07:36:08.843Z',NULL,NULL,NULL);
INSERT INTO step_executions VALUES('9fa7f1d0-516a-49c8-99e6-6b2db5f67ddc','wi-exec-108','af5a015c-e9c4-439d-a97d-5c20625db661','design','stratum-agent','succeeded',1,'2026-10-05T07:36:08.843Z','2026-10-05T08:21:26.323Z',NULL,NULL,NULL);
INSERT INTO step_executions VALUES('95b3b34e-a286-4f1c-a1f5-f0ddb641de68','wi-exec-108','af5a015c-e9c4-439d-a97d-5c20625db661','build','stratum-agent','failed',1,'2026-10-05T08:21:26.323Z','2026-10-05T08:25:25.970Z',NULL,NULL,'{"code":"workflow_error","message":"Patch 1/1 for ''apps/ai-server/rag-worker-service/main.py'' rejected: Malformed hunk header at diff line 12: '' # ========================================''"}');
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
INSERT INTO workflow_runs VALUES('af5a015c-e9c4-439d-a97d-5c20625db661','full-build','wi-exec-108','halted','build',1,0,NULL,'2026-10-05T07:26:00.630Z','2026-10-05T08:25:25.969Z','{"planning_depth":"minimal","max_iterations":5,"on_cap_hit":"halt","definitionSource":{"workItemId":"wi-define-108-a8"}}');
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
INSERT INTO checkpoint_applications VALUES('fbea8c50-92b6-4e05-94a7-66923dee6e2f','af5a015c-e9c4-439d-a97d-5c20625db661','full-build','scoping.checkpoint',1,0,'approve','V11-1 preregistered operator checkpoint: charter accepted under frozen preregistration ee2fd57b (BUILD 32768+low sole intervention)','applied','design',0,0,0,'2026-10-05T07:36:08.846Z','2026-10-05T07:36:08.860Z');
INSERT INTO checkpoint_applications VALUES('c41cbe76-81ea-49b1-be0d-b1fb0e836de5','af5a015c-e9c4-439d-a97d-5c20625db661','full-build','confirm',1,0,'approve','V11-1 operator confirm checkpoint: TEST cleared; authorizing BUILD 32768+low treatment under frozen preregistration ee2fd57b','applied','build',0,0,0,'2026-10-05T08:21:26.325Z','2026-10-05T08:21:26.337Z');
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
