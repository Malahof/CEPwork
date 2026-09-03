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

export async function replaceDocxPlaceholders(docBuffer, variables, options = {}) {
  const xmlPath = options.xmlPath ?? WORD_DOCUMENT_XML;
  const zip = await JSZip.loadAsync(docBuffer);
  const documentFile = zip.file(xmlPath);
  if (!documentFile) throw new Error(`DOCX XML not found: ${xmlPath}`);

  const xml = await documentFile.async('string');
  zip.file(xmlPath, replaceXmlPlaceholders(xml, variables, options));
  return zip.generateAsync({ type: 'nodebuffer' });
}

export function processXmlRepeatingBlocks(xml, placeholder, dataArray, options = {}) {
  const blockPattern = buildBlockPattern(options.blockType);
  const blocks = [...xml.matchAll(blockPattern)].map((match, index) => ({
    text: match[0],
    index: match.index,
    blockIndex: index,
  }));
  const markerBlocks = blocks.filter((block) => block.text.includes(placeholder) || extractXmlText(block.text).includes(placeholder));
  if (!markerBlocks.length) return xml;

  const followingBlocks = Number.isInteger(options.followingBlocks) && options.followingBlocks > 0 ? options.followingBlocks : 0;
  const firstGroup = blockGroup(blocks, markerBlocks[0].blockIndex, followingBlocks);
  const lastGroup = blockGroup(blocks, markerBlocks.at(-1).blockIndex, followingBlocks);
  const templateBlock = firstGroup.text;
  const renderedBlocks = dataArray.map((item, index) => renderBlock(templateBlock, placeholder, item, index, options));
  const prefix = xml.slice(0, firstGroup.index);
  const suffix = xml.slice(lastGroup.endIndex);
  return `${prefix}${renderedBlocks.join('')}${suffix}`;
}

export function replaceXmlPlaceholders(xml, variables, options = {}) {
  return xml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (paragraph, offset, fullXml) => {
    const trStart = fullXml.lastIndexOf('<w:tr', offset);
    const trEnd = fullXml.indexOf('</w:tr>', offset);
    let tableContext = '';
    if (trStart !== -1 && trEnd !== -1 && trStart < offset && trEnd > offset) {
      tableContext = extractXmlText(fullXml.slice(trStart, trEnd + '</w:tr>'.length));
    }
    return replaceParagraphPlaceholders(paragraph, variables, { ...options, tableContext });
  });
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

