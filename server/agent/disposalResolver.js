import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFParse } from 'pdf-parse';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REFERENCES_DIR = path.join(PROJECT_ROOT, 'data', 'references');
const REFERENCE_METADATA_PATH = path.join(PROJECT_ROOT, 'data', 'references', 'reference_metadata.json');
const OWN_WASTE_RE = /использу(?:ет|ют)\s+собственн|собственн(?:ые|ых)\s+отход/iu;

const REFERENCES = {
  zagotovka: {
    url: 'https://www.minpriroda.gov.by/ru/4/view/o-vidax-otxodov-tovarov-i-upakovki-6512-2025/',
    cachePath: path.join(REFERENCES_DIR, 'zagotovka.json'),
    type: 'html',
  },
  utilizationPart1: {
    url: 'https://www.ecoinfo.by/wp-content/uploads/2026/06/%D0%A0%D0%B5%D0%B5%D1%81%D1%82%D1%80-%D0%BE%D0%B1%D1%8A%D0%B5%D0%BA%D1%82%D0%BE%D0%B2-%D0%BF%D0%BE-%D0%B8%D1%81%D0%BF%D0%BE%D0%BB%D1%8C%D0%B7%D0%BE%D0%B2%D0%B0%D0%BD%D0%B8%D1%8E-%D0%BE%D1%82%D1%85%D0%BE%D0%B4%D0%BE%D0%B2-%D1%87%D0%B0%D1%81%D1%82%D1%8C-I.pdf',
    cachePath: path.join(REFERENCES_DIR, 'reestr-ispolzovanie-I.pdf'),
    textPath: path.join(REFERENCES_DIR, 'reestr-ispolzovanie-I.txt'),
    type: 'pdf',
  },
  utilizationPart2: {
    url: 'https://www.ecoinfo.by/wp-content/uploads/2026/06/%D0%A0%D0%B5%D0%B5%D1%81%D1%82%D1%80-%D0%BE%D0%B1%D1%8A%D0%B5%D0%BA%D1%82%D0%BE%D0%B2-%D0%BF%D0%BE-%D0%B8%D1%81%D0%BF%D0%BE%D0%BB%D1%8C%D0%B7%D0%BE%D0%B2%D0%B0%D0%BD%D0%B8%D1%8E-%D0%BE%D1%82%D1%85%D0%BE%D0%B4%D0%BE%D0%B2-%D1%87%D0%B0%D1%81%D1%82%D1%8C-II.pdf',
    cachePath: path.join(REFERENCES_DIR, 'reestr-ispolzovanie-II.pdf'),
    textPath: path.join(REFERENCES_DIR, 'reestr-ispolzovanie-II.txt'),
    type: 'pdf',
  },
  neutralization: {
    url: 'https://www.ecoinfo.by/wp-content/uploads/2026/06/%D0%A0%D0%B5%D0%B5%D1%81%D1%82%D1%80-%D0%BE%D0%B1%D1%8A%D0%B5%D0%BA%D1%82%D0%BE%D0%B2-%D1%85%D1%80%D0%B0%D0%BD%D0%B5%D0%BD%D0%B8%D1%8F-%D0%B7%D0%B0%D1%85%D0%BE%D1%80%D0%BE%D0%BD%D0%B5%D0%BD%D0%B8%D1%8F-%D0%B8-%D0%BE%D0%B1%D0%B5%D0%B7%D0%B2%D1%80%D0%B5%D0%B6%D0%B8%D0%B2%D0%B0%D0%BD%D0%B8%D1%8F-%D0%BE%D1%82%D1%85%D0%BE%D0%B4%D0%BE%D0%B2-%D0%BE%D0%B1%D0%B5%D0%B7%D0%B2%D1%80%D0%B5%D0%B6%D0%B8%D0%B2%D0%B0%D0%BD%D0%B8%D0%B5.pdf',
    cachePath: path.join(REFERENCES_DIR, 'reestr-obezvrezhivanie.pdf'),
    textPath: path.join(REFERENCES_DIR, 'reestr-obezvrezhivanie.txt'),
    type: 'pdf',
  },
};

