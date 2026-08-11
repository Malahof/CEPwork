import express from 'express';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDocsSnapshot, ensureDefaultDocsStructure } from './defaultDocs.js';
import {
  createAgentProject,
  listOpenProjects,
  selectAgentAnswer,
  serializeAgentProject,
} from './agent/stateMachine.js';
import {
  readAgentProjects,
  updateAgentProjects,
} from './agent/storage.js';
import {
  buildMemorySystemPrompt,
  deleteInstruction,
  readUserMemory,
  saveInstruction,
  saveOrganization,
  saveUserPreferences,
} from './agent/memory.js';
import { registerCode112Upload } from './agent/generators/code112.js';
import { extractTextFromUploadedFile } from './agent/wasteDataExtractor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const docsPath = process.env.DOCS_DATA_PATH
  ? path.resolve(process.env.DOCS_DATA_PATH)
  : path.resolve(__dirname, '..', 'data', 'docs.json');
const dataDir = path.dirname(docsPath);
const agentProjectsPath = process.env.AGENT_PROJECTS_PATH
  ? path.resolve(process.env.AGENT_PROJECTS_PATH)
  : path.resolve(dataDir, 'eco_projects.json');
const agentOutputDir = process.env.AGENT_OUTPUT_DIR
  ? path.resolve(process.env.AGENT_OUTPUT_DIR)
  : path.resolve(dataDir, 'agent-docs');
const userMemoryPath = process.env.USER_MEMORY_PATH
  ? path.resolve(process.env.USER_MEMORY_PATH)
  : path.resolve(dataDir, 'user_memory.json');
const port = Number(process.env.PORT ?? 3001);
const openAiModel = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
const legacySampleTemplatePageIds = new Set([
  'template-meeting-notes',
  'template-project-plan',
  'template-eco-document',
]);

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
  const pages = value.pages
    .map(normalizePage)
    .filter((page) => !legacySampleTemplatePageIds.has(page.id));
  const folders = value.folders.map(normalizeFolder);
  const activePageId =
    typeof value.activePageId === 'string' || value.activePageId === null
      ? value.activePageId
      : null;

  return ensureDefaultDocsStructure({
    pages,
    folders,
    activePageId: activePageId && legacySampleTemplatePageIds.has(activePageId) ? 'welcome' : activePageId,
  });
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
    ...(value.templateValues === undefined
      ? {}
      : { templateValues: requireTemplateValues(value.templateValues) }),
  };
}

function requireTemplateValues(value) {
  if (!isRecord(value)) throw new Error('Invalid page.templateValues');
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, item === null || item === undefined ? '' : String(item)])
  );
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

