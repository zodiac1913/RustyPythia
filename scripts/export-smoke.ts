import { writeFileSync } from "node:fs";
import { buildExportFile, EXPORT_FORMATS } from "../src/exportResults.ts";

const result = {
  connectionLabel: "CATSDB",
  columns: ["Id", "User Name", "Notes"],
  rows: [
    ["1", "Rxjr", 'quote " comma , newline\nend'],
    ["2", "Ada", "plain"],
  ],
};

for (const format of EXPORT_FORMATS) {
  const file = await buildExportFile(result, format);
  writeFileSync(`/tmp/export-smoke.${format}`, file.bytes);
  console.log(format, file.bytes.length, file.mime);
}
