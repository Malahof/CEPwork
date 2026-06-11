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

function makeSnapshot(id, title, content = `# ${title}`) {
  return {
    pages: [
      {
        id,
        title,
        content,
        parentId: null,
        order: 0,
        createdAt: 1,
        updatedAt: Date.now(),
      },
    ],
    folders: [],
    activePageId: id,
  };
}

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

test('docs versioning lists, reads, restores, and prunes snapshots', async () => {
  const firstSnapshot = makeSnapshot('version-first', 'Первая версия', '# Первая версия');
  const secondSnapshot = makeSnapshot('version-second', 'Вторая версия', '# Вторая версия');

  const firstSave = await fetch(`${baseUrl}/api/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(firstSnapshot),
  });
  assert.equal(firstSave.status, 200);

  const secondSave = await fetch(`${baseUrl}/api/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(secondSnapshot),
  });
  assert.equal(secondSave.status, 200);

  const versionsResponse = await fetch(`${baseUrl}/api/docs/versions`);
  assert.equal(versionsResponse.status, 200);
  const versions = await versionsResponse.json();
  assert.ok(versions.length >= 2);
  assert.ok(versions.every((version) => /^\d+_\d+$/.test(version.versionId)));
  assert.ok(versions.every((version) => Number.isFinite(version.timestamp)));
  assert.ok(versions.every((version) => version.fileSize > 0));

  let firstVersionId = '';
  for (const version of versions) {
    const versionResponse = await fetch(`${baseUrl}/api/docs/versions/${version.versionId}`);
    assert.equal(versionResponse.status, 200);
    const snapshot = await versionResponse.json();
    if (snapshot.pages[0]?.id === 'version-first') {
      firstVersionId = version.versionId;
      break;
    }
  }
  assert.ok(firstVersionId);

  const restoreResponse = await fetch(`${baseUrl}/api/docs/restore/${firstVersionId}`, {
    method: 'POST',
  });
  assert.equal(restoreResponse.status, 200);
  const restored = await restoreResponse.json();
  assert.equal(restored.pages[0].title, 'Первая версия');

  const currentResponse = await fetch(`${baseUrl}/api/docs`);
  assert.equal(currentResponse.status, 200);
  const current = await currentResponse.json();
  assert.equal(current.pages[0].id, 'version-first');

  const versionsAfterRestoreResponse = await fetch(`${baseUrl}/api/docs/versions`);
  assert.equal(versionsAfterRestoreResponse.status, 200);
  const versionsAfterRestore = await versionsAfterRestoreResponse.json();
  let savedPreRestoreState = false;
  for (const version of versionsAfterRestore) {
    const versionResponse = await fetch(`${baseUrl}/api/docs/versions/${version.versionId}`);
    const snapshot = await versionResponse.json();
    savedPreRestoreState ||= snapshot.pages[0]?.id === 'version-second';
  }
  assert.equal(savedPreRestoreState, true);

  const invalidVersionResponse = await fetch(`${baseUrl}/api/docs/versions/not-a-version`);
  assert.equal(invalidVersionResponse.status, 400);
  assert.deepEqual(await invalidVersionResponse.json(), { error: 'Invalid versionId' });

  for (let index = 0; index < 55; index += 1) {
    const saveResponse = await fetch(`${baseUrl}/api/docs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeSnapshot(`prune-${index}`, `Версия ${index}`)),
    });
    assert.equal(saveResponse.status, 200);
  }

  const prunedVersionsResponse = await fetch(`${baseUrl}/api/docs/versions`);
  assert.equal(prunedVersionsResponse.status, 200);
  const prunedVersions = await prunedVersionsResponse.json();
  assert.equal(prunedVersions.length, 50);
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
