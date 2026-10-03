PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE _migrations (
      id         INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
INSERT INTO _migrations VALUES(1,'2026-10-03T12:14:05.836Z');
INSERT INTO _migrations VALUES(2,'2026-10-03T12:14:05.837Z');
INSERT INTO _migrations VALUES(3,'2026-10-03T12:14:05.837Z');
INSERT INTO _migrations VALUES(4,'2026-10-03T12:14:05.838Z');
INSERT INTO _migrations VALUES(5,'2026-10-03T12:14:05.838Z');
INSERT INTO _migrations VALUES(6,'2026-10-03T12:14:05.840Z');
INSERT INTO _migrations VALUES(7,'2026-10-03T12:14:05.840Z');
INSERT INTO _migrations VALUES(8,'2026-10-03T12:14:05.840Z');
INSERT INTO _migrations VALUES(9,'2026-10-03T12:14:05.841Z');
INSERT INTO _migrations VALUES(10,'2026-10-03T12:14:05.841Z');
CREATE TABLE workspaces (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
INSERT INTO workspaces VALUES('ws-pilot-a','pilot-a','2026-10-03T12:14:05.841Z');
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
INSERT INTO projects VALUES('proj-pilot-a','ws-pilot-a','student-platform',NULL,'active',0,'2026-10-03T12:14:05.841Z','2026-10-03T12:14:05.841Z');
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
INSERT INTO objectives VALUES('obj-108','proj-pilot-a','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage',replace('## Summary\n\nWorker and API disagree on the failure payload keys, so every failure persists as a generic "Processing failed" with no stage.\n\n- Worker publishes `{"error": str(e)}`:\n  `apps/ai-server/rag-worker-service/main.py:1097`\n- rag-api''s failed branch reads different keys:\n  `apps/ai-server/rag-api-service/main.py:223-226`\n\n```python\nmain_update["error"] = details.get("error_message", "Processing failed")\nmain_update["error_stage"] = details.get("stage")\nmain_update["retryable"] = details.get("retryable", True)\n```\n\nResult: `error` persists as the fallback string, `error_stage` is `None`, and `retryable` silently defaults to `True` even though the worker never sends it.\n\n## Impact\n\nFailures are undisambiguatable from the persisted record — users and support cannot tell what failed or where, and retry semantics are fabricated rather than reported.\n\n## Acceptance criteria\n\n- [ ] Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).\n- [ ] A failed job persists the worker''s actual error message and failing stage.\n- [ ] `retryable` is either sent by the worker or derived deliberately — not defaulted silently.\n- [ ] Contract test covering worker failure → rag-api persistence path.\n\n_(Salvaged from #57''s task cards after maintainer triage; see also the D3 issue filed alongside this one. Original analysis recorded in plans/upload-flow.md as deviation D4.)_','\n',char(10)),0,'active','[]','["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','2026-10-03T12:14:05.841Z','2026-10-03T12:14:05.841Z');
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
INSERT INTO work_items VALUES('wi-define-108-a8','proj-pilot-a','obj-108','[]','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','define-work','completed',0,'["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','[]','[]',NULL,'2026-10-03T12:14:05.841Z','2026-09-21T14:39:56.875Z',NULL);
INSERT INTO work_items VALUES('wi-exec-108','proj-pilot-a','obj-108','[]','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','full-build','failed',0,'["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','[]','[]',NULL,'2026-10-03T12:14:06.121Z','2026-10-03T13:22:22.500Z','{"planning_depth":"minimal","max_iterations":5,"on_cap_hit":"halt","definitionSource":{"workItemId":"wi-define-108-a8"},"editPolicy":{"appliesToSteps":["build"],"allowedEditPaths":["apps/ai-server/rag-worker-service/main.py"],"requiredEditPaths":["apps/ai-server/rag-worker-service/main.py"]}}');
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
INSERT INTO decisions VALUES('99e0a414-2fef-4522-95ce-8e462499bacb','proj-pilot-a','wi-exec-108','checkpoint','{"workflowRunId":"d5993dc5-9562-4855-a929-0bcf04cbb0e1","workItemId":"wi-exec-108","stepId":"scoping.checkpoint"}','Workflow reached a checkpoint','Workflow ''full-build'' paused at step ''scoping.checkpoint'' and requires operator approval to continue.','[{"id":"approve","label":"Approve","description":"Accept the cycle charter and begin the cycle"}]','approve',NULL,'medium','easy','normal','resolved','{"selectedOptionId":"approve","rationale":"V9-1 retry preregistered operator checkpoint: charter accepted under frozen preregistration 769367b1 (censoring re-run, baseline b6dbcd36)","resolvedAt":"2026-10-03T12:24:13.960Z","resolvedBy":"operator"}');
INSERT INTO decisions VALUES('d482ab2a-f99a-499b-bfbf-c06ff9f8faf0','proj-pilot-a','wi-exec-108','checkpoint','{"workflowRunId":"d5993dc5-9562-4855-a929-0bcf04cbb0e1","workItemId":"wi-exec-108","stepId":"confirm"}','Workflow reached another checkpoint','Workflow ''full-build'' paused at step ''confirm''.','[{"id":"approve","label":"Approve","description":"Continue to the build phase"},{"id":"revise","label":"Revise","description":"Send back for revision (increments revision counter)"}]','approve',NULL,'medium','easy','normal','resolved','{"selectedOptionId":"approve","rationale":"V9-1 operator confirm checkpoint: TEST cleared under effort=low; authorizing BUILD 16384+low treatment under frozen preregistration 769367b1","resolvedAt":"2026-10-03T13:09:31.121Z","resolvedBy":"operator"}');
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
INSERT INTO artifacts VALUES('bf0f607a-8394-4d0d-a9ba-3ae2ca16daea','wi-exec-108','d5993dc5-9562-4855-a929-0bcf04cbb0e1',NULL,'cycle-charter','doc:cycle-charter','docs/cycle-charter.md','6a16680c0155b242059caaf66777bcfa4005cc6b0a67b5034b1d71793367df80','2026-10-03T12:17:19.035Z');
INSERT INTO artifacts VALUES('bf4fafe0-a018-4161-854b-b22ed8fd8255','wi-exec-108','d5993dc5-9562-4855-a929-0bcf04cbb0e1',NULL,'produced-file','produced-file:design:docs/requirements.md','docs/requirements.md','9847fee478b83702c823abaa5c1889b6fa8782d59567c5940bce8739c8fc512e','2026-10-03T12:35:31.599Z');
INSERT INTO artifacts VALUES('6b67e303-8db8-4cef-9e2f-78047804426b','wi-exec-108','d5993dc5-9562-4855-a929-0bcf04cbb0e1',NULL,'produced-file','produced-file:design:docs/architecture.md','docs/architecture.md','a22127633b710d75ad59aaed0a4b01e3d6e1b4cb13c50bfd7331624fc4bcbd53','2026-10-03T12:35:31.599Z');
INSERT INTO artifacts VALUES('f4482575-3316-4d8c-9808-67da7812f4ff','wi-exec-108','d5993dc5-9562-4855-a929-0bcf04cbb0e1',NULL,'produced-file','produced-file:plan:docs/plan.md','docs/plan.md','f0b9eebd2ff39a20c947cca7bad3d7b4db647744f02954961ad2e8289a09c213','2026-10-03T12:50:33.708Z');
INSERT INTO artifacts VALUES('6bebe817-df25-41ba-9920-2c9c23a6814f','wi-exec-108','d5993dc5-9562-4855-a929-0bcf04cbb0e1',NULL,'produced-file','produced-file:plan:docs/test-plan.md','docs/test-plan.md','0de084e8119fd4a62172b0339ec1241fe73c350ebf665450bc163e78867b050b','2026-10-03T12:50:33.709Z');
INSERT INTO artifacts VALUES('a393ef07-9306-4cf6-901a-f6d7f9eceb05','wi-exec-108','d5993dc5-9562-4855-a929-0bcf04cbb0e1',NULL,'produced-file','produced-file:test:apps/ai-server/tests/integration/test_worker_failure_contract.py','apps/ai-server/tests/integration/test_worker_failure_contract.py','972b6c9a67ed732cac378ee72b2058bf6153a4206279b0cac4ee4bd27d52d96d','2026-10-03T12:55:02.352Z');
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
INSERT INTO events VALUES('4ee48fc0-ebef-4aa1-9870-e750b31ac410',1,'work.started','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-03T12:14:06.444Z','{"from":"running","to":"running"}');
INSERT INTO events VALUES('7f9c22d9-2927-43db-bae6-05b0000d3ff8',1,'decision.requested','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-03T12:17:19.055Z','{"from":"needs_decision","decisionId":"99e0a414-2fef-4522-95ce-8e462499bacb","decisionType":"checkpoint"}');
INSERT INTO events VALUES('de7fcbea-2839-4998-87e6-facc290f2ff3',1,'decision.resolved','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-03T12:24:13.978Z','{"from":"running","decisionId":"99e0a414-2fef-4522-95ce-8e462499bacb","selectedOptionId":"approve","resumedTo":"running"}');
INSERT INTO events VALUES('ff37e38a-3824-4694-9d74-a406f0c2acc0',1,'decision.requested','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-03T12:55:02.363Z','{"from":"needs_decision","decisionId":"d482ab2a-f99a-499b-bfbf-c06ff9f8faf0","decisionType":"checkpoint"}');
INSERT INTO events VALUES('15a2aa93-39dd-4ed1-bbc1-4f328a5ac9cc',1,'decision.resolved','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-03T13:09:31.140Z','{"from":"running","decisionId":"d482ab2a-f99a-499b-bfbf-c06ff9f8faf0","selectedOptionId":"approve","resumedTo":"running"}');
INSERT INTO events VALUES('866ba920-30dd-4d89-b6a6-b70c4820819a',1,'work.state_changed','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-03T13:22:22.500Z','{"from":"failed","to":"failed","reason":"Patch 1/1 for ''apps/ai-server/rag-worker-service/main.py'' rejected: Malformed diff line 19 (expected '' '', ''-'', or ''+''): ''@@ -989,6 +993,7 @@''"}');
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
INSERT INTO step_executions VALUES('3ce44549-d975-4eb0-91a3-31bca0e89f50','wi-exec-108','d5993dc5-9562-4855-a929-0bcf04cbb0e1','__start__','stratum-agent','succeeded',1,'2026-10-03T12:14:06.443Z','2026-10-03T12:24:13.960Z',NULL,NULL,NULL);
INSERT INTO step_executions VALUES('1b96e8b1-244f-4617-a2ec-e52b5e6f8071','wi-exec-108','d5993dc5-9562-4855-a929-0bcf04cbb0e1','design','stratum-agent','succeeded',1,'2026-10-03T12:24:13.960Z','2026-10-03T13:09:31.122Z',NULL,NULL,NULL);
INSERT INTO step_executions VALUES('71d49908-c924-4347-a886-1e29f39188f3','wi-exec-108','d5993dc5-9562-4855-a929-0bcf04cbb0e1','build','stratum-agent','failed',1,'2026-10-03T13:09:31.122Z','2026-10-03T13:22:22.499Z',NULL,NULL,'{"code":"workflow_error","message":"Patch 1/1 for ''apps/ai-server/rag-worker-service/main.py'' rejected: Malformed diff line 19 (expected '' '', ''-'', or ''+''): ''@@ -989,6 +993,7 @@''"}');
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
INSERT INTO workflow_runs VALUES('d5993dc5-9562-4855-a929-0bcf04cbb0e1','full-build','wi-exec-108','halted','build',1,0,NULL,'2026-10-03T12:14:06.449Z','2026-10-03T13:22:22.498Z','{"planning_depth":"minimal","max_iterations":5,"on_cap_hit":"halt","definitionSource":{"workItemId":"wi-define-108-a8"}}');
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
INSERT INTO checkpoint_applications VALUES('99e0a414-2fef-4522-95ce-8e462499bacb','d5993dc5-9562-4855-a929-0bcf04cbb0e1','full-build','scoping.checkpoint',1,0,'approve','V9-1 retry preregistered operator checkpoint: charter accepted under frozen preregistration 769367b1 (censoring re-run, baseline b6dbcd36)','applied','design',0,0,0,'2026-10-03T12:24:13.964Z','2026-10-03T12:24:13.977Z');
INSERT INTO checkpoint_applications VALUES('d482ab2a-f99a-499b-bfbf-c06ff9f8faf0','d5993dc5-9562-4855-a929-0bcf04cbb0e1','full-build','confirm',1,0,'approve','V9-1 operator confirm checkpoint: TEST cleared under effort=low; authorizing BUILD 16384+low treatment under frozen preregistration 769367b1','applied','build',0,0,0,'2026-10-03T13:09:31.125Z','2026-10-03T13:09:31.139Z');
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
