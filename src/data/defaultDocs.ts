import type { DocsSnapshot, DocFolder, DocPage } from '../types';

const SAMPLE_CONTENT = `# Добро пожаловать в DocBuilder

DocBuilder — это браузерное приложение для создания и управления документацией.

## Возможности

- **Markdown-редактор** с живым предпросмотром
- **Древовидная навигация** по документам
- **Поиск** по всей документации
- **Экспорт** в HTML

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

## Печать

Используйте функцию печати браузера (Ctrl+P) для сохранения документации в PDF.
`,
    parentId: 'getting-started',
    order: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
];

export const defaultDocsSnapshot: DocsSnapshot = {
  pages: [initialPage, ...guidePages],
  folders: [initialFolder],
  activePageId: 'welcome',
};
