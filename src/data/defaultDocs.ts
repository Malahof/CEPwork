import type { DocsSnapshot, DocFolder, DocPage } from '../types';

const SAMPLE_CONTENT = `# Добро пожаловать в DocBuilder

DocBuilder — это браузерное приложение для создания и управления документацией.

## Возможности

- **Markdown-редактор** с живым предпросмотром
- **Древовидная навигация** по документам
- **Поиск** по всей документации
- **Экспорт** в HTML, DOCX и XLSX

## Начало работы

1. Создайте новую страницу через кнопку "+" в боковой панели
2. Напишите содержимое в Markdown-формате
3. Предпросмотр обновляется в реальном времени

## Примеры Markdown

### Таблица

| Функция | Описание |
|---------|----------|
| Редактор | Markdown-редактор с подсветкой |
| Навигация | Древовидная структура документов |
| Поиск | Полнотекстовый поиск |

### Код

\`\`\`typescript
function hello(name: string): string {
  return \`Привет, \${name}!\`;
}
\`\`\`

### Список задач

- [x] Создать проект
- [x] Добавить редактор
- [ ] Настроить деплой
`;

const initialPage: DocPage = {
  id: 'welcome',
  title: 'Добро пожаловать',
  content: SAMPLE_CONTENT,
  parentId: null,
  order: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const initialFolder: DocFolder = {
  id: 'getting-started',
  title: 'Руководство',
  parentId: null,
  order: 1,
  isExpanded: true,
};

const templatesFolder: DocFolder = {
  id: 'templates',
  title: 'Шаблоны',
  parentId: null,
  order: 2,
  isExpanded: true,
};

const guidePages: DocPage[] = [
  {
    id: 'guide-markdown',
    title: 'Синтаксис Markdown',
    content: `# Синтаксис Markdown

## Заголовки

Используйте \`#\` для заголовков:

\`\`\`markdown
# Заголовок 1
## Заголовок 2
### Заголовок 3
\`\`\`

## Форматирование текста

- **Жирный** — \`**текст**\`
- *Курсив* — \`*текст*\`
- ~~Зачёркнутый~~ — \`~~текст~~\`
- \`Код\` — \\\`код\\\`

## Ссылки и изображения

\`\`\`markdown
[Текст ссылки](https://example.com)
![Alt текст](https://example.com/image.png)
\`\`\`

## Списки

### Нумерованные
1. Первый пункт
2. Второй пункт
3. Третий пункт

### Маркированные
- Пункт A
- Пункт B
- Пункт C
`,
    parentId: 'getting-started',
    order: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'guide-export',
    title: 'Экспорт документации',
    content: `# Экспорт документации

## Экспорт в HTML

Нажмите кнопку экспорта в панели инструментов, чтобы скачать текущую страницу в формате HTML.

Экспортированный файл включает:
- Полностью оформленный HTML
- Встроенные стили
- Подсветку синтаксиса кода

## Экспорт в DOCX

Кнопка DOCX сохраняет текущую страницу в формате Microsoft Word.

## Экспорт в XLSX

Кнопка XLSX сохраняет текущую страницу в табличный файл Excel. Кнопка «Реестр XLSX» формирует сводный реестр всех документов с путём, датами обновления и объёмом текста.

## Печать

Используйте функцию печати браузера (Ctrl+P) для сохранения документации в PDF.
`,
    parentId: 'getting-started',
    order: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
];

const templatePages: DocPage[] = [
  {
    id: 'template-meeting-notes',
    title: 'Протокол встречи',
    content: `# Протокол встречи: {{meetingTopic}}

**Дата:** {{meetingDate}}

## Участники

{{participants}}

## Повестка

1. {{agenda}}

## Решения

- {{decisions}}

## Задачи

- [ ] {{tasks}}
`,
    parentId: 'templates',
    order: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    isTemplate: true,
    templateVariables: [
      { key: 'meetingTopic', label: 'Тема встречи', placeholder: 'Например: согласование ПНООЛР' },
      { key: 'meetingDate', label: 'Дата', placeholder: 'Например: 15.06.2026' },
      { key: 'participants', label: 'Участники', placeholder: 'Список участников' },
      { key: 'agenda', label: 'Повестка', placeholder: 'Основной вопрос обсуждения' },
      { key: 'decisions', label: 'Решения', placeholder: 'Принятые решения' },
      { key: 'tasks', label: 'Задачи', placeholder: 'Следующее действие' },
    ],
  },
  {
    id: 'template-project-plan',
    title: 'План проекта',
    content: `# План проекта: {{projectName}}

## Цель

{{goal}}

## Область работ

{{scope}}

## Этапы

| Этап | Срок | Ответственный |
|------|------|---------------|
| {{stage}} | {{deadline}} | {{owner}} |

## Риски

- {{risks}}

## Следующие шаги

- [ ] {{nextSteps}}
`,
    parentId: 'templates',
    order: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    isTemplate: true,
    templateVariables: [
      { key: 'projectName', label: 'Название проекта', placeholder: 'Например: инвентаризация источников выбросов' },
      { key: 'goal', label: 'Цель', placeholder: 'Что нужно получить в результате' },
      { key: 'scope', label: 'Область работ', placeholder: 'Перечень работ и границы проекта' },
      { key: 'stage', label: 'Первый этап', placeholder: 'Например: сбор исходных данных' },
      { key: 'deadline', label: 'Срок', placeholder: 'Например: 30.06.2026' },
      { key: 'owner', label: 'Ответственный', placeholder: 'ФИО или роль' },
      { key: 'risks', label: 'Риски', placeholder: 'Основной риск проекта' },
      { key: 'nextSteps', label: 'Следующий шаг', placeholder: 'Первое действие после создания плана' },
    ],
  },
  {
    id: 'template-eco-document',
    title: 'Экологический документ',
    content: `# {{documentTitle}}

## 1. Основание для разработки

{{basis}}

## 2. Исходные данные

{{sources}}

## 3. Описание объекта

{{objectDescription}}

## 4. Экологические аспекты

{{ecoAspects}}

## 5. Мероприятия и контроль

{{measures}}
`,
    parentId: 'templates',
    order: 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    isTemplate: true,
    templateVariables: [
      { key: 'documentTitle', label: 'Название документа', placeholder: 'Например: Паспорт отходов для склада' },
      { key: 'basis', label: 'Основание', placeholder: 'НПА, договор, внутреннее распоряжение' },
      { key: 'sources', label: 'Источники информации', placeholder: 'Исходные данные, файлы, результаты обследования' },
      { key: 'objectDescription', label: 'Описание объекта', placeholder: 'Площадка, процесс, оборудование' },
      { key: 'ecoAspects', label: 'Экологические аспекты', placeholder: 'Отходы, выбросы, сбросы, риски' },
      { key: 'measures', label: 'Мероприятия и контроль', placeholder: 'Что нужно выполнить и как контролировать' },
    ],
  },
];

export const defaultDocsSnapshot: DocsSnapshot = {
  pages: [initialPage, ...guidePages, ...templatePages],
  folders: [initialFolder, templatesFolder],
  activePageId: 'welcome',
};
