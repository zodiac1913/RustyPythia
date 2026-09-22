// Export writers ported from the CATS smlTableExport component so Rusty
// Pythia produces the same styled workbooks, spreadsheets and PDFs.
// Adapted in two ways: every writer returns bytes rather than a Blob, because
// the desktop build hands them to Rust to write, and the PDF cross-reference
// table is computed over encoded bytes rather than string length so non-ASCII
// values cannot corrupt the offsets.

export type ExportableResult = {
  connectionLabel: string;
  columns: string[];
  rows: string[][];
};

type ExportColumn = { key: string; title: string };
type ExportData = { title: string; columns: ExportColumn[]; rows: string[][] };

export const EXPORT_FORMATS = ["html", "ods", "xlsx", "json", "pdf", "csv", "yaml"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * The one type size every export uses, in CSS pixels.
 *
 * Headers, cells and titles all render at this size in every format, so an
 * HTML page, a PDF, a spreadsheet and a workbook are all legible to the same
 * degree. Change this single value to resize every export.
 */
export const EXPORT_FONT_PX = 16;

/** The same size in points, for the formats that measure in points. */
const EXPORT_FONT_PT = EXPORT_FONT_PX * 0.75;

const encoder = new TextEncoder();

export async function buildExportFile(result: ExportableResult, format: ExportFormat) {
  // Column names stay verbatim; they are SQL identifiers, not display labels.
  const data: ExportData = {
    title: result.connectionLabel || "Query Results",
    columns: result.columns.map((name) => ({ key: name, title: name })),
    rows: result.rows,
  };

  switch (format) {
    case "csv":
      return { bytes: encoder.encode(buildCsv(data)), mime: "text/csv;charset=utf-8" };
    case "json":
      return { bytes: encoder.encode(`${JSON.stringify(data, null, 2)}\n`), mime: "application/json" };
    case "yaml":
      return { bytes: encoder.encode(buildYaml(data)), mime: "application/yaml" };
    case "html":
      return { bytes: encoder.encode(buildHtml(data)), mime: "text/html;charset=utf-8" };
    case "xlsx":
      return {
        bytes: buildXlsx(data),
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      };
    case "ods":
      return { bytes: buildOds(data), mime: "application/vnd.oasis.opendocument.spreadsheet" };
    case "pdf":
      return { bytes: buildPdf(data), mime: "application/pdf" };
  }
}

export function exportFileName(label: string, format: ExportFormat) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safe = label.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "query";
  return `${safe}-${stamp}.${format}`;
}

