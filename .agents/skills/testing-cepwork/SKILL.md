---
name: testing-cepwork
description: Test CEPwork end-to-end locally. Use when verifying document tree, templates, AI agent modes, Express persistence, and export features.
---

# CEPwork Testing

## Devin Secrets Needed

- `OPENAI_API_KEY` — optional. Required only for live OpenAI mode testing. If unavailable, mark live OpenAI generation as untested and verify the Wizard mode plus the OpenAI/Wizard UI toggle.

## Local setup

1. Install dependencies from the repo root:
   ```bash
   npm install
   ```
2. For isolated runtime tests, start the app with a dedicated docs file so prior manual data does not affect assertions:
   ```bash
   DOCS_DATA_PATH=/home/ubuntu/cepwork-pr-test-data/docs.json npm run dev -- --host 0.0.0.0
   ```
3. Open Chrome to `http://localhost:5173/`.

## Browser testing notes

- Use the UI for user-facing actions: create pages, rename pages, open templates, fill dialogs, use the AI panel, and click export buttons.
- Direct GUI typing of Cyrillic/Unicode may be unreliable in the VM. Prefer putting exact text on the system clipboard, then paste into the focused field:
  ```bash
  printf '%s' 'Тест Юникод 漢字 🚀' | xclip -selection clipboard
  ```
- Useful primary flow:
  1. Create a page and rename it to an exact Unicode title such as `Тест Юникод 漢字 🚀`.
  2. Open `Шаблоны` → `Экологический документ`, click `Создать из шаблона`, fill all variables, and assert no `{{...}}` placeholders remain.
  3. Use `Wizard` mode in the AI panel, apply the generated draft, and verify the editor/preview changed.
  4. Click `HTML`, `XLSX`, and `Реестр XLSX` from the preview toolbar.
  5. Reload the browser and verify the created pages/content persisted through the Express API.

## Artifact validation

- Validate XLSX exports with the repo dependency:
  ```bash
  node - <<'NODE'
  const XLSX = require('./node_modules/xlsx');
  const wb = XLSX.readFile('/home/ubuntu/Downloads/Реестр документов.xlsx');
  console.log(wb.SheetNames);
  console.log(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 })[0]);
  NODE
  ```
- For HTML sanitization tests, ReactMarkdown currently escapes raw HTML when `rehypeRaw` is not enabled. A malicious line like `<img src=x onerror=alert(1)>` may appear in exported HTML as escaped text (`&lt;img src=x onerror=alert(1)&gt;`). Treat this as safe only if validation confirms there is no executable raw markup matching `<img ... onerror`.
