# DocBuilder

Браузерное приложение для разработки и управления документацией.

## Возможности

- **Markdown-редактор** с панелью инструментов (жирный, курсив, заголовки, списки, код, цитаты, ссылки, изображения, таблицы)
- **Живой предпросмотр** Markdown в реальном времени
- **Древовидная навигация** по страницам и папкам
- **Управление документами** — создание, переименование, удаление страниц и папок
- **Полнотекстовый поиск** по документации
- **Экспорт** страниц в HTML, DOCX и XLSX
- **Реестр документов** — выгрузка списка страниц и метаданных в XLSX
- **Шаблоны** с переменными и созданием новых документов через форму
- **ИИ-агент экологической документации** — режим OpenAI через серверный `OPENAI_API_KEY` и локальный Wizard
- **Санитизация HTML** через DOMPurify при HTML-экспорте
- **Сохранение данных** через серверный API
- **Адаптивный дизайн** для десктопа и мобильных устройств
- **Горячие клавиши** (Ctrl+B — жирный, Ctrl+I — курсив, Tab — отступ)

## Технологии

- React 19 + TypeScript
- Vite
- Zustand (управление состоянием)
- Express API для хранения документов
- react-markdown + remark-gfm + rehype-slug
- docx, xlsx, DOMPurify

## Установка и запуск

```bash
npm install
npm run dev
```

Команда запускает Express API на `http://localhost:3001` и Vite-клиент на `http://localhost:5173`.
Документы сохраняются сервером в `data/docs.json`; директория `data/` не коммитится.

Для режима OpenAI у ИИ-агента задайте серверную переменную окружения:

```bash
OPENAI_API_KEY=sk-... npm run dev
```

Опционально можно сменить модель:

```bash
OPENAI_MODEL=gpt-4o-mini npm run dev
```

## Доступные команды

| Команда | Описание |
|---------|----------|
| `npm run dev` | Запуск клиента и Express API |
| `npm run client` | Запуск Vite-клиента |
| `npm run server` | Запуск Express API |
| `npm run build` | Сборка для продакшена (в папку `dist/`) |
| `npm run preview` | Предпросмотр продакшен-сборки |
| `npm run lint` | Проверка кода через ESLint |
| `npm test` | Базовые API-тесты через Node test runner |

## API

| Метод | Путь | Описание |
|-------|------|----------|
| `GET` | `/api/docs` | Получить текущие страницы, папки и активную страницу |
| `POST` | `/api/docs` | Сохранить текущие страницы, папки и активную страницу |
| `POST` | `/api/ai/eco-agent` | Сгенерировать или скорректировать экологический документ через OpenAI |

`POST /api/docs` принимает объект:

```ts
{
  pages: DocPage[];
  folders: DocFolder[];
  activePageId: string | null;
}
```

Шаблоны — это обычные страницы с `isTemplate: true` и массивом `templateVariables`.
Клиент подставляет значения в плейсхолдеры вида `{{variableName}}` и создаёт новую страницу.

## Структура проекта

```
src/
├── components/        # React-компоненты (Sidebar, MarkdownEditor, MarkdownPreview, EditorPage)
├── api/               # Клиентские вызовы API
├── data/              # Встроенный стартовый набор документов и шаблонов
├── store/             # Zustand-стор (useDocStore)
├── types/             # TypeScript-типы
├── utils/             # Утилиты экспорта (HTML, DOCX, XLSX)
├── App.tsx            # Корневой компонент
└── main.tsx           # Точка входа

server/
├── index.js           # Express API
├── defaultDocs.js     # Стартовый серверный набор документов
└── api.test.js        # Базовые API-тесты
```

## CI

В `.github/workflows/ci.yml` настроен GitHub Actions workflow для `npm ci`, `npm run lint` и `npm run build`.