export async function resolveDisposalMethod(code, options = {}) {
  const normalizedCode = String(code).trim();
  console.log('[disposalResolver] Resolving disposal method for code:', normalizedCode);
  
  if (normalizedCode === '9120400') {
    console.log('[disposalResolver] Code 9120400 requires manual handling');
    return { method: null, source: 'manual: 9120400' };
  }

  const referenceTexts = options.referenceTexts ?? {};
  
  try {
    const zagotovkaText = referenceTexts.zagotovka ?? await safeReadReferenceText(REFERENCES.zagotovka, options);
    if (containsWasteCode(zagotovkaText, normalizedCode)) {
      console.log('[disposalResolver] Код', normalizedCode, 'найден в реестре заготовки, способ: заготовка');
      return { method: 'заготовка', source: 'minpriroda:zagotovka' };
    }
  } catch (error) {
    console.warn('[disposalResolver] Failed to read zagotovka reference:', error);
  }

  try {
    const utilizationTexts = [
      referenceTexts.utilizationPart1 ?? await safeReadReferenceText(REFERENCES.utilizationPart1, options),
      referenceTexts.utilizationPart2 ?? await safeReadReferenceText(REFERENCES.utilizationPart2, options),
    ];
    for (const [index, text] of utilizationTexts.entries()) {
      const entries = findCodeEntries(text, normalizedCode);
      // Check if waste is in utilization registry and either doesn't have "own waste" restriction OR has "accepts from others"
      for (const entry of entries) {
        const hasOwnWasteOnly = OWN_WASTE_RE.test(entry);
        const acceptsFromOthers = /принимает\s+от\s+других|прием\s+от\s+других/iu.test(entry);
        if (!hasOwnWasteOnly || acceptsFromOthers) {
          console.log('[disposalResolver] Код', normalizedCode, 'найден в реестре использования часть', index + 1, 'способ: использование');
          return { method: 'использование', source: `ecoinfo:utilization:${index + 1}` };
        }
      }
    }
  } catch (error) {
    console.warn('[disposalResolver] Failed to read utilization references:', error);
  }

  try {
    const neutralizationText = referenceTexts.neutralization ?? await safeReadReferenceText(REFERENCES.neutralization, options);
    if (containsWasteCode(neutralizationText, normalizedCode)) {
      console.log('[disposalResolver] Код', normalizedCode, 'найден в реестре обезвреживания, способ: обезвреживание');
      return { method: 'обезвреживание', source: 'ecoinfo:neutralization' };
    }
  } catch (error) {
    console.warn('[disposalResolver] Failed to read neutralization reference:', error);
  }

  console.log('[disposalResolver] Код', normalizedCode, 'не найден в реестрах, используя способ по умолчанию: захоронение');
  return { method: 'захоронение', source: 'default' };
}

export async function refreshDisposalReferences() {
  await Promise.all(Object.values(REFERENCES).map((reference) => readReferenceText(reference, { refresh: true })));
}

async function getReferenceLastModified(url) {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    if (!response.ok) return null;
    const lastModified = response.headers.get('Last-Modified');
    return lastModified ? new Date(lastModified) : null;
  } catch (error) {
    console.warn('[disposalResolver] Не удалось получить Last-Modified для', url, error);
    return null;
  }
}

