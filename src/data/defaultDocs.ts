import type { DocsSnapshot, DocFolder, DocPage } from '../types';

const now = Date.now();

const SAMPLE_CONTENT = `# Добро пожаловать в DocBuilder

DocBuilder — это браузерное приложение для создания и управления экологической документацией.

## Возможности

- **Markdown-редактор** с живым предпросмотром
- **Древовидная навигация** по документам
- **Экспорт** в HTML, DOCX и XLSX
- **Цэпик** для пошагового сбора данных и генерации DOCX по шаблонам

## Начало работы

1. Откройте чат Цэпика справа — он всегда доступен на экране
2. Нажмите «Новый проект» и выберите сферу, направление и пакет документов
3. Введите данные в закреплённом поле снизу чата или прикрепите файл через скрепку
4. Сгенерированные документы появятся в папке «В разработке»
`;

const pageDefinitions: Array<Omit<DocPage, 'createdAt' | 'updatedAt'>> = [
  {
    id: 'welcome',
    title: 'Добро пожаловать',
    content: SAMPLE_CONTENT,
    parentId: null,
    order: 0,
  },
  {
    id: 'guide-workflow',
    title: 'Работа с Цэпиком',
    content: `# Работа с Цэпиком

Цэпик ведёт пользователя по дереву выбора экологической документации и собирает исходные данные для генерации документов.

## Основной сценарий

1. Нажмите «Новый проект» в постоянной панели чата.
2. Выберите сферу и направление работ.
3. Выберите нужный пакет, например «Акт инвентаризации».
4. Отправляйте ответы сообщениями или прикрепляйте файлы через скрепку.
5. После генерации откройте созданные документы в папке «В разработке».
`,
    parentId: 'getting-started',
    order: 0,
  },
  {
    id: 'guide-export',
    title: 'Экспорт документов',
    content: `# Экспорт документов

Кнопки экспорта в верхней панели позволяют скачать текущую страницу в HTML, DOCX или XLSX.

Для структурированных экологических документов Цэпик использует DOCX-шаблоны: загружает шаблон, подставляет данные в метки и добавляет результат в дерево документов.
`,
    parentId: 'getting-started',
    order: 1,
  },
  {
    id: 'template-inventory-act-overview',
    title: 'Акт инвентаризации',
    content: `# Шаблон: Акт инвентаризации

Заглушка ветки code112. Цэпик формирует пять DOCX-файлов из шаблонов в \`templates/docx/inventory_act/\` и помещает результаты в папку «В разработке».
`,
    parentId: 'templates-inventory-act',
    order: 0,
    isTemplate: true,
  },
  {
    id: 'template-instruction-overview',
    title: 'Инструкция',
    content: `# Шаблон: Инструкция

Заглушка для будущей ветки «Инструкция». Структурированные документы этой ветки должны создаваться по DOCX-шаблонам.
`,
    parentId: 'templates-instruction',
    order: 0,
    isTemplate: true,
  },
  {
    id: 'template-pod-overview',
    title: 'ПОД',
    content: `# Шаблон: ПОД

Заглушка для будущей ветки ПОД. После реализации страницы-шаблоны будут храниться в этой папке.
`,
    parentId: 'templates-pod',
    order: 0,
    isTemplate: true,
  },
];

const folderDefinitions: DocFolder[] = [
  {
    id: 'getting-started',
    title: 'Руководство',
    parentId: null,
    order: 0,
    isExpanded: true,
  },
  {
    id: 'templates',
    title: 'Шаблоны',
    parentId: null,
    order: 1,
    isExpanded: true,
  },
  {
    id: 'templates-inventory-act',
    title: 'Акт инвентаризации',
    parentId: 'templates',
    order: 0,
    isExpanded: true,
  },
  {
    id: 'templates-instruction',
    title: 'Инструкция',
    parentId: 'templates',
    order: 1,
    isExpanded: true,
  },
  {
    id: 'templates-pod',
    title: 'ПОД',
    parentId: 'templates',
    order: 2,
    isExpanded: true,
  },
  {
    id: 'in-progress',
    title: 'В разработке',
    parentId: null,
    order: 2,
    isExpanded: true,
  },
  {
    id: 'archive',
    title: 'Архив',
    parentId: null,
    order: 3,
    isExpanded: false,
  },
];

const legacySampleTemplatePageIds = new Set([
  'template-meeting-notes',
  'template-project-plan',
  'template-eco-document',
]);

function withTimestamps(page: Omit<DocPage, 'createdAt' | 'updatedAt'>): DocPage {
  return {
    ...page,
    createdAt: now,
    updatedAt: now,
  };
}

export const defaultDocsSnapshot: DocsSnapshot = {
  pages: pageDefinitions.map(withTimestamps),
  folders: folderDefinitions.map((folder) => ({ ...folder })),
  activePageId: 'welcome',
};

export function ensureDefaultDocsStructure(snapshot: DocsSnapshot): DocsSnapshot {
  const pagesById = new Map<string, DocPage>();
  const foldersById = new Map<string, DocFolder>();

  snapshot.folders.forEach((folder) => foldersById.set(folder.id, { ...folder }));
  folderDefinitions.forEach((folder) => {
    const existing = foldersById.get(folder.id);
    foldersById.set(folder.id, {
      ...folder,
      ...existing,
      title: folder.title,
      parentId: folder.parentId,
      order: folder.order,
    });
  });

  snapshot.pages
    .filter((page) => !legacySampleTemplatePageIds.has(page.id))
    .forEach((page) => pagesById.set(page.id, { ...page }));
  pageDefinitions.forEach((page) => {
    const existing = pagesById.get(page.id);
    pagesById.set(
      page.id,
      existing
        ? { ...page, ...existing, title: page.title, parentId: page.parentId, order: page.order, isTemplate: page.isTemplate }
        : withTimestamps(page)
    );
  });

  const folders = Array.from(foldersById.values()).map((folder) => {
    const isGeneratedProjectFolder = folder.id.startsWith('agent-') && folder.parentId === null;
    return isGeneratedProjectFolder ? { ...folder, parentId: 'in-progress' } : folder;
  });
  const activePageId = legacySampleTemplatePageIds.has(snapshot.activePageId ?? '')
    ? 'welcome'
    : snapshot.activePageId ?? 'welcome';

  return {
    pages: Array.from(pagesById.values()),
    folders,
    activePageId,
  };
}
