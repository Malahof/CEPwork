import { randomUUID } from 'node:crypto';
import {
  code112Documents,
  readDocsSnapshot,
  regenerateArchivedCode112Documents,
  writeDocsSnapshot,
} from './code112.js';

export const ARCHIVE_SESSION_STATUS = 'archive_edit';

const CONFIRM_OPTIONS = [
  { key: 'yes', label: 'Да' },
  { key: 'no', label: 'Нет' },
];

const MODE_OPTIONS = [
  { key: 'manual', label: 'Вручную' },
  { key: 'assistant', label: 'Заменить переменную' },
];

const MANUAL_OPTIONS = [
  { key: 'done', label: 'Готово' },
  { key: 'continue', label: 'Продолжить' },
  { key: 'exit', label: 'Выход' },
];

const MORE_OPTIONS = CONFIRM_OPTIONS;

const GENERATE_OPTIONS = [
  ...code112Documents.map((document) => ({ key: `gen-${document.key}`, label: document.label })),
  { key: 'gen-all', label: 'Все документы' },
  { key: 'cancel', label: 'Отмена' },
];

function addAgentMessage(project, text, now) {
  project.history = Array.isArray(project.history) ? project.history : [];
  project.history.push({ id: `agent-${project.history.length + 1}`, role: 'agent', text, createdAt: now });
}

function addUserMessage(project, text, now) {
  project.history = Array.isArray(project.history) ? project.history : [];
  project.history.push({ id: `user-${project.history.length + 1}`, role: 'user', text, createdAt: now });
}

function normalizeAnswer(value) {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е');
}

function isYesAnswer(answer) {
  const normalized = normalizeAnswer(answer);
  return normalized === 'yes' || normalized === 'да';
}

function isNoAnswer(answer) {
  const normalized = normalizeAnswer(answer);
  return normalized === 'no' || normalized === 'нет';
}

export function isArchivedPage(snapshot, pageId) {
  const foldersById = new Map((snapshot.folders ?? []).map((folder) => [folder.id, folder]));
  const page = (snapshot.pages ?? []).find((item) => item.id === pageId);
  if (!page) return false;
  let parentId = page.parentId;
  const visited = new Set();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const folder = foldersById.get(parentId);
    if (!folder) return false;
    if (folder.id === 'archive' || folder.id.startsWith('archive-')) return true;
    parentId = folder.parentId;
  }
  return false;
}

export function extractArchivedProjectId(pageId) {
  const match = /^agent-([0-9a-f-]{36})-code112-/.exec(String(pageId ?? ''));
  return match?.[1] ?? null;
}

export function createArchiveEditSession(sourceProjectId, pageId, now, organizationName = '') {
  const project = {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    status: ARCHIVE_SESSION_STATUS,
    currentNode: null,
    selections: {},
    systemPrompt: '',
    packageTitle: `Архив: ${organizationName || 'проект'}`,
    packageCode: '112',
    extractedData: {
      archiveEdit: {
        sourceProjectId,
        pageId,
        stage: 'confirm',
        variable: null,
        changedDocuments: [],
      },
    },
    history: [],
  };
  addAgentMessage(project, 'Вы открыли страницу из архива. Вы хотите изменить что-то в Архиве?', now);
  console.log('[archiveEdit] Создана сессия редактирования архива', { sessionId: project.id, sourceProjectId, pageId });
  return project;
}

function archivePagePrefix(sourceProjectId) {
  return `agent-${sourceProjectId}-code112-`;
}

function documentKeyFromPageId(sourceProjectId, pageId) {
  const prefix = archivePagePrefix(sourceProjectId);
  return pageId.startsWith(prefix) ? pageId.slice(prefix.length) : null;
}

async function archivedProjectPages(docsPath, sourceProjectId) {
  const snapshot = await readDocsSnapshot(docsPath);
  const prefix = archivePagePrefix(sourceProjectId);
  const pages = (snapshot.pages ?? []).filter((page) => page.id.startsWith(prefix));
  return { snapshot, pages };
}

export function getArchiveEditQuestion(project) {
  const session = project?.extractedData?.archiveEdit;
  if (!session) return null;
  switch (session.stage) {
    case 'confirm':
      return 'Вы хотите изменить что-то в Архиве?';
    case 'mode':
      return 'Вы хотите сделать это вручную или с моей помощью?';
    case 'variable':
      return 'Введите название переменной (в квадратных скобках или без них).';
    case 'value':
      return `Введите новое значение для [${session.variable}]:`;
    case 'more':
      return 'Нужно ли ещё что-то изменить?';
    case 'manual':
      return 'Вы закончили правку?';
    case 'generate':
      return 'Какие документы сгенерировать заново?';
    default:
      return null;
  }
}

