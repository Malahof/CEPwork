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
2. Нажмите «Новый проект» или отправьте первое сообщение, затем выберите сферу, направление и пакет документов
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

1. Нажмите «Новый проект» в постоянной панели чата или отправьте первое сообщение.
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
    id: 'template-inventory-act-title',
    title: 'Титул акта (шаблон)',
    content: `# Титул акта инвентаризации (шаблон)

Файл DOCX: \`templates/docx/inventory_act/title_page_template.docx\`

Страница справочная и помечена как шаблон. Она показывает метки, которые Цэпик заменяет при генерации титульного листа.

## Метки для замены

| Метка | Значение |
|---|---|
| \`[название_организации]\` | Название организации |
| \`[должность_руководителя]\` | Должность руководителя |
| \`[инициалы_фамилия_руководителя]\` | Инициалы и фамилия руководителя |
| \`[юридический_адрес]\` | Юридический адрес |
| \`[дата_акта]\` | Дата акта в формате ДД.ММ.ГГГГ |
| \`[дата_начала]\` | Дата начала инвентаризации в формате ДД.ММ.ГГГГ |
| \`[должность_председателя]\` | Должность председателя комиссии |
| \`[инициалы_фамилия_председателя]\` | Инициалы и фамилия председателя |
| \`[должность_члена_комиссии]\` | Должность члена комиссии, повторяется для каждого члена |
| \`[инициалы_фамилия_члена_комиссии]\` | Инициалы и фамилия члена комиссии, повторяется для каждого члена |
`,
    parentId: 'templates-inventory-act',
    order: 0,
    isTemplate: true,
  },
  {
    id: 'template-inventory-act-appendix',
    title: 'Приложение к акту (шаблон)',
    content: `# Приложение к акту инвентаризации (шаблон)

Файл DOCX: \`templates/docx/inventory_act/appendix_template.docx\`

Цэпик заполняет строки отходов по классам и пересчитывает итоговые суммы по количественным колонкам.

## Метки для замены

| Метка | Значение |
|---|---|
| \`[название_организации]\` | Название организации |
| \`[дата_акта]\` | Дата акта в формате ДД.ММ.ГГГГ |
| \`[отход]\` | Наименование отхода |
| \`[код]\` | Код отхода |
| \`[норматив]\` | Норматив образования отхода |
| \`[количество]\` | Общее количество отхода |
| \`[кол_использование]\` | Количество, направленное на использование |
| \`[кол_обезвреживание]\` | Количество, направленное на обезвреживание |
| \`[кол_хранение]\` | Количество, направленное на хранение |
| \`[кол_захоронение]\` | Количество, направленное на захоронение |
| \`[кол_сортировка]\` | Количество, направленное на сортировку |
| \`[кол_заготовка]\` | Количество, направленное на заготовку |
| \`[сумма_кол4]\` | Итог по колонке 4 |
| \`[сумма_кол5]\` | Итог по колонке 5 |
| \`[сумма_кол6]\` | Итог по колонке 6 |
| \`[сумма_кол7]\` | Итог по колонке 7 |
| \`[сумма_кол8]\` | Итог по колонке 8 |
| \`[сумма_кол9]\` | Итог по колонке 9 |
| \`[сумма_кол10]\` | Итог по колонке 10 |
`,
    parentId: 'templates-inventory-act',
    order: 1,
    isTemplate: true,
  },
  {
    id: 'template-inventory-act-sources',
    title: 'Источники образования отходов (шаблон)',
    content: `# Источники образования отходов (шаблон)

Файл DOCX: \`templates/docx/inventory_act/sources_template.docx\`

Цэпик добавляет строку для каждого источника образования отходов.

## Метки для замены

| Метка | Значение |
|---|---|
| \`[название_организации]\` | Название организации |
| \`[номер_источника]\` | Номер источника |
| \`[участок]\` | Участок или подразделение |
| \`[источник]\` | Описание источника образования отхода |
| \`[отход]\` | Наименование отхода |
| \`[код]\` | Код отхода |
| \`[количество_кг_шт]\` | Количество в кг или штуках |
`,
    parentId: 'templates-inventory-act',
    order: 2,
    isTemplate: true,
  },
  {
    id: 'template-inventory-act-waste-generation',
    title: 'Образование отходов (шаблон)',
    content: `# Образование отходов (шаблон)

Файл DOCX: \`templates/docx/inventory_act/waste_generation_template.docx\`

Цэпик добавляет строку для каждого отхода и источника образования.

## Метки для замены

| Метка | Значение |
|---|---|
| \`[название_организации]\` | Название организации |
| \`[источник]\` | Источник образования отхода |
| \`[отход]\` | Наименование отхода |
| \`[код]\` | Код отхода |
| \`[класс]\` | Класс опасности |
| \`[физ_сост]\` | Физическое состояние |
| \`[свойства]\` | Опасные свойства или характеристика отхода |
| \`[состав]\` | Компонентный состав |
| \`[состав_%]\` | Доля компонента в процентах |
| \`[норматив]\` | Норматив образования |
| \`[кол-во_участков]\` | Количество участков или источников |
| \`[количество]\` | Количество отхода |
| \`[количество_т_шт]\` | Количество в тоннах или штуках |
`,
    parentId: 'templates-inventory-act',
    order: 3,
    isTemplate: true,
  },
  {
    id: 'template-inventory-act-measures',
    title: 'Перечень мероприятий (шаблон)',
    content: `# Перечень мероприятий (шаблон)

Файл DOCX: \`templates/docx/inventory_act/measures_template.docx\`

Цэпик формирует страницу мероприятий и подставляет данные председателя комиссии.

## Метки для замены

| Метка | Значение |
|---|---|
| \`[должность_председателя]\` | Должность председателя комиссии |
| \`[инициалы_фамилия_председателя]\` | Инициалы и фамилия председателя |
`,
    parentId: 'templates-inventory-act',
    order: 4,
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
  'template-inventory-act-overview',
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
