import express from 'express';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDocsSnapshot } from './defaultDocs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, '..', 'data');
const docsPath = path.join(dataDir, 'docs.json');
const port = Number(process.env.PORT ?? 3001);

const app = express();

app.use(express.json({ limit: '2mb' }));

async function readDocs() {
  try {
    const raw = await readFile(docsPath, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeDocsSnapshot(parsed);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      await writeDocs(defaultDocsSnapshot);
      return defaultDocsSnapshot;
    }
    throw error;
  }
}

async function writeDocs(snapshot) {
  await mkdir(dataDir, { recursive: true });
  const tmpPath = `${docsPath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(normalizeDocsSnapshot(snapshot), null, 2)}\n`);
  await rename(tmpPath, docsPath);
}

function normalizeDocsSnapshot(value) {
  if (!isRecord(value) || !Array.isArray(value.pages) || !Array.isArray(value.folders)) {
    throw new Error('Invalid docs snapshot');
  }

  return {
    pages: value.pages.map(normalizePage),
    folders: value.folders.map(normalizeFolder),
    activePageId:
      typeof value.activePageId === 'string' || value.activePageId === null
        ? value.activePageId
        : null,
  };
}

function normalizePage(value) {
  if (!isRecord(value)) throw new Error('Invalid page');

  return {
    id: requireString(value.id, 'page.id'),
    title: requireString(value.title, 'page.title'),
    content: requireString(value.content, 'page.content'),
    parentId: requireNullableString(value.parentId, 'page.parentId'),
    order: requireNumber(value.order, 'page.order'),
    createdAt: requireNumber(value.createdAt, 'page.createdAt'),
    updatedAt: requireNumber(value.updatedAt, 'page.updatedAt'),
    ...(value.isTemplate === undefined ? {} : { isTemplate: requireBoolean(value.isTemplate, 'page.isTemplate') }),
    ...(value.templateVariables === undefined
      ? {}
      : { templateVariables: requireTemplateVariables(value.templateVariables) }),
  };
}

function requireTemplateVariables(value) {
  if (!Array.isArray(value)) throw new Error('Invalid page.templateVariables');

  return value.map((variable) => {
    if (!isRecord(variable)) throw new Error('Invalid page.templateVariables item');

    return {
      key: requireString(variable.key, 'templateVariable.key'),
      label: requireString(variable.label, 'templateVariable.label'),
      ...(variable.placeholder === undefined
        ? {}
        : { placeholder: requireString(variable.placeholder, 'templateVariable.placeholder') }),
      ...(variable.defaultValue === undefined
        ? {}
        : { defaultValue: requireString(variable.defaultValue, 'templateVariable.defaultValue') }),
    };
  });
}

function normalizeFolder(value) {
  if (!isRecord(value)) throw new Error('Invalid folder');

  return {
    id: requireString(value.id, 'folder.id'),
    title: requireString(value.title, 'folder.title'),
    parentId: requireNullableString(value.parentId, 'folder.parentId'),
    order: requireNumber(value.order, 'folder.order'),
    isExpanded: requireBoolean(value.isExpanded, 'folder.isExpanded'),
  };
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value, field) {
  if (typeof value !== 'string') throw new Error(`Invalid ${field}`);
  return value;
}

function requireNullableString(value, field) {
  if (typeof value === 'string' || value === null) return value;
  throw new Error(`Invalid ${field}`);
}

function requireNumber(value, field) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new Error(`Invalid ${field}`);
}

function requireBoolean(value, field) {
  if (typeof value === 'boolean') return value;
  throw new Error(`Invalid ${field}`);
}

app.get('/api/docs', async (_req, res, next) => {
  try {
    res.json(await readDocs());
  } catch (error) {
    next(error);
  }
});

app.post('/api/docs', async (req, res, next) => {
  try {
    const snapshot = normalizeDocsSnapshot(req.body);
    await writeDocs(snapshot);
    res.json(snapshot);
  } catch (error) {
    res.status(400);
    next(error);
  }
});

app.use((error, _req, res, next) => {
  void next;
  const status = res.statusCode >= 400 ? res.statusCode : 500;
  res.status(status).json({
    error: status === 500 ? 'Internal server error' : error.message,
  });
});

app.listen(port, () => {
  console.log(`Docs API listening on http://localhost:${port}`);
});
