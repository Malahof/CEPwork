import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const tempDir = await mkdtemp(path.join(tmpdir(), 'cepwork-api-'));
process.env.DOCS_DATA_PATH = path.join(tempDir, 'docs.json');
process.env.OPENAI_API_KEY = '';

const { app } = await import('./index.js');

let server;
let baseUrl;

before(() => {
  server = app.listen(0);
  const address = server.address();
  assert.equal(typeof address, 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await rm(tempDir, { recursive: true, force: true });
});

test('GET /api/docs returns and persists the default snapshot', async () => {
  const response = await fetch(`${baseUrl}/api/docs`);
  assert.equal(response.status, 200);

  const snapshot = await response.json();
  assert.ok(Array.isArray(snapshot.pages));
  assert.ok(Array.isArray(snapshot.folders));
  assert.ok(snapshot.pages.some((page) => page.isTemplate));
  assert.ok(snapshot.folders.some((folder) => folder.id === 'templates'));

  const persisted = JSON.parse(await readFile(process.env.DOCS_DATA_PATH, 'utf8'));
  assert.equal(persisted.activePageId, snapshot.activePageId);
});

test('POST /api/docs stores a Unicode document snapshot', async () => {
  const snapshot = {
    pages: [
      {
        id: 'unicode-page',
        title: 'Тест Юникод 漢字 🚀',
        content: '# Тест Юникод 漢字 🚀',
        parentId: null,
        order: 0,
        createdAt: 1,
        updatedAt: 2,
        isTemplate: true,
        templateVariables: [
          {
            key: 'objectName',
            label: 'Объект',
            placeholder: 'Склад',
            defaultValue: 'Склад №1',
          },
        ],
      },
    ],
    folders: [
      {
        id: 'root',
        title: 'Документы',
        parentId: null,
        order: 0,
        isExpanded: true,
      },
    ],
    activePageId: 'unicode-page',
  };

  const saveResponse = await fetch(`${baseUrl}/api/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(snapshot),
  });
  assert.equal(saveResponse.status, 200);
  assert.deepEqual(await saveResponse.json(), snapshot);

  const loadResponse = await fetch(`${baseUrl}/api/docs`);
  assert.equal(loadResponse.status, 200);
  const loaded = await loadResponse.json();
  assert.equal(loaded.pages[0].title, 'Тест Юникод 漢字 🚀');
  assert.equal(loaded.pages[0].templateVariables[0].defaultValue, 'Склад №1');
});

test('POST /api/docs rejects invalid snapshots', async () => {
  const response = await fetch(`${baseUrl}/api/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pages: 'invalid', folders: [] }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Invalid docs snapshot' });
});

test('POST /api/ai/eco-agent requires OPENAI_API_KEY', async () => {
  const response = await fetch(`${baseUrl}/api/ai/eco-agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentRequest: 'Паспорт отходов',
      sources: 'ФККО и журнал учета отходов',
    }),
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: 'OPENAI_API_KEY не настроен на сервере',
  });
});
