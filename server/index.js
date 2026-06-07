import express from 'express';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDocsSnapshot } from './defaultDocs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const docsPath = process.env.DOCS_DATA_PATH
  ? path.resolve(process.env.DOCS_DATA_PATH)
  : path.resolve(__dirname, '..', 'data', 'docs.json');
const dataDir = path.dirname(docsPath);
const port = Number(process.env.PORT ?? 3001);
const openAiModel = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';

export const app = express();

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

function optionalString(value, field) {
  if (value === undefined) return '';
  return requireString(value, field);
}

async function generateEcoDocumentWithOpenAi(payload) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const error = new Error('OPENAI_API_KEY не настроен на сервере');
    error.statusCode = 503;
    throw error;
  }

  const isCorrection = Boolean(payload.corrections);
  const userPrompt = isCorrection
    ? `Доработай проект экологической документации.

Документ: ${payload.documentRequest}

Источники:
${payload.sources}

Текущий проект:
${payload.draft}

Корректировки:
${payload.corrections}`
    : `Разработай проект экологической документации.

Документ: ${payload.documentRequest}

Источники информации:
${payload.sources}`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: openAiModel,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            'Ты русскоязычный разработчик экологической документации. ' +
            'Пиши структурированный Markdown, уточняй недостающие исходные данные, ' +
            'не выдумывай числовые показатели и нормативные реквизиты без источников.',
        },
        {
          role: 'user',
          content: userPrompt,
        },
      ],
    }),
  });

  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body?.error?.message ?? 'OpenAI API вернул ошибку');
    error.statusCode = response.status;
    throw error;
  }

  const draft = body?.choices?.[0]?.message?.content;
  if (typeof draft !== 'string' || !draft.trim()) {
    throw new Error('OpenAI API вернул пустой ответ');
  }

  return draft.trim();
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

app.post('/api/ai/eco-agent', async (req, res, next) => {
  try {
    const body = req.body;
    if (!isRecord(body)) throw new Error('Invalid AI request');

    const documentRequest = requireString(body.documentRequest, 'documentRequest').trim();
    const sources = requireString(body.sources, 'sources').trim();
    const draft = optionalString(body.draft, 'draft').trim();
    const corrections = optionalString(body.corrections, 'corrections').trim();

    if (!documentRequest || !sources) {
      throw new Error('documentRequest and sources are required');
    }

    if (corrections && !draft) {
      throw new Error('draft is required for corrections');
    }

    res.json({
      draft: await generateEcoDocumentWithOpenAi({
        documentRequest,
        sources,
        draft,
        corrections,
      }),
    });
  } catch (error) {
    res.status(error.statusCode ?? 400);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(port, () => {
    console.log(`Docs API listening on http://localhost:${port}`);
  });
}
