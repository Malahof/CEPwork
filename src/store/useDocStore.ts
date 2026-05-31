import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { DocPage, DocFolder } from '../types';

interface DocState {
  pages: DocPage[];
  folders: DocFolder[];
  activePageId: string | null;
  sidebarOpen: boolean;
  searchQuery: string;

  addPage: (title: string, parentId: string | null) => DocPage;
  updatePage: (id: string, updates: Partial<Pick<DocPage, 'title' | 'content'>>) => void;
  deletePage: (id: string) => void;
  setActivePage: (id: string | null) => void;

  addFolder: (title: string, parentId: string | null) => DocFolder;
  updateFolder: (id: string, updates: Partial<Pick<DocFolder, 'title'>>) => void;
  deleteFolder: (id: string) => void;
  toggleFolder: (id: string) => void;

  toggleSidebar: () => void;
  setSearchQuery: (query: string) => void;
  reorderPage: (id: string, newOrder: number) => void;
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

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

export const useDocStore = create<DocState>()(
  persist(
    (set, get) => ({
      pages: [initialPage, ...guidePages],
      folders: [initialFolder],
      activePageId: 'welcome',
      sidebarOpen: true,
      searchQuery: '',

      addPage: (title, parentId) => {
        const pages = get().pages;
        const siblings = pages.filter((p) => p.parentId === parentId);
        const newPage: DocPage = {
          id: generateId(),
          title,
          content: `# ${title}\n\nНачните писать здесь...`,
          parentId,
          order: siblings.length,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        set((state) => ({
          pages: [...state.pages, newPage],
          activePageId: newPage.id,
        }));
        return newPage;
      },

      updatePage: (id, updates) => {
        set((state) => ({
          pages: state.pages.map((p) =>
            p.id === id ? { ...p, ...updates, updatedAt: Date.now() } : p
          ),
        }));
      },

      deletePage: (id) => {
        set((state) => ({
          pages: state.pages.filter((p) => p.id !== id),
          activePageId: state.activePageId === id ? null : state.activePageId,
        }));
      },

      setActivePage: (id) => set({ activePageId: id }),

      addFolder: (title, parentId) => {
        const folders = get().folders;
        const siblings = folders.filter((f) => f.parentId === parentId);
        const newFolder: DocFolder = {
          id: generateId(),
          title,
          parentId,
          order: siblings.length,
          isExpanded: true,
        };
        set((state) => ({
          folders: [...state.folders, newFolder],
        }));
        return newFolder;
      },

      updateFolder: (id, updates) => {
        set((state) => ({
          folders: state.folders.map((f) =>
            f.id === id ? { ...f, ...updates } : f
          ),
        }));
      },

      deleteFolder: (id) => {
        const state = get();
        const childPageIds = state.pages
          .filter((p) => p.parentId === id)
          .map((p) => p.id);
        const childFolderIds = state.folders
          .filter((f) => f.parentId === id)
          .map((f) => f.id);

        set((s) => ({
          folders: s.folders.filter(
            (f) => f.id !== id && !childFolderIds.includes(f.id)
          ),
          pages: s.pages.filter(
            (p) => !childPageIds.includes(p.id) && p.parentId !== id
          ),
          activePageId:
            s.activePageId && childPageIds.includes(s.activePageId)
              ? null
              : s.activePageId,
        }));
      },

      toggleFolder: (id) => {
        set((state) => ({
          folders: state.folders.map((f) =>
            f.id === id ? { ...f, isExpanded: !f.isExpanded } : f
          ),
        }));
      },

      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      setSearchQuery: (query) => set({ searchQuery: query }),

      reorderPage: (id, newOrder) => {
        set((state) => ({
          pages: state.pages.map((p) =>
            p.id === id ? { ...p, order: newOrder } : p
          ),
        }));
      },
    }),
    {
      name: 'doc-builder-storage',
    }
  )
);
