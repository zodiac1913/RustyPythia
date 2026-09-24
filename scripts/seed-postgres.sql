-- Local playground data for Rusty Pythia Postgres query/schema tests.
CREATE SCHEMA IF NOT EXISTS xo;

CREATE TABLE IF NOT EXISTS xo.task_definition (
    task_definition_id integer PRIMARY KEY,
    task_definition_name text NOT NULL,
    task_definition_description text,
    assigned_organization_unit_code text NOT NULL,
    estimated_duration_in_business_days integer,
    is_recurring boolean NOT NULL DEFAULT false,
    recurrence_pattern_expression text,
    created_at timestamptz NOT NULL DEFAULT now(),
    is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS xo.task_assignment (
    task_assignment_id integer PRIMARY KEY,
    task_definition_id integer NOT NULL REFERENCES xo.task_definition (task_definition_id),
    assignee_principal_name text NOT NULL,
    assigned_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO xo.task_definition (
    task_definition_id,
    task_definition_name,
    task_definition_description,
    assigned_organization_unit_code,
    estimated_duration_in_business_days,
    is_recurring,
    recurrence_pattern_expression,
    is_active
)
VALUES
    (9000, 'Quarterly Compliance Review 0', 'Reconcile executive officer filings against the register.', 'XO-COMPLIANCE-DIV', 15, true, 'FREQ=QUARTERLY;BYMONTHDAY=1', true),
    (9001, 'Quarterly Compliance Review 1', 'Confirm officer roster matches HR source of record.', 'XO-COMPLIANCE-DIV', 10, true, 'FREQ=QUARTERLY;BYMONTHDAY=1', true),
    (9002, 'Ad-hoc Records Audit', 'Spot-check closed cases for missing attachments.', 'XO-RECORDS', 5, false, NULL, true),
    (9003, 'Retired Filing Sweep', 'Archive inactive definitions older than five years.', 'XO-RECORDS', 20, false, NULL, false)
ON CONFLICT (task_definition_id) DO NOTHING;

INSERT INTO xo.task_assignment (
    task_assignment_id,
    task_definition_id,
    assignee_principal_name
)
VALUES
    (1, 9000, 'rxjr@example.gov'),
    (2, 9000, 'reviewer@example.gov'),
    (3, 9001, 'rxjr@example.gov'),
    (4, 9002, 'auditor@example.gov')
ON CONFLICT (task_assignment_id) DO NOTHING;
