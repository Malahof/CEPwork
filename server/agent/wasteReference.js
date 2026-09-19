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
    compositionPercent: String(entry.compositionPercent ?? '').trim(),
    density: String(entry.density ?? '').trim(),
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

export function isWasteInReference(reference, code) {
  const found = findWasteInReference(reference, code);
  console.log('[wasteReference] Проверка отхода', code, { found: Boolean(found) });
  return Boolean(found);
}

export async function addWasteToReference(entry, referencePath = DEFAULT_REFERENCE_PATH) {
  console.log('[wasteReference] Запрос на добавление отхода', entry.code);
  const result = await upsertWasteReference(entry, referencePath);
  console.log('[wasteReference] Отход добавлен', entry.code);
  return result;
}

export function markWasteAsIgnored(ignored, code) {
  const set = new Set(ignored ?? []);
  set.add(code);
  console.log('[wasteReference] Отход проигнорирован', code);
  return [...set];
}

export function getWasteFromReference(reference, code) {
  const found = findWasteInReference(reference, code);
  if (found) {
    if (found.composition?.trim() && !found.compositionPercent?.trim()) {
      console.warn('[wasteReference] Отход', code, 'отсутствует compositionPercent');
    }
    console.log('[wasteReference] Отход', code, 'найден в справочнике:', { source: found.source, composition: found.composition, compositionPercent: found.compositionPercent, density: found.density });
  } else {
    console.log('[wasteReference] Отход', code, 'отсутствует в справочнике, запрашиваем ввод');
  }
  return found;
}

export function getMissingFields(reference, code, fields = ['source', 'composition', 'density']) {
  const found = getWasteFromReference(reference, code);
  if (!found) return fields;
  const missing = fields.filter((field) => !found[field]?.trim());
  const hasComposition = fields.includes('composition') && !missing.includes('composition');
  const hasPercent = fields.includes('composition') && !missing.includes('compositionPercent') && found.compositionPercent?.trim();
  if (fields.includes('composition') && (!hasComposition || !hasPercent)) {
    if (!missing.includes('composition')) missing.push('composition');
    if (!missing.includes('compositionPercent')) missing.push('compositionPercent');
  }
  return missing;
}

export async function upsertWasteInReference(entry, referencePath = DEFAULT_REFERENCE_PATH) {
  const normalized = normalizeWasteEntry(entry);
  if (!normalized) return null;
  const reference = await loadWasteReference(referencePath);
  const index = reference.findIndex((item) => item.code === normalized.code);
  let updatedCount = 0;
  if (index === -1) {
    reference.push(normalized);
    updatedCount = 4;
  } else {
    const existing = reference[index];
    const merged = { code: normalized.code };
    for (const field of ['name', 'source', 'composition', 'compositionPercent', 'density']) {
      merged[field] = (normalized[field]?.trim() ? normalized[field] : existing[field]) || '';
      if (normalized[field]?.trim() && !existing[field]?.trim()) updatedCount += 1;
    }
    reference[index] = merged;
  }
  await saveWasteReference(reference, referencePath);
  console.log('[wasteReference] Отход', normalized.code, 'обновлён в справочнике:', { updatedCount });
  return normalized;
}

export async function upsertWasteReference(entry, referencePath = DEFAULT_REFERENCE_PATH) {
  return upsertWasteInReference(entry, referencePath);
}

export async function syncWasteFromState(state, docsPath, referencePath = DEFAULT_REFERENCE_PATH) {
  const wastes = Array.isArray(state.wastes) ? state.wastes : [];
  let saved = 0;
  let skipped = 0;
  for (const waste of wastes) {
    const entry = {
      code: waste.code,
      name: waste.name || waste.wasteName || '',
      source: waste.source || waste.sourceName || '',
      composition: waste.composition || '',
      compositionPercent: waste.compositionPercent || '',
      density: waste.density || '',
    };
    const hasAny = entry.source || entry.composition || entry.density;
    if (!hasAny) {
      skipped += 1;
      continue;
    }
    await upsertWasteInReference(entry, referencePath);
    saved += 1;
  }
  await syncWasteReferencePage(docsPath, referencePath);
  console.log('[wasteReference] Синхронизация в справочник из состояния:', { saved, skipped });
  return { saved, skipped };
}

export function isForceReferenceCommand(answer) {
  const a = String(answer ?? '').toLowerCase();
  return /(?:внес|добав|обнов|сохран).*(?:данн(?:ых|ые|ой|е)|состав[оы]?).*(?:в\s+)?справочник|(?:добав|внес|сохран|обнов).*(?:в\s+)?справочник/.test(a);
}

export function buildWasteReferencePageContent(reference) {
  const lines = [
    '# Справочник отходов',
    '',
    'Справочная страница. Редактирование только через Цэпика.',
    '',
    '| Код | Отход | Источник | Состав | Состав, % | Плотность |',
    '|---|---|---|---|---|---|',
  ];
  const sorted = [...reference].sort((a, b) => a.code.localeCompare(b.code, 'ru', { numeric: true }));
  for (const entry of sorted) {
    const name = entry.name || '—';
    const source = entry.source || '—';
    const composition = entry.composition || '—';
    const compositionPercent = entry.compositionPercent || '—';
    const density = entry.density || '—';
    lines.push(`| ${entry.code} | ${name} | ${source} | ${composition} | ${compositionPercent} | ${density} |`);
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
