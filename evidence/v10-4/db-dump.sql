PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE _migrations (
      id         INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
INSERT INTO _migrations VALUES(1,'2026-10-04T19:28:46.758Z');
INSERT INTO _migrations VALUES(2,'2026-10-04T19:28:46.759Z');
INSERT INTO _migrations VALUES(3,'2026-10-04T19:28:46.760Z');
INSERT INTO _migrations VALUES(4,'2026-10-04T19:28:46.761Z');
INSERT INTO _migrations VALUES(5,'2026-10-04T19:28:46.762Z');
INSERT INTO _migrations VALUES(6,'2026-10-04T19:28:46.765Z');
INSERT INTO _migrations VALUES(7,'2026-10-04T19:28:46.766Z');
INSERT INTO _migrations VALUES(8,'2026-10-04T19:28:46.767Z');
INSERT INTO _migrations VALUES(9,'2026-10-04T19:28:46.768Z');
INSERT INTO _migrations VALUES(10,'2026-10-04T19:28:46.768Z');
CREATE TABLE workspaces (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
INSERT INTO workspaces VALUES('ws-pilot-a','pilot-a','2026-10-04T19:28:46.768Z');
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
INSERT INTO projects VALUES('proj-pilot-a','ws-pilot-a','student-platform',NULL,'active',0,'2026-10-04T19:28:46.768Z','2026-10-04T19:28:46.768Z');
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
INSERT INTO objectives VALUES('obj-108','proj-pilot-a','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage',replace('## Summary\n\nWorker and API disagree on the failure payload keys, so every failure persists as a generic "Processing failed" with no stage.\n\n- Worker publishes `{"error": str(e)}`:\n  `apps/ai-server/rag-worker-service/main.py:1097`\n- rag-api''s failed branch reads different keys:\n  `apps/ai-server/rag-api-service/main.py:223-226`\n\n```python\nmain_update["error"] = details.get("error_message", "Processing failed")\nmain_update["error_stage"] = details.get("stage")\nmain_update["retryable"] = details.get("retryable", True)\n```\n\nResult: `error` persists as the fallback string, `error_stage` is `None`, and `retryable` silently defaults to `True` even though the worker never sends it.\n\n## Impact\n\nFailures are undisambiguatable from the persisted record — users and support cannot tell what failed or where, and retry semantics are fabricated rather than reported.\n\n## Acceptance criteria\n\n- [ ] Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).\n- [ ] A failed job persists the worker''s actual error message and failing stage.\n- [ ] `retryable` is either sent by the worker or derived deliberately — not defaulted silently.\n- [ ] Contract test covering worker failure → rag-api persistence path.\n\n_(Salvaged from #57''s task cards after maintainer triage; see also the D3 issue filed alongside this one. Original analysis recorded in plans/upload-flow.md as deviation D4.)_','\n',char(10)),0,'active','[]','["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','2026-10-04T19:28:46.768Z','2026-10-04T19:28:46.768Z');
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
INSERT INTO work_items VALUES('wi-define-108-a8','proj-pilot-a','obj-108','[]','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','define-work','completed',0,'["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','[]','[]',NULL,'2026-10-04T19:28:46.768Z','2026-09-21T14:39:56.875Z',NULL);
INSERT INTO work_items VALUES('wi-exec-108','proj-pilot-a','obj-108','[]','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage','full-build','failed',0,'["Failure payload keys match across worker and rag-api (aligning the worker to `error_message`/`stage` matches rag-api''s persisted fields and avoids a migration).","A failed job persists the worker''s actual error message and failing stage.","`retryable` is either sent by the worker or derived deliberately — not defaulted silently.","Contract test covering worker failure → rag-api persistence path."]','[]','[]',NULL,'2026-10-04T19:28:47.085Z','2026-10-04T20:13:48.876Z','{"planning_depth":"minimal","max_iterations":5,"on_cap_hit":"halt","definitionSource":{"workItemId":"wi-define-108-a8"},"editPolicy":{"appliesToSteps":["build"],"allowedEditPaths":["apps/ai-server/rag-worker-service/main.py"],"requiredEditPaths":["apps/ai-server/rag-worker-service/main.py"]}}');
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
INSERT INTO decisions VALUES('96713425-e8e1-49d3-a983-e57c1a2e0c0b','proj-pilot-a','wi-exec-108','checkpoint','{"workflowRunId":"d1fcd190-7b5c-49e6-903c-328745081e7c","workItemId":"wi-exec-108","stepId":"scoping.checkpoint"}','Workflow reached a checkpoint','Workflow ''full-build'' paused at step ''scoping.checkpoint'' and requires operator approval to continue.','[{"id":"approve","label":"Approve","description":"Accept the cycle charter and begin the cycle"}]','approve',NULL,'medium','easy','normal','resolved','{"selectedOptionId":"approve","rationale":"V10-4 preregistered operator checkpoint: charter accepted under frozen preregistration e997a4ee (BUILD effort=medium)","resolvedAt":"2026-10-04T19:38:59.589Z","resolvedBy":"operator"}');
INSERT INTO decisions VALUES('5baaf92b-cd15-468f-8c07-651b78e86ddd','proj-pilot-a','wi-exec-108','checkpoint','{"workflowRunId":"d1fcd190-7b5c-49e6-903c-328745081e7c","workItemId":"wi-exec-108","stepId":"confirm"}','Workflow reached another checkpoint','Workflow ''full-build'' paused at step ''confirm''.','[{"id":"approve","label":"Approve","description":"Continue to the build phase"},{"id":"revise","label":"Revise","description":"Send back for revision (increments revision counter)"}]','approve',NULL,'medium','easy','normal','resolved','{"selectedOptionId":"approve","rationale":"V10-4 operator confirm checkpoint: TEST cleared; authorizing the FINAL BUILD 16384+medium treatment opportunity under frozen preregistration e997a4ee","resolvedAt":"2026-10-04T20:09:13.235Z","resolvedBy":"operator"}');
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
INSERT INTO artifacts VALUES('1c21efc0-6571-4faa-96b7-5611e4cde88d','wi-exec-108','d1fcd190-7b5c-49e6-903c-328745081e7c',NULL,'cycle-charter','doc:cycle-charter','docs/cycle-charter.md','5415c39fba418a64f0494f67f9a32bf0cbeda618d7f9a244a09348ff9914ee6b','2026-10-04T19:31:26.926Z');
INSERT INTO artifacts VALUES('7c5f59c7-65a0-419a-8ed0-976eaf374e4e','wi-exec-108','d1fcd190-7b5c-49e6-903c-328745081e7c',NULL,'produced-file','produced-file:design:docs/requirements.md','docs/requirements.md','16fc5e9d2fc856be97fc04896fbaf62d09f8c8c23a0c6c17089e24b91d4a1ad1','2026-10-04T19:47:43.064Z');
INSERT INTO artifacts VALUES('61ea9a9c-b431-4206-9b32-31dd9604d468','wi-exec-108','d1fcd190-7b5c-49e6-903c-328745081e7c',NULL,'produced-file','produced-file:design:docs/architecture.md','docs/architecture.md','a35a0775ae99611ef12787603a17010af3dd352ff08958ae663c3309cec7bfe8','2026-10-04T19:47:43.064Z');
INSERT INTO artifacts VALUES('bfe1b3c1-0f13-4b66-8f10-9c32313f7c13','wi-exec-108','d1fcd190-7b5c-49e6-903c-328745081e7c',NULL,'produced-file','produced-file:plan:docs/plan.md','docs/plan.md','cbd0bb5f1478050893854a87734737374f64d7bec5df5b938e42b17086a207ae','2026-10-04T19:52:06.085Z');
INSERT INTO artifacts VALUES('dcd63255-5879-481a-9bbf-61e05a167af8','wi-exec-108','d1fcd190-7b5c-49e6-903c-328745081e7c',NULL,'produced-file','produced-file:plan:docs/test-plan.md','docs/test-plan.md','08e1473421b72fd37d7c2d8d88317109b54d2df289e6211d9ea395fafc941166','2026-10-04T19:52:06.086Z');
INSERT INTO artifacts VALUES('7322576c-6c1e-4ed5-8fde-9e76728ac8a4','wi-exec-108','d1fcd190-7b5c-49e6-903c-328745081e7c',NULL,'produced-file','produced-file:test:apps/ai-server/tests/integration/test_worker_failure_payload_contract.py','apps/ai-server/tests/integration/test_worker_failure_payload_contract.py','edeb4ca49122111c18924bc3eb6136eaba082f0b0606cc44aa2aa46128875043','2026-10-04T19:59:13.329Z');
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
INSERT INTO events VALUES('f47c48c2-8da9-4648-aeae-0bb3994ecb42',1,'work.started','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-04T19:28:47.479Z','{"from":"running","to":"running"}');
INSERT INTO events VALUES('8e192d30-5fe8-4900-9ed6-456132a7dd36',1,'decision.requested','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-04T19:31:26.943Z','{"from":"needs_decision","decisionId":"96713425-e8e1-49d3-a983-e57c1a2e0c0b","decisionType":"checkpoint"}');
INSERT INTO events VALUES('283834b3-3923-40c2-9623-a5ad327aec11',1,'decision.resolved','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-04T19:38:59.603Z','{"from":"running","decisionId":"96713425-e8e1-49d3-a983-e57c1a2e0c0b","selectedOptionId":"approve","resumedTo":"running"}');
INSERT INTO events VALUES('162d4375-bf60-4c16-86f3-f6d66c48dc56',1,'decision.requested','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-04T19:59:13.343Z','{"from":"needs_decision","decisionId":"5baaf92b-cd15-468f-8c07-651b78e86ddd","decisionType":"checkpoint"}');
INSERT INTO events VALUES('886c1976-3d5e-444e-a7f5-6019b9495b78',1,'decision.resolved','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-04T20:09:13.251Z','{"from":"running","decisionId":"5baaf92b-cd15-468f-8c07-651b78e86ddd","selectedOptionId":"approve","resumedTo":"running"}');
INSERT INTO events VALUES('66f96fb2-7c24-4820-ab1e-3e46bd1b9853',1,'work.state_changed','ws-pilot-a','proj-pilot-a','wi-exec-108',NULL,'2026-10-04T20:13:48.876Z','{"from":"failed","to":"failed","reason":"Agent reply carried a malformed result block and format repair is exhausted (20 provider turn(s), 1 format-repair attempt(s)): Malformed artifact marker (expected ''<<<SLE-ARTIFACT path=\"<path>\">>>''): <<<SLE-ARTIFACT path=\"apps/ai-server/tests/integration/test_worker_failure_payload_contract.py\">>"}');
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
INSERT INTO step_executions VALUES('241629af-4138-4ea7-ac1b-f13612249843','wi-exec-108','d1fcd190-7b5c-49e6-903c-328745081e7c','__start__','stratum-agent','succeeded',1,'2026-10-04T19:28:47.478Z','2026-10-04T19:38:59.590Z',NULL,NULL,NULL);
INSERT INTO step_executions VALUES('762dd591-e31c-4a37-8eac-bc7f821f5351','wi-exec-108','d1fcd190-7b5c-49e6-903c-328745081e7c','design','stratum-agent','succeeded',1,'2026-10-04T19:38:59.590Z','2026-10-04T20:09:13.236Z',NULL,NULL,NULL);
INSERT INTO step_executions VALUES('75b0a0b3-e0e6-4cc4-a0ac-cfee29d10f5a','wi-exec-108','d1fcd190-7b5c-49e6-903c-328745081e7c','build','stratum-agent','failed',1,'2026-10-04T20:09:13.236Z','2026-10-04T20:13:48.875Z',NULL,NULL,'{"code":"workflow_error","message":"Agent reply carried a malformed result block and format repair is exhausted (20 provider turn(s), 1 format-repair attempt(s)): Malformed artifact marker (expected ''<<<SLE-ARTIFACT path=\"<path>\">>>''): <<<SLE-ARTIFACT path=\"apps/ai-server/tests/integration/test_worker_failure_payload_contract.py\">>"}');
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
INSERT INTO workflow_runs VALUES('d1fcd190-7b5c-49e6-903c-328745081e7c','full-build','wi-exec-108','halted','build',1,0,NULL,'2026-10-04T19:28:47.488Z','2026-10-04T20:13:48.874Z','{"planning_depth":"minimal","max_iterations":5,"on_cap_hit":"halt","definitionSource":{"workItemId":"wi-define-108-a8"}}');
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
INSERT INTO checkpoint_applications VALUES('96713425-e8e1-49d3-a983-e57c1a2e0c0b','d1fcd190-7b5c-49e6-903c-328745081e7c','full-build','scoping.checkpoint',1,0,'approve','V10-4 preregistered operator checkpoint: charter accepted under frozen preregistration e997a4ee (BUILD effort=medium)','applied','design',0,0,0,'2026-10-04T19:38:59.592Z','2026-10-04T19:38:59.602Z');
INSERT INTO checkpoint_applications VALUES('5baaf92b-cd15-468f-8c07-651b78e86ddd','d1fcd190-7b5c-49e6-903c-328745081e7c','full-build','confirm',1,0,'approve','V10-4 operator confirm checkpoint: TEST cleared; authorizing the FINAL BUILD 16384+medium treatment opportunity under frozen preregistration e997a4ee','applied','build',0,0,0,'2026-10-04T20:09:13.238Z','2026-10-04T20:09:13.250Z');
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
