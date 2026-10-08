# Rusty Pythia

Rusty Pythia is the next-generation desktop rebuild of Pythia, targeting a Tauri + Rust shell with a reliable browser fallback path.

PythiaJS was the prototype and predecessor of Rusty Pythia. It is not a query language; the query workspace supports SQuerL and SQL.

## Repository Layout

- Root workspace is reserved for the Rusty Pythia implementation.

## Current Runtime Wiring

- Tauri loads Rusty Pythia's bundled frontend from this repository.
- The desktop window is created inside the app shell and points at the bundled `index.html`.
- Rusty Pythia does not spawn or depend on `../PythiaJS/` at runtime.

## Query Languages

The query mode selector offers three choices:

- **SQuerL** provides schema-aware table, field, sort, and condition assistance.
- **SQL Assist** provides SQL keyword and table suggestions.
- **Non Assist** is a free-form query box with no suggestions or picker behavior.

All three modes execute the resulting statement as SQL against the selected database.
Use **Query Search** to find and load previously executed statements into the editor.

### Ask The Oracle

AI launch options are temporarily hidden. The implementation remains in place
for future work; this does not introduce a replacement AI provider.

**Launch SQL App** offers **Open Tauri SQL** and **Open Browser SQL**.
Browser actions use the external default browser and the desktop SQL bridge.
Native actions are unavailable in browser sessions.

The Oracle shows a scrollable chronological chat above the composer, with user
messages on the right and AI replies on the left. Statistics and result tables
appear inside the corresponding AI reply, not in a separate Results section.
Running another query or switching connections preserves earlier chat entries.
**Clear** removes both the conversation and result history. This history stays
in the current window only and is not saved across reloads or closing the window.

**Show SQL** is off by default. Turn it on to reveal only the latest Generated SQL,
with Copy and Run again below the statement. Hiding SQL does not stop execution
or change query recording.

The local SQLite `sql_statement_memory` table separates `source = 'sql'` recall
from `source = 'AI'` audit entries. Existing memory migrates as `sql`; AI entries
never appear in Query Search or SQL-memory existence checks. SQL recall retains
its per-connection statement deduplication.

Each AI execution (including Run again) saves a separate row with the SQL, user
`question`, and narrative `answer`. `passfail` becomes `pass` or `fail` on
completion; `error_message` preserves failures for diagnosis. A NULL `passfail`
means an unfinished attempt, such as app shutdown during execution. Clarifications
and responses without SQL execution are not stored. Result rows are not copied
into audit history. An audit-save failure is reported explicitly rather than
silently losing the execution record.

**Refresh Ollama** checks the service and, if unavailable or without models, tries
to start local Ollama and waits briefly for it to respond. This replaces the
separate status-only refresh and Slap Ollama buttons; it does not restart an
already-responsive service or download models.

The window also checks Ollama every 30 seconds and after a failed AI
answer, updating its status and disabling Ask when unavailable. These passive
checks never start Ollama and do not overlap a manual recovery. They check
service/model availability, not whether a
model can finish generating an answer; generation has a five-minute timeout.

**Re-probe db** reads the selected database's live table/view metadata, columns,
types, keys, and relationships into the local schema cache, refreshing changed
objects and clearing the in-memory catalog. It does not edit the database's
business data or regenerate, overwrite, or reload the Markdown instructions.
The Oracle uses the live catalog for SQL structure and relevant table Markdown
for business meanings. Table Markdown is read when building a model prompt;
the documentation manifest and query playbook are cached until app restart.

SQL Server prompts require `CAST(GETDATE() AS date)` instead of `CURRENT_DATE`.
Generated SQL using the unsupported date keyword is sent through the existing
repair pass before execution; quoted text, identifiers, and comments are excluded.

Simple questions such as "How many employees are named John?" use a schema-checked
SQL rule instead of Ollama. It ranks all distinct first/middle names together and
surnames separately by employee frequency, then counts the requested name in the
more frequent category (ties prefer first/middle; zero matches fall back to the
other category). Matching is exact, case-insensitive, and trims stored names.
Each employee counts once; nicknames and manager/display names are excluded.
These counts include current and former records and retain privacy suppression
for small groups. Questions with additional filters still use the model.

Simple male/female employee counts also bypass Ollama, using the documented
Sex codes M/F on HR.HR_Employee. Unqualified counts include current and former
records; explicitly active/current counts require both departure fields NULL.
Additional filters remain model-planned; missing required schema fields are
reported rather than replaced by guesses or historical tables.

"How many active employees are in each component?" also uses a schema-checked
rule: group HR.HR_Employee by ComponentIdentifier, requiring both SeparatedDate
and DeactivateTimeStamp to be NULL. Grade dates do not indicate active status.
Missing component identifiers form a NULL group; existing privacy suppression
still applies. Additional filters remain model-planned.

### Releases

Every SQL and AI window shows its build version at the bottom right. Vite
injects the package version into both pages; the release workflow stamps that
same version into package, Cargo, and Tauri metadata before building.

Pushing a tag in `YYYY.MM.DD.xx` format builds and publishes installers for macOS,
Windows, and Linux. The attempt counter starts at `0` for the first release attempt
of the day. For example:

```sh
git tag 2026.09.28.0
git push origin 2026.09.28.0
```

Installers are stamped with the tag's version (for example, tag `2026.09.28.2` becomes
`2026.9.28+2`, shown by the Windows installer as `2026.9.28.2`). The release workflow
stamps that version into `package.json`, `src-tauri/Cargo.toml`, and
`src-tauri/tauri.conf.json` at build time; the committed files carry the latest released
version. Builds are produced for
macOS (`.dmg`, Apple Silicon), Windows (`-setup.exe`), and Linux (`.AppImage`, `.deb`,
`.rpm`). There is no MSI because MSI versions cannot start with a number above 255.

The macOS app is ad-hoc signed but not notarized. On first launch, macOS will say it
cannot verify the developer; approve it under **System Settings → Privacy & Security →
Open Anyway**, or clear the download quarantine:

```sh
xattr -dr com.apple.quarantine "/Applications/Rusty Pythia.app"
```

The Windows installer is unsigned, so SmartScreen may warn on first run.

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