async function loadReferenceMetadata() {
  try {
    const content = await readFile(REFERENCE_METADATA_PATH, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function saveReferenceMetadata(metadata) {
  await mkdir(path.dirname(REFERENCE_METADATA_PATH), { recursive: true });
  await writeFile(REFERENCE_METADATA_PATH, JSON.stringify(metadata, null, 2));
}

async function shouldUpdateReference(referenceKey, reference) {
  const metadata = await loadReferenceMetadata();
  const stored = metadata[referenceKey];
  if (!stored) return true;

  const remoteLastModified = await getReferenceLastModified(reference.url);
  if (!remoteLastModified) return false;

  const storedDate = new Date(stored.lastModified);
  return remoteLastModified > storedDate;
}

async function updateReferenceMetadata(referenceKey, reference) {
  const metadata = await loadReferenceMetadata();
  const lastModified = await getReferenceLastModified(reference.url);
  metadata[referenceKey] = {
    url: reference.url,
    lastModified: lastModified ? lastModified.toISOString() : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await saveReferenceMetadata(metadata);
}

async function safeReadReferenceText(reference, options) {
  try {
    return await readReferenceText(reference, options);
  } catch (error) {
    console.warn('[disposalResolver] Не удалось прочитать справочник', reference.cachePath, error);
    return '';
  }
}

async function readReferenceText(reference, options = {}) {
  const referenceKey = Object.keys(REFERENCES).find(key => REFERENCES[key] === reference);
  
  if (!options.refresh) {
    const cached = await readCachedText(reference);
    if (cached) return cached;
  }

  // Check if reference needs update
  if (referenceKey && !options.refresh) {
    const needsUpdate = await shouldUpdateReference(referenceKey, reference);
    if (!needsUpdate) {
      const cached = await readCachedText(reference);
      if (cached) return cached;
    }
  }

  if (reference.type === 'html') {
    const response = await fetch(reference.url);
    if (!response.ok) {
      console.warn('[disposalResolver] Не удалось загрузить справочник', reference.url, `HTTP ${response.status}`);
      throw new Error(`HTTP ${response.status}: ${reference.url}`);
    }
    const html = await response.text();
    const text = stripHtml(html);
    await mkdir(path.dirname(reference.cachePath), { recursive: true });
    await writeFile(reference.cachePath, `${JSON.stringify({ fetchedAt: Date.now(), url: reference.url, text }, null, 2)}\n`);
    if (referenceKey) await updateReferenceMetadata(referenceKey, reference);
    return text;
  }

  const buffer = await readOrDownloadPdf(reference, options);
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    await mkdir(path.dirname(reference.textPath), { recursive: true });
    await writeFile(reference.textPath, result.text);
    if (referenceKey) await updateReferenceMetadata(referenceKey, reference);
    return result.text;
  } finally {
    await parser.destroy();
  }
}

async function readCachedText(reference) {
  try {
    if (reference.type === 'html') {
      const parsed = JSON.parse(await readFile(reference.cachePath, 'utf8'));
      return typeof parsed.text === 'string' ? parsed.text : '';
    }
    return await readFile(reference.textPath, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) return '';
    throw error;
  }
}

async function readOrDownloadPdf(reference, options = {}) {
  console.log('[disposalResolver] readOrDownloadPdf called for', reference.cachePath, 'refresh:', options.refresh);
  
  if (!options.refresh) {
    try {
      const buffer = await readFile(reference.cachePath);
      console.log('[disposalResolver] Using cached PDF from', reference.cachePath, 'size:', buffer.length);
      return buffer;
    } catch (error) {
      if (!isNotFoundError(error)) {
        console.warn('[disposalResolver] Error reading cached PDF', reference.cachePath, error);
        throw error;
      }
      console.log('[disposalResolver] Cached PDF not found, will download');
    }
  }

  try {
    console.log('[disposalResolver] Attempting to download PDF from', reference.url);
    const response = await fetch(reference.url);
    if (!response.ok) {
      console.warn('[disposalResolver] Failed to download PDF', reference.url, `HTTP ${response.status}`);
      throw new Error(`HTTP ${response.status}: ${reference.url}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await mkdir(path.dirname(reference.cachePath), { recursive: true });
    await writeFile(reference.cachePath, buffer);
    console.log('[disposalResolver] Successfully downloaded and cached PDF to', reference.cachePath, 'size:', buffer.length);
    return buffer;
  } catch (error) {
    console.error('[disposalResolver] Failed to download PDF', reference.url, error);
    throw error;
  }
}

function findCodeEntries(text, code) {
  const source = String(text);
  const matches = [...source.matchAll(new RegExp(`(?:^|\\D)${escapeRegExp(code)}(?:\\D|$)`, 'g'))];
  return matches.map((match) => {
    const start = Math.max(0, (match.index ?? 0) - 300);
    const end = Math.min(source.length, (match.index ?? 0) + 700);
    return source.slice(start, end);
  });
}

function containsWasteCode(text, code) {
  return findCodeEntries(text, code).length > 0;
}

function stripHtml(html) {
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#171;|&laquo;/g, '«')
    .replace(/&#187;|&raquo;/g, '»')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNotFoundError(error) {
  return error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