async function parseMultipartFormData(req) {
  const contentType = req.headers['content-type'] ?? '';
  const boundaryMatch = contentType.match(/boundary=(?:(?:"([^"]+)")|([^;]+))/i);
  if (!boundaryMatch) {
    const error = new Error('Некорректные данные формы загрузки');
    error.statusCode = 400;
    throw error;
  }

  const body = await readRequestBuffer(req, 10 * 1024 * 1024);
  const boundary = `--${boundaryMatch[1] ?? boundaryMatch[2]}`;
  const fields = {};
  const files = {};

  for (const rawPart of body.toString('latin1').split(boundary)) {
    let part = rawPart;
    if (!part || part === '--' || part === '--\r\n') continue;
    if (part.startsWith('\r\n')) part = part.slice(2);
    if (part.endsWith('\r\n')) part = part.slice(0, -2);
    if (part.endsWith('--')) part = part.slice(0, -2);

    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;

    const headerLines = part.slice(0, headerEnd).split('\r\n');
    const headers = Object.fromEntries(
      headerLines.map((line) => {
        const separator = line.indexOf(':');
        return [line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()];
      })
    );
    const disposition = parseContentDisposition(headers['content-disposition'] ?? '');
    if (!disposition.name) continue;

    const content = Buffer.from(part.slice(headerEnd + 4), 'latin1');
    if (disposition.filename) {
      files[disposition.name] = {
        filename: path.basename(disposition.filename),
        mimeType: headers['content-type'] ?? 'application/octet-stream',
        buffer: content,
      };
    } else {
      fields[disposition.name] = content.toString('utf8');
    }
  }

  return { fields, files };
}

async function readRequestBuffer(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      const error = new Error('Загружаемый файл слишком большой');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseContentDisposition(value) {
  const result = {};
  for (const part of value.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (!rawKey || rawValue.length === 0) continue;
    result[rawKey] = rawValue.join('=').replace(/^"|"$/g, '');
  }
  return result;
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

  const memoryContext = payload.memoryContext ? `\n\nДолговременная память Цэпика:\n${payload.memoryContext}` : '';
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
            'не выдумывай числовые показатели и нормативные реквизиты без источников.' +
            memoryContext,
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

app.get('/api/memory', async (req, res, next) => {
  try {
    const memory = await readUserMemory(userMemoryPath);
    const section = typeof req.query.section === 'string' ? req.query.section : '';
    if (section) {
      if (!['userPreferences', 'organizations', 'savedInstructions'].includes(section)) {
        res.status(400);
        throw new Error('Неизвестный раздел памяти');
      }
      res.json(memory[section]);
      return;
    }
    res.json(memory);
  } catch (error) {
    next(error);
  }
});

app.post('/api/memory/save', async (req, res, next) => {
  try {
    const body = req.body;
    if (!isRecord(body)) throw new Error('Некорректный запрос памяти');

    const result = {};
    if (typeof body.text === 'string' && body.text.trim()) {
      const saved = await saveInstruction(userMemoryPath, body.text);
      result.instruction = saved.instruction;
      result.created = saved.created;
    }

    const preferences = isRecord(body.userPreferences)
      ? body.userPreferences
      : isRecord(body.preferences)
        ? body.preferences
        : null;
    if (preferences) {
      const saved = await saveUserPreferences(userMemoryPath, preferences);
      result.userPreferences = saved.userPreferences;
    }

    if (!Object.keys(result).length) throw new Error('Передайте text или userPreferences');
    result.memory = await readUserMemory(userMemoryPath);
    res.json(result);
  } catch (error) {
    res.status(error.statusCode ?? 400);
    next(error);
  }
});

app.post('/api/memory/organization', async (req, res, next) => {
  try {
    const body = req.body;
    if (!isRecord(body)) throw new Error('Некорректный запрос организации');
    const organizationBody = isRecord(body.organization) ? body.organization : body;
    const result = await saveOrganization(userMemoryPath, organizationBody);
    res.json(result);
  } catch (error) {
    res.status(error.statusCode ?? 400);
    next(error);
  }
});

app.delete('/api/memory/instruction/:id', async (req, res, next) => {
  try {
    const result = await deleteInstruction(userMemoryPath, req.params.id);
    if (!result.deleted) {
      res.status(404);
      throw new Error('Инструкция не найдена');
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/api/agent/start', async (_req, res, next) => {
  try {
    const project = createAgentProject(Date.now(), await readUserMemory(userMemoryPath));
    await updateAgentProjects(agentProjectsPath, (projects) => {
      projects.push(project);
      return project;
    });
    res.json(serializeAgentProject(project));
  } catch (error) {
    next(error);
  }
});

app.post('/api/agent/select', async (req, res, next) => {
  try {
    const body = req.body;
    if (!isRecord(body)) throw new Error('Некорректный запрос Цэпика');

    const projectId = requireString(body.projectId, 'projectId');
    const answer = requireString(body.answer, 'answer');

    const project = await updateAgentProjects(agentProjectsPath, (projects) => {
      const found = projects.find((item) => item.id === projectId);
      if (!found) {
        const error = new Error('Проект Цэпика не найден');
        error.statusCode = 404;
        throw error;
      }
      return selectAgentAnswer(found, answer, Date.now(), { outputDir: agentOutputDir, docsPath, memoryPath: userMemoryPath });
    });

    res.json(serializeAgentProject(project));
  } catch (error) {
    res.status(error.statusCode ?? 400);
    next(error);
  }
});

app.post('/api/agent/upload', async (req, res, next) => {
  try {
    const { fields, files } = await parseMultipartFormData(req);
    const projectId = requireString(fields.projectId, 'projectId');
    const file = files.file;
    if (!file) throw new Error('Необходимо выбрать файл для загрузки');

    const text = await extractTextFromUploadedFile(file);
    const charCount = [...text].length;
    const now = Date.now();
    const project = await updateAgentProjects(agentProjectsPath, async (projects) => {
      const found = projects.find((item) => item.id === projectId);
      if (!found) {
        const error = new Error('Проект Цэпика не найден');
        error.statusCode = 404;
        throw error;
      }

      const uploads = Array.isArray(found.extractedData.uploads) ? found.extractedData.uploads : [];
      const uploadRecord = {
        fileName: file.filename,
        mimeType: file.mimeType,
        charCount,
        text,
        uploadedAt: now,
      };
      found.extractedData.uploads = [
        ...uploads,
        uploadRecord,
      ];
      found.history.push({
        id: `agent-${found.history.length + 1}`,
        role: 'agent',
        text: `Файл «${file.filename}» загружен, извлечено ${charCount} символов.`,
        createdAt: now,
      });
      await registerCode112Upload(found, uploadRecord, { now });
      found.updatedAt = now;
      return found;
    });

    res.json({
      project: serializeAgentProject(project),
      fileName: file.filename,
      charCount,
      text,
    });
  } catch (error) {
    res.status(error.statusCode ?? 400);
    next(error);
  }
});


app.get('/api/agent/files/:projectId/:fileName', async (req, res, next) => {
  try {
    const projects = await readAgentProjects(agentProjectsPath);
    const project = projects.find((item) => item.id === req.params.projectId);
    if (!project) {
      res.status(404);
      throw new Error('Проект Цэпика не найден');
    }

    const files = project.extractedData?.code112?.files;
    const requestedFileName = path.basename(req.params.fileName);
    const file = files && Object.values(files).find((item) => item.fileName === requestedFileName);
    if (!file || typeof file.path !== 'string') {
      res.status(404);
      throw new Error('Файл Цэпика не найден');
    }

    const resolvedPath = path.resolve(file.path);
    const resolvedRoot = path.resolve(agentOutputDir);
    if (!resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
      res.status(400);
      throw new Error('Некорректный путь к файлу Цэпика');
    }

    res.download(resolvedPath, requestedFileName);
  } catch (error) {
    next(error);
  }
});

app.get('/api/agent/projects', async (_req, res, next) => {
  try {
    res.json(listOpenProjects(await readAgentProjects(agentProjectsPath)));
  } catch (error) {
    next(error);
  }
});

app.get('/api/agent/state/:projectId', async (req, res, next) => {
  try {
    const projects = await readAgentProjects(agentProjectsPath);
    const project = projects.find((item) => item.id === req.params.projectId);
    if (!project) {
      res.status(404);
      throw new Error('Проект Цэпика не найден');
    }
    res.json(serializeAgentProject(project));
  } catch (error) {
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
        memoryContext: buildMemorySystemPrompt(await readUserMemory(userMemoryPath)),
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
