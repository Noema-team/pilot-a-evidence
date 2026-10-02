PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE _migrations (
      id         INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
INSERT INTO _migrations VALUES(1,'2026-10-02T15:59:27.363Z');
INSERT INTO _migrations VALUES(2,'2026-10-02T15:59:27.363Z');
INSERT INTO _migrations VALUES(3,'2026-10-02T15:59:27.364Z');
INSERT INTO _migrations VALUES(4,'2026-10-02T15:59:27.364Z');
INSERT INTO _migrations VALUES(5,'2026-10-02T15:59:27.364Z');
INSERT INTO _migrations VALUES(6,'2026-10-02T15:59:27.366Z');
INSERT INTO _migrations VALUES(7,'2026-10-02T15:59:27.367Z');
INSERT INTO _migrations VALUES(8,'2026-10-02T15:59:27.367Z');
INSERT INTO _migrations VALUES(9,'2026-10-02T15:59:27.368Z');
INSERT INTO _migrations VALUES(10,'2026-10-02T15:59:27.368Z');
CREATE TABLE workspaces (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
INSERT INTO workspaces VALUES('ws-pilot-a','pilot-a','2026-10-02T15:59:27.368Z');
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
INSERT INTO projects VALUES('proj-pilot-a','ws-pilot-a','student-platform',NULL,'active',0,'2026-10-02T15:59:27.368Z','2026-10-02T15:59:27.368Z');
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
INSERT INTO objectives VALUES('obj-108','proj-pilot-a','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage',replace('## Summary\n\nWorker and API disagree on the failure payload keys, so every failure persists as a generic "Processing failed" with no stage.\n\n- Worker publishes `{"error": str(e)}`:\n  `apps/ai-server/rag-worker-service/main.py:1097`\n- rag-api''s failed branch reads different keys:\n  `apps/ai-server/rag-api-service/main.py:223-226`\n\n```python\nmain_update["error"] = details.get("error_message", "Processing failed")\nmain_update["error_stage"] = details.get("stage")\nmain_update["retryable"] = details.get("retryable", True)\n```\n\nResult: `error` persists as the fallback string, `error_stage` is `None`, and `retryable` silently defaults to `True` even though the worker never sends it.\n\n## Impact\n\nFailures are undisambiguatable from the persisted record — users and support cannot tell what failed or where, and retry semantics are fabricated rather than reported.\n\n## Acceptance criteria\n\n- [ ] Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).\n- [ ] A failed job persists the worker''s actual error message and failing stage.\n- [ ] `retryable` is either sent by the worker or derived deliberately — not defaulted silently.\n- [ ] Contract test covering worker failure → rag-api persistence path.\n\n_(Salvaged from #57''s task cards after maintainer triage; see also the D3 issue filed alongside this one. Original analysis recorded in plans/upload-flow.md as deviation D4.)_','\n',char(10)),0,'active','[]','["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','2026-10-02T15:59:27.368Z','2026-10-02T15:59:27.368Z');
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
INSERT INTO work_items VALUES('wi-define-108-a8','proj-pilot-a','obj-108','[]','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','define-work','completed',0,'["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','[]','[]',NULL,'2026-10-02T15:59:27.368Z','2026-09-21T14:39:56.875Z',NULL);
INSERT INTO work_items VALUES('wi-exec-108','proj-pilot-a','obj-108','[]','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','full-build','failed',0,'["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','[]','[]',NULL,'2026-10-02T15:59:27.676Z','2026-10-02T16:51:10.011Z','{"planning_depth":"minimal","max_iterations":5,"on_cap_hit":"halt","definitionSource":{"workItemId":"wi-define-108-a8"},"editPolicy":{"appliesToSteps":["build"],"allowedEditPaths":["apps/ai-server/rag-worker-service/main.py"],"requiredEditPaths":["apps/ai-server/rag-worker-service/main.py"]}}');
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
INSERT INTO decisions VALUES('d7557405-61c9-4cc5-9598-1ac0b7d99662','proj-pilot-a','wi-exec-108','checkpoint','{"workflowRunId":"0914930a-5dcf-41c8-875e-6648e89b0e30","workItemId":"wi-exec-108","stepId":"scoping.checkpoint"}','Workflow reached a checkpoint','Workflow ''full-build'' paused at step ''scoping.checkpoint'' and requires operator approval to continue.','[{"id":"approve","label":"Approve","description":"Accept the cycle charter and begin the cycle"}]','approve',NULL,'medium','easy','normal','resolved','{"selectedOptionId":"approve","rationale":"V8-4 preregistered operator checkpoint: charter accepted under frozen preregistration 5159cdaa (baseline b6dbcd36, TEST effort=low)","resolvedAt":"2026-10-02T16:09:36.037Z","resolvedBy":"operator"}');
INSERT INTO decisions VALUES('a8484815-c8de-4c01-88fd-d5ebe0a5016f','proj-pilot-a','wi-exec-108','checkpoint','{"workflowRunId":"0914930a-5dcf-41c8-875e-6648e89b0e30","workItemId":"wi-exec-108","stepId":"confirm"}','Workflow reached another checkpoint','Workflow ''full-build'' paused at step ''confirm''.','[{"id":"approve","label":"Approve","description":"Continue to the build phase"},{"id":"revise","label":"Revise","description":"Send back for revision (increments revision counter)"}]','approve',NULL,'medium','easy','normal','resolved','{"selectedOptionId":"approve","rationale":"V8-4 operator confirm checkpoint: TEST cleared under effort=low (plan repair-mediated); authorizing BUILD sentinel under frozen preregistration 5159cdaa","resolvedAt":"2026-10-02T16:41:05.440Z","resolvedBy":"operator"}');
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
INSERT INTO artifacts VALUES('08cddfec-3e74-491d-bd23-5e251bf0eb05','wi-exec-108','0914930a-5dcf-41c8-875e-6648e89b0e30',NULL,'cycle-charter','doc:cycle-charter','docs/cycle-charter.md','cf184d5cf797edcbc09fdfd1a887ea7727e4b9c141e102a7c39db9732bb98dfd','2026-10-02T16:01:29.545Z');
INSERT INTO artifacts VALUES('08798136-1396-4b47-8c35-522c2c3de169','wi-exec-108','0914930a-5dcf-41c8-875e-6648e89b0e30',NULL,'produced-file','produced-file:design:docs/requirements.md','docs/requirements.md','8670277f3cb6ea1bb705fc049b38e55cb5e2d8cedc25d5af366023ad6378584c','2026-10-02T16:11:41.512Z');
INSERT INTO artifacts VALUES('7d3d81e4-9ee4-4773-b02d-ebae49598c2e','wi-exec-108','0914930a-5dcf-41c8-875e-6648e89b0e30',NULL,'produced-file','produced-file:design:docs/architecture.md','docs/architecture.md','0f22e9a50bd4a7c497f6309b8716c34542453668489480c37c1131b1228ce681','2026-10-02T16:11:41.512Z');
INSERT INTO artifacts VALUES('8743c578-c414-46fb-b7b4-429b27e573c1','wi-exec-108','0914930a-5dcf-41c8-875e-6648e89b0e30',NULL,'produced-file','produced-file:plan:docs/plan.md','docs/plan.md','8134f6292a808108407dde766d9e2e0b22c448f4d58955b0b7144a7a22afadb2','2026-10-02T16:26:04.737Z');
INSERT INTO artifacts VALUES('4357b009-e596-4223-b6a9-c61ed60659e7','wi-exec-108','0914930a-5dcf-41c8-875e-6648e89b0e30',NULL,'produced-file','produced-file:plan:docs/test-plan.md','docs/test-plan.md','be29b36576a99eeffc842629f1f2b9f71398c8208075b3e0a61f0e28eb9568c2','2026-10-02T16:26:04.738Z');
INSERT INTO artifacts VALUES('07678e79-fc9f-47c5-bea7-9da11e7243de','wi-exec-108','0914930a-5dcf-41c8-875e-6648e89b0e30',NULL,'produced-file','produced-file:test:apps/ai-server/tests/integration/test_worker_failure_payload_contract.py','apps/ai-server/tests/integration/test_worker_failure_payload_contract.py','e8bdccf48ecd791f2c44094eb7fd172cc11250d2f2aff903a1eb976f12828aca','2026-10-02T16:28:34.864Z');
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
INSERT INTO events VALUES('4ad048a7-c64f-415e-a111-a201986206f7',1,'work.started','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-02T15:59:28.011Z','{"from":"running","to":"running"}');
INSERT INTO events VALUES('da5a6424-0385-49e8-802d-f81f19f82add',1,'decision.requested','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-02T16:01:29.572Z','{"from":"needs_decision","decisionId":"d7557405-61c9-4cc5-9598-1ac0b7d99662","decisionType":"checkpoint"}');
INSERT INTO events VALUES('5c2ff9cd-257f-4f1a-9265-977ac175abc4',1,'decision.resolved','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-02T16:09:36.057Z','{"from":"running","decisionId":"d7557405-61c9-4cc5-9598-1ac0b7d99662","selectedOptionId":"approve","resumedTo":"running"}');
INSERT INTO events VALUES('d7618fb7-208f-44b8-bb75-528c131e3505',1,'decision.requested','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-02T16:28:34.885Z','{"from":"needs_decision","decisionId":"a8484815-c8de-4c01-88fd-d5ebe0a5016f","decisionType":"checkpoint"}');
INSERT INTO events VALUES('b1f70e6d-e55e-4403-bf22-0890c09aca0b',1,'decision.resolved','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-02T16:41:05.457Z','{"from":"running","decisionId":"a8484815-c8de-4c01-88fd-d5ebe0a5016f","selectedOptionId":"approve","resumedTo":"running"}');
INSERT INTO events VALUES('1a07bcf5-b217-401c-a4cf-e1e82e388a42',1,'work.state_changed','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-02T16:51:10.011Z','{"from":"failed","to":"failed","reason":"Agent exhausted max_tokens without producing a result block"}');
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
INSERT INTO step_executions VALUES('9a3c67bf-82e8-4f9a-bb1f-e311337e1f56','wi-exec-108','0914930a-5dcf-41c8-875e-6648e89b0e30','__start__','stratum-agent','succeeded',1,'2026-10-02T15:59:28.010Z','2026-10-02T16:09:36.038Z',NULL,NULL,NULL);
INSERT INTO step_executions VALUES('bdc5b0a5-fcff-4655-9236-6120735bdf31','wi-exec-108','0914930a-5dcf-41c8-875e-6648e89b0e30','design','stratum-agent','succeeded',1,'2026-10-02T16:09:36.038Z','2026-10-02T16:41:05.442Z',NULL,NULL,NULL);
INSERT INTO step_executions VALUES('d4db918d-3752-46fe-b155-308402f0b489','wi-exec-108','0914930a-5dcf-41c8-875e-6648e89b0e30','build','stratum-agent','failed',1,'2026-10-02T16:41:05.442Z','2026-10-02T16:51:10.010Z',NULL,NULL,'{"code":"workflow_error","message":"Agent exhausted max_tokens without producing a result block"}');
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
INSERT INTO workflow_runs VALUES('0914930a-5dcf-41c8-875e-6648e89b0e30','full-build','wi-exec-108','halted','build',1,0,NULL,'2026-10-02T15:59:28.016Z','2026-10-02T16:51:10.009Z','{"planning_depth":"minimal","max_iterations":5,"on_cap_hit":"halt","definitionSource":{"workItemId":"wi-define-108-a8"}}');
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
INSERT INTO checkpoint_applications VALUES('d7557405-61c9-4cc5-9598-1ac0b7d99662','0914930a-5dcf-41c8-875e-6648e89b0e30','full-build','scoping.checkpoint',1,0,'approve','V8-4 preregistered operator checkpoint: charter accepted under frozen preregistration 5159cdaa (baseline b6dbcd36, TEST effort=low)','applied','design',0,0,0,'2026-10-02T16:09:36.041Z','2026-10-02T16:09:36.056Z');
INSERT INTO checkpoint_applications VALUES('a8484815-c8de-4c01-88fd-d5ebe0a5016f','0914930a-5dcf-41c8-875e-6648e89b0e30','full-build','confirm',1,0,'approve','V8-4 operator confirm checkpoint: TEST cleared under effort=low (plan repair-mediated); authorizing BUILD sentinel under frozen preregistration 5159cdaa','applied','build',0,0,0,'2026-10-02T16:41:05.445Z','2026-10-02T16:41:05.456Z');
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