export function formatDateToDDMMYYYY(input) {
  return parseDateToFormat(input, DEFAULT_DATE_FORMAT);
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
  if (options.removePlaceholder !== false) {
    const marker = placeholder.replace(/^\[/, '').replace(/\]$/, '');
    variables[marker] = '';
  }
  return replaceXmlPlaceholders(templateBlock, variables);
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

function blockGroup(blocks, startIndex, followingBlocks) {
  const start = blocks[startIndex];
  const end = blocks[Math.min(startIndex + followingBlocks, blocks.length - 1)];
  return {
    index: start.index,
    text: blocks
      .slice(startIndex, Math.min(startIndex + followingBlocks + 1, blocks.length))
      .map((block) => block.text)
      .join(''),
    endIndex: end.index + end.text.length,
  };
}

function extractXmlText(xml) {
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((match) => unescapeXml(match[1])).join('');
}

function replaceParagraphPlaceholders(paragraph, variables, options = {}) {
  const keys = Object.keys(variables ?? {});
  if (!keys.length) return paragraph;

  const runRegex = /<w:r(\s[^>]*)?>([\s\S]*?)<\/w:r>/g;
  const runs = [];
  let runMatch;
  let originalText = '';
  while ((runMatch = runRegex.exec(paragraph)) !== null) {
    const rAttrs = runMatch[1] || '';
    const runContent = runMatch[2];
    const rPrMatch = runContent.match(/^<w:rPr\b[\s\S]*?<\/w:rPr>/);
    const rPr = rPrMatch ? rPrMatch[0] : '';
    const tMatches = [...runContent.matchAll(/<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g)];
    const start = originalText.length;
    for (const t of tMatches) originalText += unescapeXml(t[2]);
    runs.push({ start, end: originalText.length, rPr, rAttrs, tMatches, raw: runMatch[0], index: runMatch.index });
  }
  if (!runs.length) return paragraph;

  const markers = [];
  for (const key of keys) {
    const pattern = new RegExp(`\\[${escapeRegex(key)}\\]|\\{\\{${escapeRegex(key)}\\}\\}`, 'g');
    for (const match of originalText.matchAll(pattern)) {
      markers.push({ start: match.index, end: match.index + match[0].length, key });
    }
  }
  if (!markers.length) return paragraph;
  markers.sort((a, b) => a.start - b.start);

  let pos = 0;
  const segments = [];
  for (const marker of markers) {
    if (marker.start > pos) segments.push({ type: 'text', text: originalText.slice(pos, marker.start), start: pos });
    segments.push({ type: 'value', key: marker.key, value: String(variables[marker.key] ?? ''), start: marker.start });
    pos = marker.end;
  }
  if (pos < originalText.length) segments.push({ type: 'text', text: originalText.slice(pos), start: pos });

  function findRunIndex(position) {
    for (let i = 0; i < runs.length; i += 1) {
      if (position >= runs[i].start && position < runs[i].end) return i;
    }
    return runs.length - 1;
  }

  function buildTextNode(value, tAttrsSource) {
    const tAttrs = buildTextAttrs(value, (tAttrsSource && tAttrsSource[1]) ?? '');
    return `<w:t${tAttrs}>${escapeXml(value)}</w:t>`;
  }

  function buildValueContent(value, tAttrsSource) {
    const parts = value.split(/<br\s*\/?>/i);
    return parts
      .map((part, index) => {
        const textNode = buildTextNode(part, tAttrsSource);
        return index < parts.length - 1 ? `${textNode}<w:br/>` : textNode;
      })
      .join('');
  }

  const pieces = [];
  for (const segment of segments) {
    const runIndex = findRunIndex(segment.type === 'text' ? segment.start : segment.start);
    const run = runs[runIndex];
    if (segment.type === 'text') {
      if (!segment.text) continue;
      const tContent = buildTextNode(segment.text, run.tMatches[0]);
      pieces.push(`<w:r${run.rAttrs}>${run.rPr}${tContent}</w:r>`);
    } else {
      const underline = shouldUnderlineKey(segment.key, options);
      const effectiveRPr = underline ? addUnderlineToRPr(run.rPr) : run.rPr;
      const tContent = buildValueContent(segment.value, run.tMatches[0]);
      pieces.push(`<w:r${run.rAttrs}>${effectiveRPr}${tContent}</w:r>`);
    }
  }

  const firstRun = runs[0];
  const lastRun = runs[runs.length - 1];
  const prefix = paragraph.slice(0, firstRun.index);
  const suffix = paragraph.slice(lastRun.index + lastRun.raw.length);
  return `${prefix}${pieces.join('')}${suffix}`;
}

function buildTextAttrs(text, originalTAttrs) {
  const hasSpace = /^\s|\s$|  /.test(text);
  const originalPreserve = /xml:space="preserve"/.test(originalTAttrs);
  if (hasSpace || originalPreserve) return ' xml:space="preserve"';
  return '';
}

function shouldUnderlineKey(key, options) {
  const underlineVariables = Array.isArray(options.underlineVariables) ? options.underlineVariables : [];
  if (!underlineVariables.includes(key)) return false;
  if (key === 'дата_акта' && options.tableContext) {
    const inSignatureTable =
      /\[должность_(?:председателя|члена_комиссии)\]|\[инициалы_фамилия_(?:председателя|члена_комиссии)\]/.test(
        options.tableContext
      );
    if (inSignatureTable) return false;
  }
  return true;
}

function addUnderlineToRPr(rPr) {
  if (rPr) {
    return rPr.replace(/<\/w:rPr>/, '<w:u w:val="single"/></w:rPr>');
  }
  return '<w:rPr><w:u w:val="single"/></w:rPr>';
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unescapeXml(value) {
  return String(value ?? '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
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
