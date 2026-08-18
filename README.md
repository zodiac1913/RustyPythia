# Rusty Pythia

Rusty Pythia is the next-generation desktop rebuild of Pythia, targeting a Tauri + Rust shell with a reliable browser fallback path.

## Repository Layout

- Root workspace is reserved for the Rusty Pythia implementation.

## Current Runtime Wiring

- Tauri loads Rusty Pythia's bundled frontend from this repository.
- The desktop window is created inside the app shell and points at the bundled `index.html`.
- Rusty Pythia does not spawn or depend on `../PythiaJS/` at runtime.

## Query Languages

Rusty Pythia supports SQL and SQuerL in the query workspace.

### SQuerL

**SQuerL** means **Storage Quick-access Unearthing Ecosystem Reference Layer**. It is a table-first query language for quickly exploring the active database schema.

When starting a new statement, the autocomplete catalog contains both SQL statement prefixes and every table in the active database:

- Choosing a SQL prefix such as `SELECT`, `INSERT`, `UPDATE`, or `DELETE` starts a SQL statement.
- Choosing a table starts a SQuerL statement.

Rusty Pythia tracks that initial choice so subsequent autocomplete suggestions use the appropriate language context. The picker can be searched to narrow either the SQL prefixes or the database tables, which is necessary for large databases.

The current SQuerL authoring shape is:

```text
[TableName] [* | field1, field2] [~up | ~down] [has + variable conditions]
```

After choosing a table, autocomplete offers `*` and fields from that selected table as the next SQuerL step.

SQuerL assistance is opt-in: the picker opens when the user presses `Down Arrow` in the query box. It does not interrupt typing or reopen automatically after a selection. The sort and condition portions are optional; users can write them directly or request the next picker when needed.

## Run

1. Install dependencies: `npm install`
2. Start desktop app: `npm run tauri dev`