export function getArchiveEditOptions(project) {
  const session = project?.extractedData?.archiveEdit;
  if (!session) return [];
  switch (session.stage) {
    case 'confirm':
      return CONFIRM_OPTIONS;
    case 'mode':
      return MODE_OPTIONS;
    case 'more':
      return MORE_OPTIONS;
    case 'manual':
      return MANUAL_OPTIONS;
    case 'generate':
      return GENERATE_OPTIONS;
    default:
      return [];
  }
}

function finishSession(project, message, now) {
  const session = project.extractedData.archiveEdit;
  session.stage = 'done';
  project.status = 'completed';
  addAgentMessage(project, message, now);
  project.updatedAt = now;
  console.log('[archiveEdit] Сессия завершена, проект остаётся в архиве', { sessionId: project.id });
  return project;
}

async function startGenerateStage(project, session, now) {
  session.stage = 'generate';
  addAgentMessage(project, 'Какие документы сгенерировать заново?', now);
  project.updatedAt = now;
  return project;
}

export async function handleArchiveEdit(project, answer, now, context = {}) {
  const session = project.extractedData?.archiveEdit;
  const docsPath = context.docsPath;
  const outputDir = context.outputDir;
  addUserMessage(project, answer, now);

  if (!session || session.stage === 'done') {
    return finishSession(project, 'Редактирование архива завершено.', now);
  }

  if (session.stage === 'confirm') {
    if (isNoAnswer(answer)) {
      return finishSession(project, 'Хорошо. Страница доступна для просмотра в архиве без изменений.', now);
    }
    if (isYesAnswer(answer)) {
      session.stage = 'mode';
      addAgentMessage(project, 'Вы хотите сделать это вручную или с моей помощью?', now);
      project.updatedAt = now;
      return project;
    }
    addAgentMessage(project, 'Вы хотите изменить что-то в Архиве?', now);
    project.updatedAt = now;
    return project;
  }

  if (session.stage === 'mode') {
    const normalized = normalizeAnswer(answer);
    if (normalized === 'manual' || normalized.includes('вручную')) {
      session.stage = 'manual';
      session.manualStartedAt = now;
      addAgentMessage(
        project,
        'Вы можете вручную отредактировать страницы в архиве. Когда закончите, напишите «Готово». Список отходов останется без изменений — можно менять только значения существующих переменных (реквизиты, даты, должности и т.п.).',
        now
      );
      addAgentMessage(project, 'Вы закончили правку?', now);
      project.updatedAt = now;
      return project;
    }
    if (normalized === 'assistant' || normalized.includes('помощь') || normalized.includes('переменн')) {
      session.stage = 'variable';
      addAgentMessage(project, 'Введите название переменной (в квадратных скобках или без них).', now);
      project.updatedAt = now;
      return project;
    }
    addAgentMessage(project, 'Вы хотите сделать это вручную или с моей помощью?', now);
    project.updatedAt = now;
    return project;
  }

  if (session.stage === 'variable') {
    const variable = answer.trim().replace(/^\[|\]$/g, '').replace(/^\{\{|\}\}$/g, '').trim();
    if (!variable) {
      addAgentMessage(project, 'Введите название переменной (в квадратных скобках или без них).', now);
      project.updatedAt = now;
      return project;
    }
    const { pages } = await archivedProjectPages(docsPath, session.sourceProjectId);
    const patterns = [`[${variable}]`, `{{${variable}}}`];
    const occurrences = pages.reduce(
      (count, page) => count + patterns.reduce((sum, pattern) => sum + page.content.split(pattern).length - 1, 0),
      0
    );
    console.log('[archiveEdit] Поиск переменной', { variable, occurrences, pages: pages.length });
    session.variable = variable;
    session.stage = 'value';
    addAgentMessage(
      project,
      occurrences
        ? `Переменная [${variable}] найдена в документах (${occurrences} вх.). Введите новое значение для [${variable}]:`
        : `Переменная [${variable}] не найдена в архивных документах. Всё равно введите новое значение для [${variable}]:`,
      now
    );
    project.updatedAt = now;
    return project;
  }

  if (session.stage === 'value') {
    const variable = session.variable;
    const newValue = answer;
    const { snapshot, pages } = await archivedProjectPages(docsPath, session.sourceProjectId);
    const patterns = [`[${variable}]`, `{{${variable}}}`];
    let replaced = 0;
    const changedDocs = new Set(session.changedDocuments);
    for (const page of pages) {
      let content = page.content;
      for (const pattern of patterns) {
        while (content.includes(pattern)) {
          content = content.replace(pattern, newValue);
          replaced += 1;
        }
      }
      if (content !== page.content) {
        page.content = content;
        page.updatedAt = now;
        const docKey = documentKeyFromPageId(session.sourceProjectId, page.id);
        if (docKey) changedDocs.add(docKey);
      }
    }
    session.changedDocuments = [...changedDocs];
    if (replaced) {
      await writeDocsSnapshot(docsPath, snapshot);
      addAgentMessage(project, `Заменил [${variable}] на «${newValue}» (${replaced} вх.).`, now);
    } else {
      addAgentMessage(project, `Значение для [${variable}] сохранено, но вхождений в архивных страницах не найдено.`, now);
    }
    console.log('[archiveEdit] Замена переменной', { variable, replaced, changedDocs: session.changedDocuments });
    session.stage = 'more';
    addAgentMessage(project, 'Нужно ли ещё что-то изменить?', now);
    project.updatedAt = now;
    return project;
  }

  if (session.stage === 'more') {
    if (isYesAnswer(answer)) {
      session.stage = 'variable';
      addAgentMessage(project, 'Введите название переменной (в квадратных скобках или без них).', now);
      project.updatedAt = now;
      return project;
    }
    if (isNoAnswer(answer)) {
      return startGenerateStage(project, session, now);
    }
    addAgentMessage(project, 'Нужно ли ещё что-то изменить?', now);
    project.updatedAt = now;
    return project;
  }

  if (session.stage === 'manual') {
    const normalized = normalizeAnswer(answer);
    if (normalized === 'exit' || normalized === 'выход') {
      return finishSession(project, 'Редактирование завершено без генерации. Проект остаётся в архиве.', now);
    }
    if (normalized === 'continue' || isNoAnswer(answer) || normalized.includes('продолж')) {
      addAgentMessage(project, 'Вы закончили правку?', now);
      project.updatedAt = now;
      return project;
    }
    if (normalized === 'done' || normalized === 'готово' || isYesAnswer(answer)) {
      const { snapshot, pages } = await archivedProjectPages(docsPath, session.sourceProjectId);
      const changed = new Set(session.changedDocuments);
      for (const page of pages) {
        const key = documentKeyFromPageId(session.sourceProjectId, page.id);
        if (key && Number.isFinite(page.updatedAt) && page.updatedAt >= session.manualStartedAt) changed.add(key);
      }
      session.changedDocuments = [...changed];
      return startGenerateStage(project, session, now);
    }
    addAgentMessage(project, 'Вы закончили правку?', now);
    project.updatedAt = now;
    return project;
  }

  if (session.stage === 'generate') {
    const normalized = normalizeAnswer(answer);
    if (normalized === 'cancel' || normalized === 'отмена') {
      return finishSession(project, 'Генерация отменена. Проект остаётся в архиве.', now);
    }
    let docKeys = null;
    if (normalized !== 'gen-all' && normalized !== 'все документы' && normalized !== 'все') {
      const key = normalized.startsWith('gen-') ? normalized.slice(4) : null;
      const document = code112Documents.find(
        (item) => item.key === key || normalizeAnswer(item.label) === normalized
      );
      if (!document) {
        addAgentMessage(project, 'Какие документы сгенерировать заново?', now);
        project.updatedAt = now;
        return project;
      }
      docKeys = [document.key];
    }
    const selectedKeys = docKeys ?? (session.changedDocuments.length ? session.changedDocuments : code112Documents.map((d) => d.key));
    const { results } = await regenerateArchivedCode112Documents(
      session.sourceProjectId,
      selectedKeys,
      outputDir,
      docsPath,
      now
    );
    const links = results.map((item) => `• ${item.label}: [скачать DOCX](${item.downloadUrl})`).join('\n');
    console.log('[archiveEdit] Документы регенерированы, проект остаётся в архиве', {
      sessionId: project.id,
      sourceProjectId: session.sourceProjectId,
      documents: selectedKeys,
    });
    return finishSession(project, `Готово. Сгенерированы файлы:\n${links}\nПроект остаётся в архиве.`, now);
  }

  addAgentMessage(project, getArchiveEditQuestion(project) ?? 'Вы хотите изменить что-то в Архиве?', now);
  project.updatedAt = now;
  return project;
}
