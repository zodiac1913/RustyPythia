import { mkdirSync, writeFileSync } from "node:fs";
import { buildExportFile, EXPORT_FORMATS } from "../src/exportResults.ts";

const outputDirectory = new URL("../.export-smoke/", import.meta.url);
mkdirSync(outputDirectory, { recursive: true });

// Narrow case: values that have historically broken escaping, plus enough rows
// to force multi-page output in the paginated HTML and PDF writers.
const narrowRows: string[][] = [
  ["1", "Rxjr", 'quote " comma , newline\nend'],
  ["2", "Ada", "plain"],
  ["3", "Ünicode", "naïve café — em dash"],
  ["4", "Markup", "<script>alert(1)</script> & 'quotes'"],
  ["5", "Empty", ""],
];
for (let index = 6; index <= 120; index += 1) {
  narrowRows.push([String(index), `User ${index}`, `Row ${index} filler text`]);
}

// Wide case, shaped like TaskDefinition: many columns with long names. This is
// what used to squeeze headers down to unreadable stubs.
const wideColumns = [
  "TaskDefinitionId",
  "TaskDefinitionName",
  "TaskDefinitionDescription",
  "AssignedOrganizationUnitCode",
  "EstimatedDurationInBusinessDays",
  "IsRecurringTaskDefinition",
  "RecurrencePatternExpression",
  "EscalationThresholdInHours",
  "CreatedByUserPrincipalName",
  "CreatedDateTimeUtc",
  "LastModifiedByUserPrincipalName",
  "LastModifiedDateTimeUtc",
  "IsActiveIndicator",
];
const wideRows = Array.from({ length: 60 }, (_, index) => [
  String(9000 + index),
  `Quarterly Compliance Review ${index}`,
  "Confirm that every executive officer filing is reconciled against the register.",
  "XO-COMPLIANCE-DIV",
  "15",
  index % 2 === 0 ? "true" : "false",
  "FREQ=QUARTERLY;BYMONTHDAY=1",
  "72",
  "rxjr@example.gov",
  "2026-09-22T06:30:00Z",
  "reviewer@example.gov",
  "2026-09-22T06:45:00Z",
  "true",
]);

const cases = [
  { name: "narrow", result: { connectionLabel: "CATSDB", columns: ["Id", "User Name", "Notes"], rows: narrowRows } },
  { name: "wide", result: { connectionLabel: "TaskDefinition", columns: wideColumns, rows: wideRows } },
];

for (const testCase of cases) {
  for (const format of EXPORT_FORMATS) {
    const file = await buildExportFile(testCase.result, format);
    writeFileSync(new URL(`${testCase.name}.${format}`, outputDirectory), file.bytes);
    console.log(testCase.name.padEnd(7), format.padEnd(5), String(file.bytes.length).padStart(8), file.mime);
  }
}
