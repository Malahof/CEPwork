---
name: testing-cepwork-code112
description: Test CEPwork Цэпик code112 inventory-act flows end-to-end. Use when verifying editable project pages, preview substitution, or DOCX generation.
---

# CEPwork code112 testing

## Devin Secrets Needed

- None for local CEPwork code112 testing. The local app requires no login or external API keys for the deterministic code112 flow.

## Local setup

1. Run the app with isolated persistence so browser tests do not modify repository `data/` files:
   ```bash
   mkdir -p /home/ubuntu/cepwork-e2e-data/agent-docs
   DOCS_DATA_PATH="/home/ubuntu/cepwork-e2e-data/docs.json" \
   AGENT_PROJECTS_PATH="/home/ubuntu/cepwork-e2e-data/eco_projects.json" \
   AGENT_OUTPUT_DIR="/home/ubuntu/cepwork-e2e-data/agent-docs" \
   USER_MEMORY_PATH="/home/ubuntu/cepwork-e2e-data/user_memory.json" \
   npm run dev
   ```
2. Open `http://localhost:5173/`. The API runs on `http://localhost:3001`.
3. If Cyrillic text input is unreliable via browser automation, place each one-line message into the X clipboard and paste it into the visible chat input:
   ```bash
   printf '%s' 'Название организации: ООО Ромашка' | xclip -selection clipboard
   ```

## Primary browser flow

1. Start from a clean app state and verify Цэпик input plus paperclip are visible before any project exists.
2. Click `Новый проект` → `Отходы` → `Разработка` → `Акт инвентаризации`.
3. Open `В разработке/<project>/Акт инвентаризации/Приложение к акту инвентаризации`.
4. Verify five project pages exist and are editable, not read-only templates.
5. Send project facts as separate one-line chat messages, pressing Enter after each:
   - `Название организации: ООО Ромашка`
   - `Дата акта: 21.06.2026`
   - `Отход: 9120400;Отходы производства, подобные коммунальным;4;0,054;т;захоронение;Офис;смешанное`
6. Verify preview substitutes organization/date/waste values while the editor can still preserve raw placeholders.
7. Manually edit the appendix organization line and verify preview updates immediately.
8. Send `Заполни метки для Приложения`; it should reuse existing rows and should not ask for a missing waste row if one was already supplied.
9. Send `Закончить`; verify five DOCX links and active title-page preview.
10. Reload the page. Expect persisted tree/page/generated state and a resumable project card; do not require the whole prior chat transcript to replay verbatim.

## Shell validation

After browser generation, validate persistence and DOCX output:

- `docs.json` contains five code112 project pages with `isTemplate` absent and `templateValues` present.
- `eco_projects.json` stores generated file state, manual organization values, and waste rows.
- Helper/template instruction fields such as `Файл_DOCX`, `Итоги`, and `` `Отход`` should not appear in project data.
- The output directory should contain exactly five `.docx` files for the project, each with a `PK` ZIP signature and no unresolved square-bracket placeholders in `word/*.xml`.
