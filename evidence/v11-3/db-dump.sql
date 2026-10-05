PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE _migrations (
      id         INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
INSERT INTO _migrations VALUES(1,'2026-10-05T09:33:40.910Z');
INSERT INTO _migrations VALUES(2,'2026-10-05T09:33:40.911Z');
INSERT INTO _migrations VALUES(3,'2026-10-05T09:33:40.911Z');
INSERT INTO _migrations VALUES(4,'2026-10-05T09:33:40.912Z');
INSERT INTO _migrations VALUES(5,'2026-10-05T09:33:40.912Z');
INSERT INTO _migrations VALUES(6,'2026-10-05T09:33:40.914Z');
INSERT INTO _migrations VALUES(7,'2026-10-05T09:33:40.915Z');
INSERT INTO _migrations VALUES(8,'2026-10-05T09:33:40.915Z');
INSERT INTO _migrations VALUES(9,'2026-10-05T09:33:40.916Z');
INSERT INTO _migrations VALUES(10,'2026-10-05T09:33:40.916Z');
CREATE TABLE workspaces (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
INSERT INTO workspaces VALUES('ws-pilot-a','pilot-a','2026-10-05T09:33:40.916Z');
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
INSERT INTO projects VALUES('proj-pilot-a','ws-pilot-a','student-platform',NULL,'active',0,'2026-10-05T09:33:40.916Z','2026-10-05T09:33:40.916Z');
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
INSERT INTO objectives VALUES('obj-108','proj-pilot-a','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage',replace('## Summary\n\nWorker and API disagree on the failure payload keys, so every failure persists as a generic "Processing failed" with no stage.\n\n- Worker publishes `{"error": str(e)}`:\n  `apps/ai-server/rag-worker-service/main.py:1097`\n- rag-api''s failed branch reads different keys:\n  `apps/ai-server/rag-api-service/main.py:223-226`\n\n```python\nmain_update["error"] = details.get("error_message", "Processing failed")\nmain_update["error_stage"] = details.get("stage")\nmain_update["retryable"] = details.get("retryable", True)\n```\n\nResult: `error` persists as the fallback string, `error_stage` is `None`, and `retryable` silently defaults to `True` even though the worker never sends it.\n\n## Impact\n\nFailures are undisambiguatable from the persisted record — users and support cannot tell what failed or where, and retry semantics are fabricated rather than reported.\n\n## Acceptance criteria\n\n- [ ] Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).\n- [ ] A failed job persists the worker''s actual error message and failing stage.\n- [ ] `retryable` is either sent by the worker or derived deliberately — not defaulted silently.\n- [ ] Contract test covering worker failure → rag-api persistence path.\n\n_(Salvaged from #57''s task cards after maintainer triage; see also the D3 issue filed alongside this one. Original analysis recorded in plans/upload-flow.md as deviation D4.)_','\n',char(10)),0,'active','[]','["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','2026-10-05T09:33:40.916Z','2026-10-05T09:33:40.916Z');
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
INSERT INTO work_items VALUES('wi-define-108-a8','proj-pilot-a','obj-108','[]','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','define-work','completed',0,'["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','[]','[]',NULL,'2026-10-05T09:33:40.916Z','2026-09-21T14:39:56.875Z',NULL);
INSERT INTO work_items VALUES('wi-exec-108','proj-pilot-a','obj-108','[]','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','full-build','failed',0,'["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','[]','[]',NULL,'2026-10-05T09:33:41.250Z','2026-10-05T10:20:04.145Z','{"planning_depth":"minimal","max_iterations":5,"on_cap_hit":"halt","definitionSource":{"workItemId":"wi-define-108-a8"},"editPolicy":{"appliesToSteps":["build"],"allowedEditPaths":["apps/ai-server/rag-worker-service/main.py"],"requiredEditPaths":["apps/ai-server/rag-worker-service/main.py"]}}');
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
INSERT INTO decisions VALUES('cf66c259-c495-4e18-bc62-d86a41d6b3dd','proj-pilot-a','wi-exec-108','checkpoint','{"workflowRunId":"825e8cce-7cbe-4df1-a08a-51a5a1f70b0f","workItemId":"wi-exec-108","stepId":"scoping.checkpoint"}','Workflow reached a checkpoint','Workflow ''full-build'' paused at step ''scoping.checkpoint'' and requires operator approval to continue.','[{"id":"approve","label":"Approve","description":"Accept the cycle charter and begin the cycle"}]','approve',NULL,'medium','easy','normal','resolved','{"selectedOptionId":"approve","rationale":"V11-3 preregistered operator checkpoint: charter accepted under frozen preregistration ee2fd57b (BUILD 32768+low)","resolvedAt":"2026-10-05T09:43:49.347Z","resolvedBy":"operator"}');
INSERT INTO decisions VALUES('f16c2216-2524-4e39-81d7-9bab78ba792f','proj-pilot-a','wi-exec-108','checkpoint','{"workflowRunId":"825e8cce-7cbe-4df1-a08a-51a5a1f70b0f","workItemId":"wi-exec-108","stepId":"confirm"}','Workflow reached another checkpoint','Workflow ''full-build'' paused at step ''confirm''.','[{"id":"approve","label":"Approve","description":"Continue to the build phase"},{"id":"revise","label":"Revise","description":"Send back for revision (increments revision counter)"}]','approve',NULL,'medium','easy','normal','resolved','{"selectedOptionId":"approve","rationale":"V11-3 operator confirm checkpoint: TEST cleared; authorizing the FINAL BUILD 32768+low treatment opportunity under frozen preregistration ee2fd57b","resolvedAt":"2026-10-05T10:14:07.289Z","resolvedBy":"operator"}');
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
INSERT INTO artifacts VALUES('6065bf6d-0e00-4657-97fd-80db9a70a10f','wi-exec-108','825e8cce-7cbe-4df1-a08a-51a5a1f70b0f',NULL,'cycle-charter','doc:cycle-charter','docs/cycle-charter.md','91c3a427282f86b7dc97b05822f60029d95e3a34026b376f40a36a8cdafa5c24','2026-10-05T09:34:52.884Z');
INSERT INTO artifacts VALUES('53631bbb-a6c1-400e-b781-22ae15ce9027','wi-exec-108','825e8cce-7cbe-4df1-a08a-51a5a1f70b0f',NULL,'produced-file','produced-file:design:docs/requirements.md','docs/requirements.md','22653f7104d05a870f14adcddf382d3f2d274180d7de8b289a4b8474bf67fb74','2026-10-05T09:50:46.668Z');
INSERT INTO artifacts VALUES('926c705c-00b3-4426-aae9-27c57e2e8d71','wi-exec-108','825e8cce-7cbe-4df1-a08a-51a5a1f70b0f',NULL,'produced-file','produced-file:design:docs/architecture.md','docs/architecture.md','b19cd1dcb660aac431374244e4047c625b3c5e403859fe2b75295d531b989eb9','2026-10-05T09:50:46.668Z');
INSERT INTO artifacts VALUES('462c585d-011d-4117-9fee-5f0b10586df9','wi-exec-108','825e8cce-7cbe-4df1-a08a-51a5a1f70b0f',NULL,'produced-file','produced-file:plan:docs/plan.md','docs/plan.md','0107622b3d772ecdcf73aaa8f3f83e5a7ea3f2a02fdf10a04f9e442ea33d9300','2026-10-05T10:04:37.486Z');
INSERT INTO artifacts VALUES('6f717c5e-d9f1-426d-b4be-591bf2091f30','wi-exec-108','825e8cce-7cbe-4df1-a08a-51a5a1f70b0f',NULL,'produced-file','produced-file:plan:docs/test-plan.md','docs/test-plan.md','0aa9596413f02c60b8efd416a2fa9fe077a7b76c527da711c1666b94acdcbeb8','2026-10-05T10:04:37.486Z');
INSERT INTO artifacts VALUES('d84314da-9ee3-4705-8346-c39dc4e72197','wi-exec-108','825e8cce-7cbe-4df1-a08a-51a5a1f70b0f',NULL,'produced-file','produced-file:test:apps/ai-server/tests/integration/test_worker_failure_payload_contract.py','apps/ai-server/tests/integration/test_worker_failure_payload_contract.py','880bf2e2f0c000bc426b177e6b051266d3c706099bd4f88c6f9d5744ea93ef17','2026-10-05T10:10:12.236Z');
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
INSERT INTO events VALUES('e483119d-2fe2-4834-b5e0-f9ac31c1f8b1',1,'work.started','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-05T09:33:41.712Z','{"from":"running","to":"running"}');
INSERT INTO events VALUES('40cd776e-a993-43ff-b582-8d0ddfb05475',1,'decision.requested','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-05T09:34:52.903Z','{"from":"needs_decision","decisionId":"cf66c259-c495-4e18-bc62-d86a41d6b3dd","decisionType":"checkpoint"}');
INSERT INTO events VALUES('74398195-9ae9-4cf2-9f51-b57d8b33b46d',1,'decision.resolved','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-05T09:43:49.363Z','{"from":"running","decisionId":"cf66c259-c495-4e18-bc62-d86a41d6b3dd","selectedOptionId":"approve","resumedTo":"running"}');
INSERT INTO events VALUES('83f8e2ad-de7e-4917-91e1-c95d120d40c1',1,'decision.requested','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-05T10:10:12.247Z','{"from":"needs_decision","decisionId":"f16c2216-2524-4e39-81d7-9bab78ba792f","decisionType":"checkpoint"}');
INSERT INTO events VALUES('c521b155-305d-4bed-86be-e05cb68fae98',1,'decision.resolved','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-05T10:14:07.306Z','{"from":"running","decisionId":"f16c2216-2524-4e39-81d7-9bab78ba792f","selectedOptionId":"approve","resumedTo":"running"}');
INSERT INTO events VALUES('a47febbf-aca1-4134-a583-d6784819eb70',1,'work.state_changed','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-05T10:20:04.145Z','{"from":"failed","to":"failed","reason":"Patch 1/1 for ''apps/ai-server/rag-worker-service/main.py'' rejected: Malformed diff line 9 (expected '' '', ''-'', or ''+''): ''@@ -520,2 +521,3 @@''"}');
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
INSERT INTO step_executions VALUES('9c50f062-48c8-48b4-b2c7-1d94186405f1','wi-exec-108','825e8cce-7cbe-4df1-a08a-51a5a1f70b0f','__start__','stratum-agent','succeeded',1,'2026-10-05T09:33:41.711Z','2026-10-05T09:43:49.348Z',NULL,NULL,NULL);
INSERT INTO step_executions VALUES('b516956c-121d-4494-ad62-a831b1ac55a2','wi-exec-108','825e8cce-7cbe-4df1-a08a-51a5a1f70b0f','design','stratum-agent','succeeded',1,'2026-10-05T09:43:49.348Z','2026-10-05T10:14:07.289Z',NULL,NULL,NULL);
INSERT INTO step_executions VALUES('33b71b2c-ac8f-407e-9ccf-c32b361cf061','wi-exec-108','825e8cce-7cbe-4df1-a08a-51a5a1f70b0f','build','stratum-agent','failed',1,'2026-10-05T10:14:07.289Z','2026-10-05T10:20:04.144Z',NULL,NULL,'{"code":"workflow_error","message":"Patch 1/1 for ''apps/ai-server/rag-worker-service/main.py'' rejected: Malformed diff line 9 (expected '' '', ''-'', or ''+''): ''@@ -520,2 +521,3 @@''"}');
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
INSERT INTO workflow_runs VALUES('825e8cce-7cbe-4df1-a08a-51a5a1f70b0f','full-build','wi-exec-108','halted','build',1,0,NULL,'2026-10-05T09:33:41.719Z','2026-10-05T10:20:04.143Z','{"planning_depth":"minimal","max_iterations":5,"on_cap_hit":"halt","definitionSource":{"workItemId":"wi-define-108-a8"}}');
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
INSERT INTO checkpoint_applications VALUES('cf66c259-c495-4e18-bc62-d86a41d6b3dd','825e8cce-7cbe-4df1-a08a-51a5a1f70b0f','full-build','scoping.checkpoint',1,0,'approve','V11-3 preregistered operator checkpoint: charter accepted under frozen preregistration ee2fd57b (BUILD 32768+low)','applied','design',0,0,0,'2026-10-05T09:43:49.352Z','2026-10-05T09:43:49.363Z');
INSERT INTO checkpoint_applications VALUES('f16c2216-2524-4e39-81d7-9bab78ba792f','825e8cce-7cbe-4df1-a08a-51a5a1f70b0f','full-build','confirm',1,0,'approve','V11-3 operator confirm checkpoint: TEST cleared; authorizing the FINAL BUILD 32768+low treatment opportunity under frozen preregistration ee2fd57b','applied','build',0,0,0,'2026-10-05T10:14:07.294Z','2026-10-05T10:14:07.305Z');
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
