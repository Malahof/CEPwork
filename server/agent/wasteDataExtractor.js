import { inflateRawSync } from 'node:zlib';
import { PDFParse } from 'pdf-parse';
import * as XLSX from 'xlsx';

export const WASTE_EXTRACTION_MODES = {
  codesNames: 'codes-names',
  normsQuantities: 'norms-quantities',
  codesNamesNorms: 'codes-names-norms',
  all: 'all',
};

const SERVICE_LINE_RE = /(итого|класс|опасност|приложение|код отхода|наименование отхода|количество образующихся|подлежит|норматив образования|расчетная единица|наименование юридического лица)/iu;
const DASH_RE = /^[−–—-]+$/u;

export function wasteExtractionModeOptions() {
  return [
    { key: 'extractCodesNames', label: 'Только коды и наименования' },
    { key: 'extractNormsQuantities', label: 'нормативы, годовое количество' },
    { key: 'extractCodesNamesNorms', label: 'Коды, наименования и нормативы' },
    { key: 'extractAllWasteData', label: 'Все данные (коды, наименования, нормативы, годовое количество)' },
  ];
}

export function normalizeWasteExtractionMode(answer) {
  const text = normalizeText(answer);
  if (!text) return '';
  if (text === 'extractcodesnames' || text.includes('только коды') || text.includes('коды и наименования')) {
    return WASTE_EXTRACTION_MODES.codesNames;
  }
  if (text === 'extractnormsquantities' || text.includes('нормативы, годовое количество') || text.includes('нормативы и количество')) {
    return WASTE_EXTRACTION_MODES.normsQuantities;
  }
  if (text === 'extractcodesnamesnorms' || text.includes('коды, наименования и нормативы') || text.includes('коды наименования нормативы')) {
    return WASTE_EXTRACTION_MODES.codesNamesNorms;
  }
  if (text === 'extractallwastedata' || text.includes('все данные') || text.includes('извлечь все') || text.includes('полный режим')) {
    return WASTE_EXTRACTION_MODES.all;
  }
  return '';
}

export async function extractTextFromUploadedFile(file) {
  const extension = extensionOf(file.filename);
  if (extension === '.xlsx' || extension === '.xls') return extractSpreadsheetText(file.buffer);
  if (extension === '.docx') return extractDocxText(file.buffer);
  if (extension === '.pdf') return extractPdfText(file.buffer);
  if (['.txt', '.csv', '.md', '.json'].includes(extension) || file.mimeType.startsWith('text/')) {
    return file.buffer.toString('utf8').trim();
  }
  return '';
}

export function extractWasteDataFromText(text, mode = WASTE_EXTRACTION_MODES.codesNames) {
  const normalizedMode = mode || WASTE_EXTRACTION_MODES.codesNames;
  const delimitedRows = extractRowsFromDelimitedText(text);
  const rows = delimitedRows.length ? delimitedRows : extractRowsFromCodeBlocks(text);
  const byCode = new Map();
  for (const row of rows) {
    const normalized = normalizeExtractedWaste(row, normalizedMode);
    if (!normalized) continue;
    const existing = byCode.get(normalized.code);
    byCode.set(normalized.code, mergeExtractedWaste(existing, normalized));
  }
  return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code, 'ru', { numeric: true }));
}

function extractRowsFromDelimitedText(text) {
  const rows = [];
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let header = null;

  for (const line of lines) {
    const delimiter = detectDelimiter(line);
    if (!delimiter) continue;
    const parts = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split(delimiter)
      .map(cleanCell);
    if (parts.length < 2) continue;

    const headerIndexes = detectHeaderIndexes(parts);
    if (headerIndexes) {
      header = headerIndexes;
      continue;
    }

    const codeIndex = header?.codeIndex ?? parts.findIndex((part) => /^\d{7}$/.test(part));
    if (codeIndex === -1) continue;
    const code = parts[codeIndex];
    const nameIndex = header?.nameIndex ?? codeIndex + 1;
    const normIndex = header?.normIndex ?? nameIndex + 1;
    const quantityIndex = header?.quantityIndex ?? findQuantityIndex(parts, codeIndex, normIndex);
    rows.push({
      code,
      name: parts[nameIndex] ?? '',
      norm: parts[normIndex] ?? '',
      quantity: parts[quantityIndex] ?? '',
    });
  }

  return rows;
}

