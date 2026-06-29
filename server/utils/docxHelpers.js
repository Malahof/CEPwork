import JSZip from 'jszip';

const DEFAULT_DATE_FORMAT = 'DD.MM.YYYY';
const WORD_DOCUMENT_XML = 'word/document.xml';

const monthNumbers = new Map([
  ['январь', 1],
  ['января', 1],
  ['янв', 1],
  ['февраль', 2],
  ['февраля', 2],
  ['фев', 2],
  ['март', 3],
  ['марта', 3],
  ['мар', 3],
  ['апрель', 4],
  ['апреля', 4],
  ['апр', 4],
  ['май', 5],
  ['мая', 5],
  ['июнь', 6],
  ['июня', 6],
  ['июн', 6],
  ['июль', 7],
  ['июля', 7],
  ['июл', 7],
  ['август', 8],
  ['августа', 8],
  ['авг', 8],
  ['сентябрь', 9],
  ['сентября', 9],
  ['сен', 9],
  ['сент', 9],
  ['октябрь', 10],
  ['октября', 10],
  ['окт', 10],
  ['ноябрь', 11],
  ['ноября', 11],
  ['ноя', 11],
  ['декабрь', 12],
  ['декабря', 12],
  ['дек', 12],
]);

export async function processRepeatingBlocks(docBuffer, placeholder, dataArray, options = {}) {
  if (!placeholder) throw new Error('placeholder is required');
  const items = Array.isArray(dataArray) ? dataArray : [];
  const xmlPath = options.xmlPath ?? WORD_DOCUMENT_XML;
  const zip = await JSZip.loadAsync(docBuffer);
  const documentFile = zip.file(xmlPath);
  if (!documentFile) throw new Error(`DOCX XML not found: ${xmlPath}`);

  const xml = await documentFile.async('string');
  const processedXml = processXmlRepeatingBlocks(xml, placeholder, items, options);
  zip.file(xmlPath, processedXml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

export function processXmlRepeatingBlocks(xml, placeholder, dataArray, options = {}) {
  const blockPattern = buildBlockPattern(options.blockType);
  const blocks = [...xml.matchAll(blockPattern)].map((match) => ({ text: match[0], index: match.index }));
  const markerBlocks = blocks.filter((block) => block.text.includes(placeholder));
  if (!markerBlocks.length) return xml;

  const templateBlock = markerBlocks[0].text;
  const renderedBlocks = dataArray.map((item, index) => renderBlock(templateBlock, placeholder, item, index, options));
  const first = markerBlocks[0];
  const last = markerBlocks.at(-1);
  const prefix = xml.slice(0, first.index);
  const suffix = xml.slice(last.index + last.text.length);
  return `${prefix}${renderedBlocks.join('')}${suffix}`;
}

export function parseDateToFormat(input, format = DEFAULT_DATE_FORMAT) {
  const parsed = parseDateParts(input);
  if (!parsed) return String(input ?? '').trim();

  const day = pad2(parsed.day);
  const month = pad2(parsed.month);
  const year = String(parsed.year).padStart(4, '0');
  const normalizedFormat = normalizeDateFormat(format);

  if (normalizedFormat === 'YYYY-MM-DD') return `${year}-${month}-${day}`;
  if (normalizedFormat === 'YYYY/MM/DD') return `${year}/${month}/${day}`;
  return `${day}.${month}.${year}`;
}

export function normalizeDateFormat(format) {
  const value = String(format || DEFAULT_DATE_FORMAT).trim().toUpperCase();
  if (value === 'ДД.ММ.ГГГГ') return DEFAULT_DATE_FORMAT;
  if (value === 'ГГГГ-ММ-ДД') return 'YYYY-MM-DD';
  if (value === 'ГГГГ/ММ/ДД') return 'YYYY/MM/DD';
  if (value === 'YYYY-MM-DD' || value === 'YYYY/MM/DD') return value;
  return DEFAULT_DATE_FORMAT;
}

function buildBlockPattern(blockType) {
  if (blockType === 'paragraph') return /<w:p\b[\s\S]*?<\/w:p>/g;
  if (blockType === 'tableRow') return /<w:tr\b[\s\S]*?<\/w:tr>/g;
  return /<w:tr\b[\s\S]*?<\/w:tr>|<w:p\b[\s\S]*?<\/w:p>/g;
}

function renderBlock(templateBlock, placeholder, item, index, options) {
  const variables = buildVariables(item, index, options);
  let block = templateBlock.replaceAll(placeholder, '');
  for (const [key, value] of Object.entries(variables)) {
    block = block.replaceAll(`[${key}]`, escapeXml(value));
    block = block.replaceAll(`{{${key}}}`, escapeXml(value));
  }
  return block;
}

function buildVariables(item, index, options) {
  const source = item && typeof item === 'object' && !Array.isArray(item) ? item : { value: item };
  const variables = { index: String(index + 1), номер: String(index + 1) };
  for (const [key, path] of Object.entries(options.fieldMap ?? {})) {
    variables[key] = readPath(source, path);
  }
  for (const [key, value] of Object.entries(source)) {
    variables[key] = value;
  }
  return variables;
}

function readPath(source, path) {
  return String(path)
    .split('.')
    .filter(Boolean)
    .reduce((value, key) => (value && typeof value === 'object' ? value[key] : ''), source);
}

function parseDateParts(input) {
  if (input instanceof Date && !Number.isNaN(input.getTime())) {
    return { day: input.getDate(), month: input.getMonth() + 1, year: input.getFullYear() };
  }

  if (typeof input === 'number') {
    const date = new Date(input);
    return Number.isNaN(date.getTime()) ? null : { day: date.getDate(), month: date.getMonth() + 1, year: date.getFullYear() };
  }

  const text = String(input ?? '').trim().replace(/\s*г\.?$/iu, '');
  if (!text) return null;

  const numeric = text.match(/^(\d{1,4})[./-](\d{1,2})[./-](\d{2,4})$/u);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    const third = normalizeYear(Number(numeric[3]));
    if (numeric[1].length === 4) return validDateParts({ day: Number(numeric[3]), month: second, year: first });
    return validDateParts({ day: first, month: second, year: third });
  }

  const ru = text.toLocaleLowerCase('ru-RU').match(/^(\d{1,2})\s+([а-яё.]+)\s+(\d{2,4})$/iu);
  if (ru) {
    const month = monthNumbers.get(ru[2].replaceAll('.', ''));
    if (month) return validDateParts({ day: Number(ru[1]), month, year: normalizeYear(Number(ru[3])) });
  }

  return null;
}

function validDateParts(parts) {
  const date = new Date(parts.year, parts.month - 1, parts.day);
  if (date.getFullYear() !== parts.year || date.getMonth() !== parts.month - 1 || date.getDate() !== parts.day) return null;
  return parts;
}

function normalizeYear(year) {
  return year < 100 ? 2000 + year : year;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
