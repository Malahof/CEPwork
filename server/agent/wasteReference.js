import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDocsSnapshot, writeDocsSnapshot } from './generators/code112.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_REFERENCE_PATH = path.join(PROJECT_ROOT, 'data', 'references', 'waste_reference.json');

export const WASTE_REFERENCE_FOLDER_ID = 'references';
export const WASTE_REFERENCE_PAGE_ID = 'waste-reference';

let cache = null;
let cachePath = null;

function normalizeWasteEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const code = String(entry.code ?? '').trim();
  if (!code) return null;
  return {
    code,
    name: String(entry.name ?? '').trim(),
    source: String(entry.source ?? '').trim(),
    composition: String(entry.composition ?? '').trim(),
  };
}

export async function loadWasteReference(referencePath = DEFAULT_REFERENCE_PATH) {
  if (cache && cachePath === referencePath) return cache;
  try {
    const raw = await readFile(referencePath, 'utf8');
    const parsed = JSON.parse(raw);
    cache = Array.isArray(parsed) ? parsed.map(normalizeWasteEntry).filter(Boolean) : [];
  } catch (error) {
    if (error && typeof error === 'object' && error.code !== 'ENOENT') {
      console.warn('[wasteReference] Не удалось прочитать справочник отходов, используем пустой', error.message);
    }
    cache = [];
  }
  cachePath = referencePath;
  return cache;
}

export async function saveWasteReference(entries, referencePath = DEFAULT_REFERENCE_PATH) {
  const normalized = entries.map(normalizeWasteEntry).filter(Boolean);
  normalized.sort((a, b) => a.code.localeCompare(b.code, 'ru', { numeric: true }));
  await mkdir(path.dirname(referencePath), { recursive: true });
  const tmpPath = `${referencePath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await rename(tmpPath, referencePath);
  cache = normalized;
  cachePath = referencePath;
  return normalized;
}

export function findWasteInReference(reference, code) {
  const normalizedCode = String(code ?? '').trim();
  if (!normalizedCode) return null;
  return reference.find((entry) => entry.code === normalizedCode) ?? null;
}

export async function upsertWasteReference(entry, referencePath = DEFAULT_REFERENCE_PATH) {
  const normalized = normalizeWasteEntry(entry);
  if (!normalized) return null;
  const reference = await loadWasteReference(referencePath);
  const index = reference.findIndex((item) => item.code === normalized.code);
  if (index === -1) {
    reference.push(normalized);
  } else {
    reference[index] = {
      code: normalized.code,
      name: normalized.name || reference[index].name,
      source: normalized.source || reference[index].source,
      composition: normalized.composition || reference[index].composition,
    };
  }
  await saveWasteReference(reference, referencePath);
  return normalized;
}

export function buildWasteReferencePageContent(reference) {
  const lines = [
    '# Справочник отходов',
    '',
    'Справочная страница. Редактирование только через Цэпика.',
    '',
    '| Код | Отход | Источник | Состав |',
    '|---|---|---|---|',
  ];
  const sorted = [...reference].sort((a, b) => a.code.localeCompare(b.code, 'ru', { numeric: true }));
  for (const entry of sorted) {
    const name = entry.name || '—';
    const source = entry.source || '—';
    const composition = entry.composition || '—';
    lines.push(`| ${entry.code} | ${name} | ${source} | ${composition} |`);
  }
  return lines.join('\n');
}

function ensureFolder(snapshot, folder) {
  const index = snapshot.folders.findIndex((item) => item.id === folder.id);
  if (index === -1) snapshot.folders.push(folder);
  else snapshot.folders[index] = { ...snapshot.folders[index], ...folder };
}

export async function syncWasteReferencePage(docsPath, referencePath = DEFAULT_REFERENCE_PATH) {
  const reference = await loadWasteReference(referencePath);
  const snapshot = await readDocsSnapshot(docsPath);
  const now = Date.now();

  ensureFolder(snapshot, {
    id: WASTE_REFERENCE_FOLDER_ID,
    title: 'Справочники',
    parentId: null,
    order: 2,
    isExpanded: false,
  });

  const content = buildWasteReferencePageContent(reference);
  const pageIndex = snapshot.pages.findIndex((page) => page.id === WASTE_REFERENCE_PAGE_ID);
  if (pageIndex === -1) {
    snapshot.pages.push({
      id: WASTE_REFERENCE_PAGE_ID,
      title: 'Справочник отходов',
      content,
      parentId: WASTE_REFERENCE_FOLDER_ID,
      order: 0,
      createdAt: now,
      updatedAt: now,
      isTemplate: true,
    });
  } else {
    snapshot.pages[pageIndex] = {
      ...snapshot.pages[pageIndex],
      title: 'Справочник отходов',
      content,
      parentId: WASTE_REFERENCE_FOLDER_ID,
      isTemplate: true,
      updatedAt: now,
    };
  }

  await writeDocsSnapshot(docsPath, snapshot);
  console.log('[wasteReference] Справочник отходов синхронизирован', { count: reference.length });
}