function extractRowsFromCodeBlocks(text) {
  const source = String(text)
    .replace(/\r/g, '\n')
    .replace(/([^\n])(\d{7})(?=\s)/g, '$1\n$2');
  const matches = [...source.matchAll(/\b\d{7}\b/g)];
  const rows = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const code = match[0];
    const nextStart = matches[index + 1]?.index ?? source.length;
    const block = source.slice((match.index ?? 0) + code.length, nextStart);
    const parts = cleanWasteBlock(block);
    if (!parts.length) continue;
    rows.push({
      code,
      name: parts[0] ?? '',
      norm: findNorm(parts),
      quantity: findQuantity(parts),
    });
  }

  return rows;
}

function cleanWasteBlock(block) {
  return String(block)
    .split(/\n|;/)
    .map(cleanCell)
    .filter((line) => line && !SERVICE_LINE_RE.test(line))
    .filter((line) => !/^\d{1,2}$/.test(line))
    .filter((line) => !DASH_RE.test(line));
}

function normalizeExtractedWaste(row, mode) {
  const code = String(row.code ?? '').trim();
  if (!/^\d{7}$/.test(code)) return null;
  const name = cleanWasteName(row.name);
  if (!name) return null;
  const normalized = { code, name };
  if (mode === WASTE_EXTRACTION_MODES.codesNamesNorms || mode === WASTE_EXTRACTION_MODES.normsQuantities || mode === WASTE_EXTRACTION_MODES.all) {
    const norm = cleanNorm(row.norm);
    if (norm) normalized.norm = norm;
  }
  if (mode === WASTE_EXTRACTION_MODES.normsQuantities || mode === WASTE_EXTRACTION_MODES.all) {
    const quantity = normalizeQuantity(row.quantity);
    if (quantity) normalized.quantity = quantity;
  }
  return normalized;
}

function mergeExtractedWaste(existing, incoming) {
  if (!existing) return incoming;
  return {
    ...incoming,
    ...Object.fromEntries(Object.entries(existing).filter(([, value]) => value !== '')),
  };
}

function detectHeaderIndexes(parts) {
  const normalized = parts.map(normalizeText);
  const codeIndex = normalized.findIndex((part) => part.includes('код'));
  const nameIndex = normalized.findIndex((part) => part.includes('наимен') || part === 'отход');
  if (codeIndex === -1 || nameIndex === -1) return null;
  return {
    codeIndex,
    nameIndex,
    normIndex: normalized.findIndex((part) => part.includes('норматив')),
    quantityIndex: normalized.findIndex((part) => part.includes('количество') || part.includes('годовое')),
  };
}

function findQuantityIndex(parts, codeIndex, normIndex) {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (index === codeIndex || index === normIndex) continue;
    if (normalizeQuantity(parts[index])) return index;
  }
  return -1;
}

function findNorm(parts) {
  return parts.find((part) => /(?:\d|−|-).*(?:т|кг|шт|сыр|продукц|год|единиц)/iu.test(part) && !isLikelyQuantity(part)) ?? '';
}

function findQuantity(parts) {
  const tail = [...parts].reverse();
  const found = tail.find((part) => isLikelyQuantity(part));
  return found ?? '';
}

function isLikelyQuantity(value) {
  const text = String(value).trim();
  return /^\d+(?:[,.]\d+)?(?:\s*(?:т|кг|шт\.?))?$/iu.test(text);
}

function cleanNorm(value) {
  const text = cleanCell(value);
  if (!text || DASH_RE.test(text)) return '';
  return text;
}

