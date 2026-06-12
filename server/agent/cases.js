import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export async function findBestCase(query, casesDir) {
  const cases = await readCases(casesDir);
  const normalizedQuery = normalize(query);
  const compactQuery = normalizedQuery.replace(/\s+/g, '');

  const okvedMatch = cases.find((item) => normalize(item.okved).replace(/\s+/g, '') === compactQuery);
  if (okvedMatch) return okvedMatch;

  const containingOkvedMatch = cases.find((item) => compactQuery.includes(normalize(item.okved).replace(/\s+/g, '')));
  if (containingOkvedMatch) return containingOkvedMatch;

  return (
    cases
      .map((item) => ({ item, score: scoreCase(item, normalizedQuery) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)[0]?.item ?? null
  );
}

export async function getCaseById(caseId, casesDir) {
  const cases = await readCases(casesDir);
  return cases.find((item) => item.id === caseId) ?? null;
}

async function readCases(casesDir) {
  let fileNames;
  try {
    fileNames = await readdir(casesDir);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const cases = await Promise.all(
    fileNames
      .filter((fileName) => fileName.endsWith('.json'))
      .map(async (fileName) => {
        const raw = await readFile(path.join(casesDir, fileName), 'utf8');
        return normalizeCase(JSON.parse(raw));
      })
  );
  return cases;
}

function normalizeCase(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid case file');
  return {
    id: requireString(value.id, 'case.id'),
    title: requireString(value.title, 'case.title'),
    okved: requireString(value.okved, 'case.okved'),
    sphere: requireString(value.sphere, 'case.sphere'),
    packageCode: requireString(value.packageCode, 'case.packageCode'),
    features:
      value.features && typeof value.features === 'object' && !Array.isArray(value.features)
        ? value.features
        : {},
  };
}

function scoreCase(item, normalizedQuery) {
  const haystack = normalize(`${item.title} ${item.sphere} ${item.packageCode} ${JSON.stringify(item.features)}`);
  return normalizedQuery
    .split(/[\s,.;:()]+/)
    .filter((token) => token.length >= 4)
    .reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function normalize(value) {
  return String(value).toLowerCase().replace(/ё/g, 'е').trim();
}

function requireString(value, field) {
  if (typeof value !== 'string') throw new Error(`Invalid ${field}`);
  return value;
}
