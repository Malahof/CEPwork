type Row = string[];

function sanitizeFileName(title: string): string {
  return title.replace(/[^a-zA-Zа-яА-Я0-9]/g, '_');
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(line);
}

function splitTableRow(line: string): Row {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => stripInlineMarkdown(cell));
}

function parseMarkdownTable(lines: string[], startIndex: number): {
  rows: Row[];
  nextIndex: number;
} {
  const rows: Row[] = [splitTableRow(lines[startIndex])];
  let index = startIndex + 2;

  while (index < lines.length && lines[index].trim().includes('|')) {
    rows.push(splitTableRow(lines[index]));
    index += 1;
  }

  return { rows, nextIndex: index };
}

function markdownToRows(markdown: string): Row[] {
  const rows: Row[] = [];
  const lines = markdown.split(/\r?\n/);
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (
      trimmed.includes('|') &&
      index + 1 < lines.length &&
      isTableSeparator(lines[index + 1])
    ) {
      const table = parseMarkdownTable(lines, index);
      rows.push(...table.rows);
      index = table.nextIndex;
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      rows.push([`H${heading[1].length}`, stripInlineMarkdown(heading[2])]);
      index += 1;
      continue;
    }

    const listItem = trimmed.match(/^[-*+]\s+(?:\[[ xX]\]\s+)?(.+)$/);
    if (listItem) {
      rows.push(['•', stripInlineMarkdown(listItem[1])]);
      index += 1;
      continue;
    }

    const orderedListItem = trimmed.match(/^\d+\.\s+(.+)$/);
    if (orderedListItem) {
      rows.push(['1.', stripInlineMarkdown(orderedListItem[1])]);
      index += 1;
      continue;
    }

    const blockquote = trimmed.match(/^>\s?(.+)$/);
    if (blockquote) {
      rows.push(['>', stripInlineMarkdown(blockquote[1])]);
      index += 1;
      continue;
    }

    rows.push([stripInlineMarkdown(trimmed)]);
    index += 1;
  }

  return rows.length ? rows : [['']];
}

export function exportToXlsx(title: string, markdown: string): void {
  const rows = markdownToRows(markdown);
  const sheetXml = buildSheetXml(rows);
  const archive = new ZipArchive();

  archive.addFile('[Content_Types].xml', CONTENT_TYPES_XML);
  archive.addFile('_rels/.rels', RELS_XML);
  archive.addFile('xl/workbook.xml', WORKBOOK_XML);
  archive.addFile('xl/_rels/workbook.xml.rels', WORKBOOK_RELS_XML);
  archive.addFile('xl/worksheets/sheet1.xml', sheetXml);

  const zipContent = archive.toBlobParts();
  const blob = new Blob([zipContent.buffer as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${sanitizeFileName(title)}.xlsx`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function buildSheetXml(rows: Row[]): string {
  const xmlRows = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          const cellRef = `${columnName(columnIndex)}${rowIndex + 1}`;
          return `<c r="${cellRef}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
        })
        .join('');
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${xmlRows}</sheetData></worksheet>`;
}

function columnName(index: number): string {
  let name = '';
  let current = index;

  while (current >= 0) {
    name = String.fromCharCode((current % 26) + 65) + name;
    current = Math.floor(current / 26) - 1;
  }

  return name;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

class ZipArchive {
  private files: ZipFile[] = [];

  addFile(name: string, content: string): void {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    this.files.push({
      name,
      data,
      crc: crc32(data),
    });
  }

  toBlobParts(): Uint8Array {
    const localParts: Uint8Array[] = [];
    const centralParts: Uint8Array[] = [];
    let offset = 0;

    for (const file of this.files) {
      const nameBytes = new TextEncoder().encode(file.name);
      const localHeader = new Uint8Array(30 + nameBytes.length);
      const localView = new DataView(localHeader.buffer);

      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, 0, true);
      localView.setUint16(8, 0, true);
      localView.setUint32(14, file.crc, true);
      localView.setUint32(18, file.data.length, true);
      localView.setUint32(22, file.data.length, true);
      localView.setUint16(26, nameBytes.length, true);
      localHeader.set(nameBytes, 30);
      localParts.push(localHeader, file.data);

      const centralHeader = new Uint8Array(46 + nameBytes.length);
      const centralView = new DataView(centralHeader.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0, true);
      centralView.setUint16(10, 0, true);
      centralView.setUint32(16, file.crc, true);
      centralView.setUint32(20, file.data.length, true);
      centralView.setUint32(24, file.data.length, true);
      centralView.setUint16(28, nameBytes.length, true);
      centralView.setUint32(42, offset, true);
      centralHeader.set(nameBytes, 46);
      centralParts.push(centralHeader);

      offset += localHeader.length + file.data.length;
    }

    const centralOffset = offset;
    const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
    const endRecord = new Uint8Array(22);
    const endView = new DataView(endRecord.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, this.files.length, true);
    endView.setUint16(10, this.files.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, centralOffset, true);

    return concatUint8Arrays([...localParts, ...centralParts, endRecord]);
  }
}

interface ZipFile {
  name: string;
  data: Uint8Array;
  crc: number;
}

function concatUint8Arrays(parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;

  for (const byte of data) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function makeCrcTable(): number[] {
  const table: number[] = [];

  for (let i = 0; i < 256; i += 1) {
    let crc = i;
    for (let j = 0; j < 8; j += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[i] = crc >>> 0;
  }

  return table;
}

const CRC_TABLE = makeCrcTable();

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;

const RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Документ" sheetId="1" r:id="rId1"/></sheets></workbook>`;

const WORKBOOK_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