function normalizeQuantity(value) {
  const text = cleanCell(value);
  if (!text || DASH_RE.test(text)) return '';
  const match = text.match(/\d+(?:[,.]\d+)?/u);
  return match ? match[0].replace('.', ',') : '';
}

function cleanWasteName(value) {
  const text = cleanCell(value)
    .replace(/\s+(?:неопасные|первый|второй|третий|четв[её]ртый|\d(?:-й)?\s+класс|\*)\b.*$/iu, '')
    .trim();
  if (!text || SERVICE_LINE_RE.test(text) || DASH_RE.test(text) || /^\d+(?:[,.]\d+)?$/.test(text)) return '';
  return text;
}

function cleanCell(value) {
  return String(value ?? '')
    .replace(/[>•]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectDelimiter(line) {
  if (line.includes('|')) return /\|/;
  if (line.includes(';')) return /;/;
  if (line.includes('\t')) return /\t/;
  if (line.includes(',')) return /,/;
  return null;
}

function extensionOf(filename) {
  const index = String(filename).lastIndexOf('.');
  return index === -1 ? '' : String(filename).slice(index).toLowerCase();
}

function extractSpreadsheetText(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  return workbook.SheetNames.map((sheetName) => XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName], { FS: ';' }))
    .join('\n')
    .trim();
}

function extractDocxText(buffer) {
  const entries = readZipEntries(buffer);
  const names = [...entries.keys()].filter((name) => /^word\/(document|header|footer|footnotes|endnotes).*\.xml$/.test(name));
  return names
    .map((name) => extractOfficeXmlText(entries.get(name).toString('utf8')))
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function extractPdfText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text.trim();
  } finally {
    await parser.destroy();
  }
}

function readZipEntries(buffer) {
  const entries = new Map();
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset === -1) return entries;

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  let centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);

  for (let index = 0; index < totalEntries; index += 1) {
    if (buffer.readUInt32LE(centralDirectoryOffset) !== 0x02014b50) break;

    const compressionMethod = buffer.readUInt16LE(centralDirectoryOffset + 10);
    const compressedSize = buffer.readUInt32LE(centralDirectoryOffset + 20);
    const fileNameLength = buffer.readUInt16LE(centralDirectoryOffset + 28);
    const extraLength = buffer.readUInt16LE(centralDirectoryOffset + 30);
    const commentLength = buffer.readUInt16LE(centralDirectoryOffset + 32);
    const localHeaderOffset = buffer.readUInt32LE(centralDirectoryOffset + 42);
    const fileNameStart = centralDirectoryOffset + 46;
    const fileName = buffer.toString('utf8', fileNameStart, fileNameStart + fileNameLength);

    const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);

    if (compressionMethod === 0) entries.set(fileName, compressed);
    if (compressionMethod === 8) entries.set(fileName, inflateRawSync(compressed));

    centralDirectoryOffset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 66000);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function extractOfficeXmlText(xml) {
  const tableRows = [...xml.matchAll(/<w:tr(?:\s|>)[\s\S]*?<\/w:tr>/g)]
    .map((rowMatch) => [...rowMatch[0].matchAll(/<w:tc(?:\s|>)[\s\S]*?<\/w:tc>/g)]
      .map((cellMatch) => extractOfficeRuns(cellMatch[0]).join('').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(';'))
    .filter(Boolean);
  const xmlWithoutTables = xml.replace(/<w:tbl(?:\s|>)[\s\S]*?<\/w:tbl>/g, '\n');
  const paragraphs = [...xmlWithoutTables.matchAll(/<w:p(?:\s|>)[\s\S]*?<\/w:p>/g)]
    .map((match) => extractOfficeRuns(match[0]).join('').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return [...tableRows, ...paragraphs].join('\n').trim();
}

function extractOfficeRuns(xml) {
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>(.*?)<\/w:t>/g)]
    .map((match) => decodeXmlEntities(match[1]));
}

function decodeXmlEntities(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function normalizeText(value) {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[«»"']/g, '')
    .replace(/\s+/g, ' ');
}
