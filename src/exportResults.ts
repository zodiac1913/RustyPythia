export type ExportableResult = {
  connectionLabel: string;
  columns: string[];
  rows: string[][];
};

export const EXPORT_FORMATS = ["html", "ods", "xlsx", "json", "pdf", "csv", "yaml"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

const encoder = new TextEncoder();

export async function buildExportFile(result: ExportableResult, format: ExportFormat) {
  switch (format) {
    case "csv":
      return { bytes: encoder.encode(toCsv(result)), mime: "text/csv" };
    case "json":
      return { bytes: encoder.encode(toJson(result)), mime: "application/json" };
    case "yaml":
      return { bytes: encoder.encode(toYaml(result)), mime: "application/yaml" };
    case "html":
      return { bytes: encoder.encode(toHtml(result)), mime: "text/html" };
    case "xlsx":
      return { bytes: await toXlsx(result), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
    case "ods":
      return { bytes: await toOds(result), mime: "application/vnd.oasis.opendocument.spreadsheet" };
    case "pdf":
      return { bytes: toPdf(result), mime: "application/pdf" };
  }
}

export function exportFileName(label: string, format: ExportFormat) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safe = label.replace(/[^\w.-]+/g, "_").slice(0, 40) || "query";
  return `${safe}-${stamp}.${format}`;
}

export function downloadBytes(filename: string, bytes: Uint8Array, mime: string) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function toCsv(result: ExportableResult) {
  return [result.columns, ...result.rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function csvCell(value: string) {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toJson(result: ExportableResult) {
  return `${JSON.stringify(
    result.rows.map((row) => Object.fromEntries(result.columns.map((column, index) => [column, row[index] ?? ""]))),
    null,
    2
  )}\n`;
}

function toYaml(result: ExportableResult) {
  if (!result.rows.length) {
    return "[]\n";
  }

  return `${result.rows
    .map((row) =>
      result.columns
        .map((column, index) => `${index === 0 ? "- " : "  "}${yamlKey(column)}: ${yamlScalar(row[index] ?? "")}`)
        .join("\n")
    )
    .join("\n")}\n`;
}

function yamlKey(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? value : yamlScalar(value);
}

function yamlScalar(value: string) {
  if (value === "") {
    return '""';
  }
  if (/^(true|false|null|~|[+-]?\d+(\.\d+)?([eE][+-]?\d+)?)$/.test(value) || /[:#{}[\],&*!|>'"%@`]/.test(value) || /\s/.test(value)) {
    // A raw newline inside a double-quoted scalar is folded to a space, which
    // would silently rewrite the value, so control characters are escaped.
    return `"${value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n")
      .replace(/\t/g, "\\t")}"`;
  }
  return value;
}

function toHtml(result: ExportableResult) {
  const header = result.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("");
  const body = result.rows
    .map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`)
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(result.connectionLabel)} query results</title>
  <style>
    body { font-family: sans-serif; margin: 24px; color: #201514; }
    table { border-collapse: collapse; }
    th, td { border: 1px solid #800000; padding: 6px 10px; text-align: left; vertical-align: top; }
    th { background: midnightblue; color: powderblue; }
    td { font-family: ui-monospace, monospace; white-space: pre-wrap; }
  </style>
</head>
<body>
  <h1>${escapeHtml(result.connectionLabel)}</h1>
  <table>
    <thead><tr>${header}</tr></thead>
    <tbody>
${body}
    </tbody>
  </table>
</body>
</html>
`;
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeXml(value: string) {
  return escapeHtml(value).replace(/'/g, "&apos;").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

async function toXlsx(result: ExportableResult) {
  const sheetRows = [
    `<row r="1">${result.columns
      .map((column, index) => `<c r="${xlsxCell(index, 1)}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(column)}</t></is></c>`)
      .join("")}</row>`,
    ...result.rows.map(
      (row, rowIndex) =>
        `<row r="${rowIndex + 2}">${row
          .map(
            (value, colIndex) =>
              `<c r="${xlsxCell(colIndex, rowIndex + 2)}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value.slice(0, 32767))}</t></is></c>`
          )
          .join("")}</row>`
    ),
  ];

  return zipStore([
    { name: "[Content_Types].xml", data: encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`) },
    { name: "_rels/.rels", data: encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`) },
    { name: "xl/workbook.xml", data: encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Results" sheetId="1" r:id="rId1"/></sheets>
</workbook>`) },
    { name: "xl/_rels/workbook.xml.rels", data: encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`) },
    { name: "xl/worksheets/sheet1.xml", data: encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
${sheetRows.join("\n")}
  </sheetData>
</worksheet>`) },
  ]);
}

function xlsxCell(column: number, row: number) {
  let name = "";
  let index = column;
  do {
    name = String.fromCharCode(65 + (index % 26)) + name;
    index = Math.floor(index / 26) - 1;
  } while (index >= 0);
  return `${name}${row}`;
}

async function toOds(result: ExportableResult) {
  const header = `<table:table-row>${result.columns
    .map((column) => `<table:table-cell office:value-type="string"><text:p>${escapeXml(column)}</text:p></table:table-cell>`)
    .join("")}</table:table-row>`;
  const body = result.rows
    .map(
      (row) =>
        `<table:table-row>${row
          .map((value) => `<table:table-cell office:value-type="string"><text:p>${escapeXml(value)}</text:p></table:table-cell>`)
          .join("")}</table:table-row>`
    )
    .join("");

  return zipStore([
    { name: "mimetype", data: encoder.encode("application/vnd.oasis.opendocument.spreadsheet") },
    { name: "META-INF/manifest.xml", data: encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`) },
    { name: "meta.xml", data: encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="1.2">
  <office:meta><meta:generator>Rusty Pythia</meta:generator></office:meta>
</office:document-meta>`) },
    { name: "content.xml", data: encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2">
  <office:body>
    <office:spreadsheet>
      <table:table table:name="Results">
        ${header}
        ${body}
      </table:table>
    </office:spreadsheet>
  </office:body>
</office:document-content>`) },
  ]);
}

function toPdf(result: ExportableResult) {
  const pageWidth = 792;
  const pageHeight = 612;
  const margin = 36;
  const lineHeight = 11;
  const colWidth = Math.max(48, (pageWidth - margin * 2) / Math.max(result.columns.length, 1));
  const rowsPerPage = Math.max(1, Math.floor((pageHeight - margin * 2) / lineHeight) - 1);
  const pages: string[][][] = [];
  const allRows = [result.columns, ...result.rows];

  for (let start = 0; start < allRows.length; start += rowsPerPage) {
    pages.push(allRows.slice(start, start + rowsPerPage));
  }
  if (!pages.length) {
    pages.push([result.columns]);
  }

  const pageStreams = pages.map((pageRows) => {
    let commands = "BT /F1 8 Tf 0 0 0 rg\n";
    pageRows.forEach((row, rowIndex) => {
      row.forEach((value, colIndex) => {
        const x = margin + colIndex * colWidth;
        const y = pageHeight - margin - (rowIndex + 1) * lineHeight;
        const text = pdfWinAnsi(value).slice(0, Math.max(4, Math.floor(colWidth / 4.5)));
        commands += `1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${text}) Tj\n`;
      });
    });
    commands += "ET\n";
    return encoder.encode(commands);
  });

  return buildPdf(pageStreams, pageWidth, pageHeight);
}

function buildPdf(pageStreams: Uint8Array[], pageWidth: number, pageHeight: number) {
  const objects: Uint8Array[] = [];
  const kids: number[] = [];
  const fontObject = 3;
  let next = 4;

  pageStreams.forEach((stream) => {
    const pageNum = next++;
    const contentNum = next++;
    kids.push(pageNum);
    objects[pageNum] = encoder.encode(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentNum} 0 R >>`
    );
    objects[contentNum] = encoder.encode(`<< /Length ${stream.length} >>\nstream\n${new TextDecoder().decode(stream)}endstream`);
  });

  objects[1] = encoder.encode("<< /Type /Catalog /Pages 2 0 R >>");
  objects[2] = encoder.encode(`<< /Type /Pages /Kids [${kids.map((num) => `${num} 0 R`).join(" ")}] /Count ${kids.length} >>`);
  objects[fontObject] = encoder.encode("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");

  const parts: Uint8Array[] = [encoder.encode("%PDF-1.4\n")];
  const offsets = [0];
  let cursor = parts[0].length;

  for (let number = 1; number < next; number += 1) {
    const body = objects[number];
    const header = encoder.encode(`${number} 0 obj\n`);
    const footer = encoder.encode("\nendobj\n");
    offsets[number] = cursor;
    parts.push(header, body, footer);
    cursor += header.length + body.length + footer.length;
  }

  const xrefStart = cursor;
  let xref = `xref\n0 ${next}\n0000000000 65535 f \n`;
  for (let number = 1; number < next; number += 1) {
    xref += `${String(offsets[number]).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer << /Size ${next} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  parts.push(encoder.encode(xref));
  return concat(parts);
}

function pdfWinAnsi(value: string) {
  return Array.from(value)
    .map((char) => {
      const code = char.charCodeAt(0);
      if (char === "\\" || char === "(" || char === ")") {
        return `\\${char}`;
      }
      if (code === 10 || code === 13) {
        return " ";
      }
      if (code < 32 || code > 126) {
        return "?";
      }
      return char;
    })
    .join("");
}

type ZipEntry = { name: string; data: Uint8Array };

async function zipStore(entries: ZipEntry[]) {
  const now = new Date();
  const dosTime = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | (Math.floor(now.getSeconds() / 2) & 31);
  const dosDate = (((now.getFullYear() - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const local = new Uint8Array(30 + nameBytes.length + entry.data.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, dosTime, true);
    view.setUint16(12, dosDate, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, entry.data.length, true);
    view.setUint32(22, entry.data.length, true);
    view.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(entry.data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, dosTime, true);
    centralView.setUint16(14, dosDate, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, entry.data.length, true);
    centralView.setUint32(24, entry.data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);
    offset += local.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);
  return concat([...locals, ...centrals, eocd]);
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
