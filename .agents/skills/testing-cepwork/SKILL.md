---
name: testing-cepwork
description: Test the CEPwork DocBuilder/Cepik app locally. Use when verifying DocBuilder UI, Cepik chat flows, or code112 document generation.
---

# Testing CEPwork

## Devin Secrets Needed

None for local development and local end-to-end testing.

## Local app setup

Run the app from the repo root:

```bash
npm run dev
```

This starts:

- Express API on `http://localhost:3001`
- Vite frontend on `http://localhost:5173/`

For isolated tests that should not touch repo data, use explicit persistence paths:

```bash
mkdir -p /home/ubuntu/cepwork-e2e-data/agent-docs
DOCS_DATA_PATH="/home/ubuntu/cepwork-e2e-data/docs.json" \
AGENT_PROJECTS_PATH="/home/ubuntu/cepwork-e2e-data/eco_projects.json" \
AGENT_OUTPUT_DIR="/home/ubuntu/cepwork-e2e-data/agent-docs" \
USER_MEMORY_PATH="/home/ubuntu/cepwork-e2e-data/user_memory.json" \
npm run dev
```

Do not commit isolated test data, screenshots, recordings, or `test-artifacts/`.

## Useful checks

```bash
npm run lint
npm test
npm run build
```

`npm run build` may show a Node/Vite warning if the environment uses Node `20.18.1`; confirm whether it still exits successfully.

## Browser testing tips

- Open `http://localhost:5173/` in the existing Chrome window.
- The app is split into the file tree, editor/preview, and the always-visible Cepik chat panel on the right.
- For code112, the UI path is: `Новый проект` → `Отходы` → `Разработка` → `Акт инвентаризации`.
- If Cyrillic typing via computer automation is unreliable, copy the text to the clipboard with `xclip -selection clipboard` and paste into the chat input with `Ctrl+V`.
- When verifying generated DOCX output, you can confirm a download endpoint returns a DOCX-like ZIP by checking that the first two bytes are `PK`.