export function downloadBytes(filename: string, bytes: Uint8Array, mime: string) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function valueText(value: unknown) {
  if (value === null || value === undefined) {
    return "";
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function escapeXml(value: unknown) {
  // Strip code points XML forbids outright, then escape the markup set.
  const safe = Array.from(valueText(value))
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        code === 0x9 ||
        code === 0xa ||
        code === 0xd ||
        (code >= 0x20 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) ||
        code >= 0x10000
      );
    })
    .join("");

  return safe.replace(/[&<>"']/g, (character) => XML_ESCAPES[character]);
}

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function csvValue(value: unknown) {
  const text = valueText(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildCsv(data: ExportData) {
  return [
    data.columns.map((column) => csvValue(column.title)).join(","),
    ...data.rows.map((row) => row.map(csvValue).join(",")),
  ].join("\r\n");
}

function yamlValue(value: unknown) {
  const text = valueText(value);
  if (text === "") {
    return '""';
  }
  if (/^(true|false|null|[-+]?\d+(\.\d+)?)$/i.test(text)) {
    return text;
  }
  // JSON string escapes are a subset of YAML's double-quoted style, so this
  // also keeps newlines and tabs escaped rather than folded.
  return JSON.stringify(text);
}

function buildYaml(data: ExportData) {
  return `${[
    `title: ${yamlValue(data.title)}`,
    "columns:",
    ...data.columns.map((column) => `  - key: ${yamlValue(column.key)}\n    title: ${yamlValue(column.title)}`),
    "rows:",
    ...data.rows.map((row) => `  - [${row.map(yamlValue).join(", ")}]`),
  ].join("\n")}\n`;
}

function buildHtml(data: ExportData) {
  const headers = data.columns.map((column) => `<th scope="col">${escapeXml(column.title || column.key)}</th>`).join("");
  const rows = data.rows
    .map((row) => `<tr>${row.map((value) => `<td>${escapeXml(valueText(value))}</td>`).join("")}</tr>`)
    .join("");
  const rowLabel = `${data.rows.length.toLocaleString()} row${data.rows.length === 1 ? "" : "s"}`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeXml(data.title)}</title><style>
      :root { --export-navy: #163f6a; --export-navy-dark: #0f304f; --export-zebra: #f2f6fb; --export-border: #c9d5e3; --export-text: #17212b; --export-mono: ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace; --export-font: ${EXPORT_FONT_PX}px; font-size: 16px; }
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; color: var(--export-text); font-family: Inter, Avenir, Helvetica, Arial, sans-serif; background: #f6f8fb; }
      body { padding: 0.35in; }
      .sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
      /* No inner scrolling and no clipping anywhere: the sheet shrink-wraps the
         table, so the document itself grows to whatever the data needs. */
      main { display: inline-block; min-width: 100%; }
      .export-sheet { display: inline-block; min-width: 100%; background: #fff; border: 1px solid var(--export-border); border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
      .export-title-bar { display: flex; justify-content: space-between; align-items: end; gap: 1em; padding: 0.3em 0.34em; font-size: var(--export-font); background: linear-gradient(120deg, var(--export-navy) 0%, var(--export-navy-dark) 100%); color: #fff; border-radius: 7px 7px 0 0; }
      .export-title-bar h1 { margin: 0; font-size: inherit; font-weight: 700; letter-spacing: 0.2px; white-space: nowrap; }
      .export-title-bar span { font-size: inherit; opacity: 0.95; white-space: nowrap; }
      .export-table { width: max-content; min-width: 100%; border-collapse: collapse; }
      /* Headers and cells share one size, set from EXPORT_FONT_PX, so every
         format reads identically. nowrap keeps each column as wide as its
         longest value needs. */
      .export-table thead th { background: #e7eff8; color: #113254; font-size: var(--export-font); font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; text-align: left; padding: 0.22em 0.34em; border: 1px solid var(--export-border); white-space: nowrap; }
      .export-table tbody td { font-family: var(--export-mono); font-size: var(--export-font); padding: 0.22em 0.34em; border: 1px solid var(--export-border); vertical-align: top; white-space: nowrap; }
      .export-table tbody tr:nth-child(even) td { background: var(--export-zebra); }
      @media print {
        /* Let the sheet dictate the paper size so printing cannot clip columns. */
        @page { size: auto; margin: 0.5in; }
        html, body { background: #fff; }
        body { padding: 0; }
        .export-sheet { border: none; border-radius: 0; box-shadow: none; }
      }
    </style></head><body><main aria-label="${escapeXml(data.title)} export"><section class="export-sheet"><div class="export-title-bar"><h1>${escapeXml(data.title)}</h1><span>${rowLabel}</span></div><table class="export-table"><caption class="sr-only">${escapeXml(data.title)} - ${rowLabel}</caption><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table></section></main></body></html>`;
}

function excelColumnName(index: number) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCodePoint(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function buildXlsx(data: ExportData) {
  const rows = [data.columns.map((column) => column.title || column.key), ...data.rows];
  const sheetRows = rows
    .map(
      (row, rowIndex) =>
        `<row r="${rowIndex + 1}">${row
          .map(
            (value, columnIndex) =>
              `<c r="${excelColumnName(columnIndex)}${rowIndex + 1}" s="${rowIndex === 0 ? 1 : rowIndex % 2 === 0 ? 2 : 0}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(valueText(value).slice(0, 32767))}</t></is></c>`
          )
          .join("")}</row>`
    )
    .join("");

  const columnWidths = data.columns
    .map((column, index) => {
      const longest = Math.max(
        String(column.title || "").length,
        ...data.rows.map((row) => valueText(row[index]).length),
        10
      );
      // Width is in characters of the sheet font, which already scales with
      // EXPORT_FONT_PT, and is uncapped so nothing is squeezed.
      return `<col min="${index + 1}" max="${index + 1}" width="${longest + 2}" bestFit="1" customWidth="1"/>`;
    })
    .join("");

  return zipStore([
    {
      name: "[Content_Types].xml",
      content: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      content: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      content: `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Export" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      name: "xl/styles.xml",
      content: `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="0"/><fonts count="2"><font><sz val="${EXPORT_FONT_PT}"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="${EXPORT_FONT_PT}"/><name val="Calibri"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEAF2F8"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="3" borderId="1" applyFill="1" applyBorder="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    },
    {
      name: "xl/worksheets/sheet1.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${excelColumnName(Math.max(data.columns.length - 1, 0))}${Math.max(rows.length, 1)}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="${(EXPORT_FONT_PT * 1.3).toFixed(0)}"/><cols>${columnWidths}</cols><sheetData>${sheetRows}</sheetData></worksheet>`,
    },
  ]);
}

function buildOds(data: ExportData) {
  const allRows = [data.columns.map((column) => column.title || column.key), ...data.rows];
  const rows = allRows
    .map((row, rowIndex) => {
      const cellStyle = rowIndex === 0 ? "HeaderCell" : rowIndex % 2 === 0 ? "AlternateCell" : "BodyCell";
      const cells = row
        .map(
          (value) =>
            `<table:table-cell table:style-name="${cellStyle}" office:value-type="string"><text:p>${escapeXml(valueText(value))}</text:p></table:table-cell>`
        )
        .join("");
      return `<table:table-row table:style-name="Row1">${cells}</table:table-row>`;
    })
    .join("");

  const columnStyles = data.columns
    .map((column, index) => {
      const longest = Math.max(
        String(column.title || "").length,
        ...data.rows.map((row) => valueText(row[index]).length),
        10
      );
      // Character width scales with the font, and there is no cap: a column is
      // as wide as its longest value needs.
      const width = (longest * EXPORT_FONT_PT * 0.6 * 1.05 / 72 + 0.2).toFixed(2);
      return `<style:style style:name="Column${index + 1}" style:family="table-column"><style:table-column-properties style:column-width="${width}in"/></style:style>`;
    })
    .join("");

  const columns = data.columns
    .map((_, index) => `<table:table-column table:style-name="Column${index + 1}"/>`)
    .join("");

  return zipStore([
    { name: "mimetype", content: "application/vnd.oasis.opendocument.spreadsheet" },
    {
      name: "content.xml",
      content: `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2"><office:automatic-styles>${columnStyles}<style:style style:name="HeaderCell" style:family="table-cell"><style:table-cell-properties fo:background-color="#1F4E78"/><style:text-properties fo:color="#FFFFFF" fo:font-weight="bold" fo:font-size="${EXPORT_FONT_PT}pt"/></style:style><style:style style:name="AlternateCell" style:family="table-cell"><style:table-cell-properties fo:background-color="#EAF2F8"/><style:text-properties fo:font-size="${EXPORT_FONT_PT}pt"/></style:style><style:style style:name="BodyCell" style:family="table-cell"><style:text-properties fo:font-size="${EXPORT_FONT_PT}pt"/></style:style><style:style style:name="Row1" style:family="table-row"><style:table-row-properties style:row-height="${(EXPORT_FONT_PT * 1.4).toFixed(0)}pt"/></style:style></office:automatic-styles><office:body><office:spreadsheet><table:table table:name="Export" table:expanded-column-count="${data.columns.length}" table:expanded-row-count="${allRows.length}">${columns}${rows}</table:table></office:spreadsheet></office:body></office:document-content>`,
    },
    {
      name: "styles.xml",
      content: `<?xml version="1.0" encoding="UTF-8"?><office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.2"><office:styles/></office:document-styles>`,
    },
    {
      name: "meta.xml",
      content: `<?xml version="1.0" encoding="UTF-8"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.2"><office:meta/></office:document-meta>`,
    },
    {
      name: "settings.xml",
      content: `<?xml version="1.0" encoding="UTF-8"?><office:document-settings xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.2"><office:settings/></office:document-settings>`,
    },
    {
      name: "META-INF/manifest.xml",
      content: `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:media-type="application/vnd.oasis.opendocument.spreadsheet" manifest:full-path="/"/><manifest:file-entry manifest:media-type="text/xml" manifest:full-path="content.xml"/><manifest:file-entry manifest:media-type="text/xml" manifest:full-path="styles.xml"/><manifest:file-entry manifest:media-type="text/xml" manifest:full-path="meta.xml"/><manifest:file-entry manifest:media-type="text/xml" manifest:full-path="settings.xml"/></manifest:manifest>`,
    },
  ]);
}

// Sanitising and escaping are separate steps because column widths must be
// measured against the glyphs that actually render. Escaping "(" to "\(" adds
// a character that is never drawn, so measuring escaped text oversizes columns.
function pdfSanitize(value: unknown) {
  return valueText(value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function pdfEscape(text: string) {
  return text.replace(/[\\()]/g, (character) => `\\${character}`);
}

// The page font is declared /WinAnsiEncoding, so the content stream has to be
// single-byte CP1252 rather than UTF-8. This keeps accented Latin text and
// typographic punctuation legible instead of degrading it to "?", and it keeps
// the byte count the /Length entry declares in step with what is written.
const CP1252_HIGH: Record<string, number> = {
  "\u20ac": 0x80, "\u201a": 0x82, "\u0192": 0x83, "\u201e": 0x84,
  "\u2026": 0x85, "\u2020": 0x86, "\u2021": 0x87, "\u02c6": 0x88,
  "\u2030": 0x89, "\u0160": 0x8a, "\u2039": 0x8b, "\u0152": 0x8c,
  "\u017d": 0x8e, "\u2018": 0x91, "\u2019": 0x92, "\u201c": 0x93,
  "\u201d": 0x94, "\u2022": 0x95, "\u2013": 0x96, "\u2014": 0x97,
  "\u02dc": 0x98, "\u2122": 0x99, "\u0161": 0x9a, "\u203a": 0x9b,
  "\u0153": 0x9c, "\u017e": 0x9e, "\u0178": 0x9f,
};

function cp1252Bytes(text: string) {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x7f || (code >= 0xa0 && code <= 0xff)) {
      bytes[index] = code;
      continue;
    }
    bytes[index] = CP1252_HIGH[text[index]] ?? 0x3f; // "?"
  }
  return bytes;
}

// Helvetica advance widths in 1/1000 em for code points 32..126. Measuring
// with the real metrics rather than an average character width is what lets a
// column be sized to exactly fit its header instead of guessing and clipping.
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

function measureText(text: string, fontSize: number) {
  let width = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    // Accented Latin glyphs are close enough to their base letters; 556 is the
    // Helvetica average and only affects column padding, never correctness.
    width += code >= 32 && code <= 126 ? HELVETICA_WIDTHS[code - 32] : 556;
  }
  return (width / 1000) * fontSize;
}

// Courier is monospaced, so every glyph advances 600/1000 em.
function measureMono(text: string, fontSize: number) {
  return text.length * 0.6 * fontSize;
}

// Headers are drawn uppercase with letter-spacing, which both widen the text,
// so the column has to be measured against the string as it will be rendered.
function headerLabel(column: ExportColumn) {
  return pdfSanitize(column.title || column.key).toUpperCase();
}

function measureHeader(text: string) {
  return measureText(text, PDF_HEADER_FONT) + text.length * PDF_HEADER_TRACKING;
}

// Every size below derives from EXPORT_FONT_PT, so the PDF matches the other
// formats exactly. The page grows in both directions to whatever the columns
// and rows need; selecting fewer columns is what keeps an export compact,
// never shrinking the text.
const PDF_HEADER_FONT = EXPORT_FONT_PT;
const PDF_BODY_FONT = EXPORT_FONT_PT;
const PDF_TITLE_FONT = EXPORT_FONT_PT;
const PDF_LABEL_FONT = EXPORT_FONT_PT;
// Header letter-spacing, matching the grid's 0.04em.
const PDF_HEADER_TRACKING = PDF_HEADER_FONT * 0.04;
const PDF_CELL_PADDING = EXPORT_FONT_PT * 0.68;
const PDF_ROW_HEIGHT = EXPORT_FONT_PT * 1.44;
const PDF_HEADER_ROW_HEIGHT = EXPORT_FONT_PT * 1.5;
const PDF_TITLE_BAR_HEIGHT = EXPORT_FONT_PT * 1.6;
// Grid rules, scaled to the type so borders stay proportionate.
const PDF_RULE_WIDTH = Math.max(1, EXPORT_FONT_PT / 14);
// The page grows to whatever the table needs so every column stays on one
// sheet and the viewer scrolls instead of splitting the data up. A PDF page
// box is capped at 14400 units (200in); /UserUnit lifts that by declaring how
// many 1/72in a unit represents, so the geometry is drawn scaled into a legal
// box while the page stays physically correct.
const PDF_MAX_PAGE_EXTENT = 14400;

// Every cell is measured, not sampled, because nothing is truncated: a column
// must be wide enough for its longest value anywhere in the result set.
function pdfColumnWidths(data: ExportData) {
  return data.columns.map((column, columnIndex) => {
    let widest = measureHeader(headerLabel(column));
    for (const row of data.rows) {
      widest = Math.max(widest, measureMono(pdfSanitize(row[columnIndex]), PDF_BODY_FONT));
    }
    return widest + PDF_CELL_PADDING;
  });
}

function buildPdf(data: ExportData) {
  // 0.35in, the same sheet margin the HTML export uses, so the two formats
  // lay out identically at the same zoom.
  const margin = 25.2;
  const titleBarHeight = PDF_TITLE_BAR_HEIGHT;
  const tableHeaderHeight = PDF_HEADER_ROW_HEIGHT;
  const rowHeight = PDF_ROW_HEIGHT;
  const gap = EXPORT_FONT_PT * 0.6;
  // Vertically centred baseline for a font within a row of the given height,
  // allowing for the descender so text sits optically centred.
  const baselineIn = (height: number, fontSize: number) => (height - fontSize) / 2 + fontSize * 0.24;

  const columnWidths = pdfColumnWidths(data);
  const columnOffsets: number[] = [];
  let runningWidth = 0;
  for (const width of columnWidths) {
    columnOffsets.push(runningWidth);
    runningWidth += width;
  }

  // A single page, grown in both directions to whatever the data needs, so no
  // column is ever split off onto a sheet of its own.
  const tableWidth = Math.ceil(runningWidth);
  const pageWidth = margin * 2 + tableWidth;
  const pageHeight = Math.ceil(
    margin * 2 + titleBarHeight + gap + tableHeaderHeight + data.rows.length * rowHeight
  );

  const titleY = pageHeight - margin - titleBarHeight;
  const headerY = titleY - gap - tableHeaderHeight;
  const commands: string[] = [
    `${PDF_RULE_WIDTH} w`,
    "q",
    "0.09 0.25 0.42 rg",
    `${margin} ${titleY} ${tableWidth} ${titleBarHeight} re f`,
    "Q",
  ];

  const label = `${data.rows.length.toLocaleString()} row${data.rows.length === 1 ? "" : "s"}`;
  commands.push(
    `BT /F1 ${PDF_TITLE_FONT} Tf 0 Tc 1 1 1 rg ${margin + PDF_CELL_PADDING / 2} ${titleY + baselineIn(titleBarHeight, PDF_TITLE_FONT)} Td (${pdfEscape(pdfSanitize(data.title))}) Tj ET`
  );
  const labelX = margin + tableWidth - measureText(label, PDF_LABEL_FONT) - PDF_CELL_PADDING / 2;
  commands.push(
    `BT /F1 ${PDF_LABEL_FONT} Tf 0 Tc 1 1 1 rg ${Math.max(margin + PDF_CELL_PADDING / 2, labelX)} ${titleY + baselineIn(titleBarHeight, PDF_LABEL_FONT)} Td (${pdfEscape(label)}) Tj ET`
  );

  commands.push("q", "0.9 0.94 0.98 rg", `${margin} ${headerY} ${tableWidth} ${tableHeaderHeight} re f`, "Q");
  commands.push("0.7 0.78 0.87 RG", `${margin} ${headerY} ${tableWidth} ${tableHeaderHeight} re S`);

  data.columns.forEach((column, columnIndex) => {
    const x = margin + columnOffsets[columnIndex];
    // No truncation here: the column was sized from this exact string.
    commands.push(
      `BT /F1 ${PDF_HEADER_FONT} Tf ${PDF_HEADER_TRACKING.toFixed(2)} Tc 0.07 0.2 0.33 rg ${x + PDF_CELL_PADDING / 2} ${headerY + baselineIn(tableHeaderHeight, PDF_HEADER_FONT)} Td (${pdfEscape(headerLabel(column))}) Tj ET`
    );
    if (columnIndex > 0) {
      commands.push("0.82 0.86 0.91 RG", `${x} ${headerY} m ${x} ${headerY + tableHeaderHeight} l S`);
    }
  });

  data.rows.forEach((row, rowIndex) => {
    const y = headerY - (rowIndex + 1) * rowHeight;
    if (rowIndex % 2 === 1) {
      commands.push("q", "0.96 0.97 0.99 rg", `${margin} ${y} ${tableWidth} ${rowHeight} re f`, "Q");
    }
    commands.push("0.82 0.86 0.91 RG", `${margin} ${y} ${tableWidth} ${rowHeight} re S`);
    row.forEach((value, columnIndex) => {
      const x = margin + columnOffsets[columnIndex];
      // Never truncated: the column was measured to fit this value in full.
      // Tc is text state and persists, so it is reset for the monospace cells.
      commands.push(
        `BT /F2 ${PDF_BODY_FONT} Tf 0 Tc 0 0 0 rg ${x + PDF_CELL_PADDING / 2} ${y + baselineIn(rowHeight, PDF_BODY_FONT)} Td (${pdfEscape(pdfSanitize(value))}) Tj ET`
      );
      if (columnIndex > 0) {
        commands.push("0.9 0.92 0.95 RG", `${x} ${y} m ${x} ${y + rowHeight} l S`);
      }
    });
  });

  // Authored at full size; if that overflows the 200in page box the geometry is
  // scaled down by one `cm` and /UserUnit restores the physical dimensions.
  const userUnit = Math.max(1, Math.ceil(Math.max(pageWidth, pageHeight) / PDF_MAX_PAGE_EXTENT));
  const scale = 1 / userUnit;
  const stream = commands.join(" ");
  const bytes = cp1252Bytes(userUnit === 1 ? stream : `${scale.toFixed(6)} 0 0 ${scale.toFixed(6)} 0 0 cm ${stream}`);

  return assemblePdf([bytes], Math.ceil(pageWidth * scale), Math.ceil(pageHeight * scale), userUnit);
}

// Offsets are measured in encoded bytes. Building the document as a string and
// using string length breaks the xref the moment a value is not pure ASCII.
function assemblePdf(pageStreams: Uint8Array[], pageWidth: number, pageHeight: number, userUnit = 1) {
  const objects: Uint8Array[] = [];
  const kids: number[] = [];
  const sansFont = 3;
  const monoFont = 4;
  let next = 5;

  pageStreams.forEach((stream) => {
    const pageNumber = next;
    next += 1;
    const contentNumber = next;
    next += 1;
    kids.push(pageNumber);

    objects[pageNumber] = encoder.encode(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}]${userUnit > 1 ? ` /UserUnit ${userUnit}` : ""} /Contents ${contentNumber} 0 R /Resources << /Font << /F1 ${sansFont} 0 R /F2 ${monoFont} 0 R >> >> >>`
    );
    objects[contentNumber] = concat([
      encoder.encode(`<< /Length ${stream.length} >>\nstream\n`),
      stream,
      encoder.encode("\nendstream"),
    ]);
  });

  // /XYZ with an explicit zoom of 1 opens the document at actual size. Without
  // it a viewer fits the page to the window, which on a wide table scales the
  // type down to nothing; at 100% the text is full size and the viewer scrolls.
  objects[1] = encoder.encode(
    `<< /Type /Catalog /Pages 2 0 R /OpenAction [${kids[0]} 0 R /XYZ 0 ${pageHeight} 1] >>`
  );
  objects[2] = encoder.encode(
    `<< /Type /Pages /Kids [${kids.map((number) => `${number} 0 R`).join(" ")}] /Count ${kids.length} >>`
  );
  objects[sansFont] = encoder.encode(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
  );
  objects[monoFont] = encoder.encode(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>"
  );

  // 1.6 is the first version that defines /UserUnit.
  const parts: Uint8Array[] = [encoder.encode("%PDF-1.6\n")];
  const offsets: number[] = [0];
  let cursor = parts[0].length;

  for (let number = 1; number < next; number += 1) {
    const header = encoder.encode(`${number} 0 obj\n`);
    const footer = encoder.encode("\nendobj\n");
    offsets[number] = cursor;
    parts.push(header, objects[number], footer);
    cursor += header.length + objects[number].length + footer.length;
  }

  let xref = `xref\n0 ${next}\n0000000000 65535 f \n`;
  for (let number = 1; number < next; number += 1) {
    xref += `${String(offsets[number]).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${next} /Root 1 0 R >>\nstartxref\n${cursor}\n%%EOF\n`;
  parts.push(encoder.encode(xref));

  return concat(parts);
}

type ZipEntry = { name: string; content: string | Uint8Array };

function zipStore(entries: ZipEntry[]) {
  const now = new Date();
  const dosTime =
    ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | (Math.floor(now.getSeconds() / 2) & 31);
  const dosDate =
    (((now.getFullYear() - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);

  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = entry.content instanceof Uint8Array ? entry.content : encoder.encode(entry.content);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x800, true); // UTF-8 file names
    localView.setUint16(8, 0, true); // stored, no compression
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, dosTime, true);
    centralView.setUint16(14, dosDate, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  return concat([...locals, ...centrals, end]);
}

function concat(parts: Uint8Array[]) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    output.set(part, cursor);
    cursor += part.length;
  }
  return output;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[index] = crc >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
