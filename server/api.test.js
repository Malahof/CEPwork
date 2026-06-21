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

const unsupportedDocumentationMessage =
  'Извините, я пока не умею обрабатывать выбранный вами тип документации. Эта функция находится в разработке. Пожалуйста, выберите другой раздел или обратитесь к администратору.';

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

async function captureConsoleLog(callback) {
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => {
    logs.push(args);
  };
  try {
    return { result: await callback(), logs };
  } finally {
    console.log = originalLog;
  }
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

  const { result: unsupported, logs } = await captureConsoleLog(() =>
    selectAgentOption(started.id, 'instruction')
  );
  assert.equal(unsupported.status, 'selecting');
  assert.equal(unsupported.currentNode, 'wasteDevelopmentPackage');
  assert.equal(unsupported.packageCode, undefined);
  assert.deepEqual(
    unsupported.availableOptions.map((option) => option.key),
    ['instruction', 'inventoryAct', 'disposalPermit', 'simpleWasteSet', 'fullWasteSet']
  );
  assert.equal(unsupported.history.at(-1).text, unsupportedDocumentationMessage);
  assert.equal(logs[0][0], '[Цэпик] Запрошена нереализованная ветка');
  assert.deepEqual(logs[0][1], { projectId: started.id, code: '111' });

  const stateResponse = await fetch(`${baseUrl}/api/agent/state/${started.id}`);
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.currentNode, 'wasteDevelopmentPackage');
  assert.equal(state.history.at(-1).text, unsupportedDocumentationMessage);

  const projectsResponse = await fetch(`${baseUrl}/api/agent/projects`);
  assert.equal(projectsResponse.status, 200);
  const projects = await projectsResponse.json();
  assert.ok(projects.some((project) => project.id === started.id));
});

test('POST /api/agent/upload stores extracted text for a project', async () => {
  const started = await startAgentProject();
  const formData = new FormData();
  formData.append('projectId', started.id);
  formData.append('file', new Blob(['Источник по отходам'], { type: 'text/plain' }), 'source.txt');

  const response = await fetch(`${baseUrl}/api/agent/upload`, {
    method: 'POST',
    body: formData,
  });
  assert.equal(response.status, 200);

  const upload = await response.json();
  assert.equal(upload.fileName, 'source.txt');
  assert.equal(upload.charCount, 'Источник по отходам'.length);
  assert.equal(upload.text, 'Источник по отходам');
  assert.match(upload.project.history.at(-1).text, /source\.txt/);
  assert.equal(upload.project.extractedData.uploads[0].text, 'Источник по отходам');
});

test('Цэпик returns a Russian fallback and logs unimplemented package codes', async () => {
  const started = await startAgentProject();
  const invalidTextResponse = await fetch(`${baseUrl}/api/agent/select`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: started.id, answer: 'invalid' }),
  });
  assert.equal(invalidTextResponse.status, 400);
  assert.deepEqual(await invalidTextResponse.json(), {
    error: 'Пожалуйста, выберите один из предложенных вариантов.',
  });

  const { result: unknownCodeResponse, logs: unknownCodeLogs } = await captureConsoleLog(() =>
    selectAgentOption(started.id, '999')
  );
  assert.equal(unknownCodeResponse.history.at(-1).text, unsupportedDocumentationMessage);
  assert.deepEqual(unknownCodeLogs[0][1], { projectId: started.id, code: '999' });

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
    const { result: project, logs } = await captureConsoleLog(() => completeAgentPath(answers));
    assert.equal(project.status, 'selecting');
    assert.equal(project.packageCode, undefined);
    assert.equal(project.history.at(-1).text, unsupportedDocumentationMessage);
    assert.deepEqual(logs.at(-1)[1], { projectId: project.id, code: expectedCode });
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
