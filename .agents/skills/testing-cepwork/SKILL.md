---
name: testing-cepwork
description: Test CEPwork locally, including the document editor and Цэпик ecological documentation assistant flows.
---

# CEPwork Testing

## Devin Secrets Needed

- None for local document editor and Цэпик Stage A FSM testing.
- `OPENAI_API_KEY` is required only when testing live OpenAI-backed generation via `/api/ai/eco-agent`.

## Local setup

1. Use the repo root: `/home/ubuntu/repos/CEPwork`.
2. Start the app with `npm run dev`.
   - Express API listens on `http://localhost:3001`.
   - Vite client listens on `http://localhost:5173`.
   - If `127.0.0.1:5173` fails, try `localhost:5173`; Vite may bind to IPv6 loopback.
3. For a clean Цэпик FSM test, remove `data/eco_projects.json` before startup or between runs.

## Verification commands

Run these before or after browser testing when validating a code change:

```bash
npm test
npm run lint
npm run build
```

## Browser testing notes

- Open `http://localhost:5173/` in Chrome.
- The right-side panel is the Цэпик assistant when an active document page is selected.
- For Stage A FSM testing, click `Новый проект` and use the rendered choice buttons; do not use API calls in place of the UI.
- A strong persistence check is: complete a package, click `Проекты`, verify the card shows the selected package/code, then reopen it and confirm chat history and summary are restored.
- Browser console should be checked after the flow; empty logs are expected for the basic local flow.

## Recording

- For UI flows, maximize the browser before recording.
- Annotate at least: setup, start of the flow, first-choice assertion, final package-code assertion, and persistence/resume assertion.
