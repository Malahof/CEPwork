import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const tempDir = await mkdtemp(path.join(tmpdir(), 'cepwork-api-'));
process.env.DOCS_DATA_PATH = path.join(tempDir, 'docs.json');
process.env.AGENT_PROJECTS_PATH = path.join(tempDir, 'eco_projects.json');
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

async function startAgentProject() {
  const response = await fetch(`${baseUrl}/api/agent/start`, { method: 'POST' });
  assert.equal(response.status, 200);
  return response.json();
}

async function selectAgentOption(projectId, answer) {
  const response = await fetch(`${baseUrl}/api/agent/select`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, answer }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function completeAgentPath(answers) {
  let project = await startAgentProject();
  for (const answer of answers) {
    project = await selectAgentOption(project.id, answer);
  }
  return project;
}

test('Цэпик starts a project and follows the waste development tree', async () => {
  const started = await startAgentProject();
  assert.equal(started.status, 'selecting');
  assert.equal(started.question, 'Начинаем новый проект. Выберите сферу экологической документации.');
  assert.deepEqual(
    started.availableOptions.map((option) => option.key),
    ['waste', 'emissions', 'complex']
  );
  assert.equal(started.history[0].text, 'Цэпик ожидает ваших указаний для начала работы.');

  const waste = await selectAgentOption(started.id, 'waste');
  assert.equal(waste.currentNode, 'wasteDirection');
  assert.deepEqual(
    waste.availableOptions.map((option) => option.key),
    ['development', 'support']
  );

  const development = await selectAgentOption(started.id, 'development');
  assert.equal(development.currentNode, 'wasteDevelopmentPackage');
  assert.deepEqual(
    development.availableOptions.map((option) => option.key),
    ['instruction', 'inventoryAct', 'disposalPermit', 'simpleWasteSet', 'fullWasteSet']
  );

  const completed = await selectAgentOption(started.id, 'fullWasteSet');
  assert.equal(completed.status, 'package_selected');
  assert.equal(completed.packageCode, '115');
  assert.deepEqual(completed.documents, ['Инструкция', 'Разрешение на захоронение']);
  assert.equal(completed.availableOptions.length, 0);
  assert.match(completed.history.at(-1).text, /код 115/);

  const stateResponse = await fetch(`${baseUrl}/api/agent/state/${started.id}`);
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.packageTitle, 'Полный комплект');

  const projectsResponse = await fetch(`${baseUrl}/api/agent/projects`);
  assert.equal(projectsResponse.status, 200);
  const projects = await projectsResponse.json();
  assert.ok(projects.some((project) => project.id === started.id));
});

test('Цэпик validates answers and maps every package leaf to its code', async () => {
  const started = await startAgentProject();
  const invalidResponse = await fetch(`${baseUrl}/api/agent/select`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: started.id, answer: 'invalid' }),
  });
  assert.equal(invalidResponse.status, 400);
  assert.deepEqual(await invalidResponse.json(), { error: 'Invalid agent answer' });

  const cases = [
    [['waste', 'development', 'instruction'], '111'],
    [['waste', 'development', 'inventoryAct'], '112'],
    [['waste', 'development', 'disposalPermit'], '113'],
    [['waste', 'development', 'simpleWasteSet'], '114'],
    [['waste', 'development', 'fullWasteSet'], '115'],
    [['waste', 'support', 'pod10'], '121'],
    [['waste', 'support', 'pod9Pod10'], '122'],
    [['emissions', 'pod123'], '21'],
    [['emissions', 'pod4'], '22'],
    [['emissions', 'emissionsSet'], '23'],
    [['complex', 'development', 'penInstruction'], '311'],
    [['complex', 'development', 'ecoPassport'], '312'],
    [['complex', 'support', 'complexSupportAccounting'], '32'],
    [['complex', 'support', 'complexSupportAct'], '32'],
    [['complex', 'support', 'complexSupportSchedule'], '32'],
    [['complex', 'support', 'complexSupportAnnualPlan'], '32'],
  ];

  for (const [answers, expectedCode] of cases) {
    const completed = await completeAgentPath(answers);
    assert.equal(completed.status, 'package_selected');
    assert.equal(completed.packageCode, expectedCode);
    assert.ok(completed.documents.length > 0);
  }
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
