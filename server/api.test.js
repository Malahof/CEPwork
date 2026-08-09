import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const tempDir = await mkdtemp(path.join(tmpdir(), 'cepwork-api-'));
process.env.DOCS_DATA_PATH = path.join(tempDir, 'docs.json');
process.env.AGENT_PROJECTS_PATH = path.join(tempDir, 'eco_projects.json');
process.env.AGENT_OUTPUT_DIR = path.join(tempDir, 'agent-docs');
process.env.USER_MEMORY_PATH = path.join(tempDir, 'user_memory.json');
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
  assert.ok(snapshot.pages.some((page) => page.id === 'welcome'));
  assert.equal(snapshot.pages.some((page) => page.id === 'template-meeting-notes'), false);
  assert.ok(snapshot.folders.some((folder) => folder.id === 'getting-started' && folder.title === 'Руководство'));
  assert.ok(snapshot.folders.some((folder) => folder.id === 'templates' && folder.title === 'Шаблоны'));
  assert.ok(snapshot.folders.some((folder) => folder.id === 'templates-inventory-act'));
  assert.deepEqual(
    snapshot.pages
      .filter((page) => page.parentId === 'templates-inventory-act')
      .sort((a, b) => a.order - b.order)
      .map((page) => page.title),
    [
      'Титул акта (шаблон)',
      'Приложение к акту (шаблон)',
      'Источники образования отходов (шаблон)',
      'Образование отходов (шаблон)',
      'Перечень мероприятий (шаблон)',
    ]
  );
  assert.ok(snapshot.folders.some((folder) => folder.id === 'in-progress' && folder.title === 'В разработке'));
  assert.ok(snapshot.folders.some((folder) => folder.id === 'archive' && folder.title === 'Архив'));

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
  const savedSnapshot = await saveResponse.json();
  assert.ok(savedSnapshot.pages.some((page) => page.id === 'unicode-page'));
  assert.ok(savedSnapshot.folders.some((folder) => folder.id === 'templates'));

  const loadResponse = await fetch(`${baseUrl}/api/docs`);
  assert.equal(loadResponse.status, 200);
  const loaded = await loadResponse.json();
  const unicodePage = loaded.pages.find((page) => page.id === 'unicode-page');
  assert.equal(unicodePage.title, 'Тест Юникод 漢字 🚀');
  assert.equal(unicodePage.templateVariables[0].defaultValue, 'Склад №1');
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

test('memory API stores preferences, instructions, organizations and deletes instructions', async () => {
  const emptyResponse = await fetch(`${baseUrl}/api/memory`);
  assert.equal(emptyResponse.status, 200);
  const emptyMemory = await emptyResponse.json();
  assert.deepEqual(emptyMemory.savedInstructions, []);
  assert.deepEqual(emptyMemory.organizations, []);
  assert.deepEqual(emptyMemory.userPreferences.coefficients, {});

  const saveResponse = await fetch(`${baseUrl}/api/memory/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: 'при расчёте отходов для торговли использовать коэффициент 0,7',
      userPreferences: {
        dateFormat: 'DD.MM.YYYY',
        fonts: { default: 'Times New Roman' },
        coefficients: { tradeWaste: 0.7 },
      },
    }),
  });
  assert.equal(saveResponse.status, 200);
  const saved = await saveResponse.json();
  assert.equal(saved.instruction.text, 'при расчёте отходов для торговли использовать коэффициент 0,7');
  assert.equal(saved.userPreferences.coefficients.tradeWaste, 0.7);

  const organizationResponse = await fetch(`${baseUrl}/api/memory/organization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'ООО Память',
      director: 'Иванов И.И.',
      address: 'г. Минск, ул. Памяти, 1',
      okved: '47.11',
      typicalWastes: ['Отходы упаковки'],
    }),
  });
  assert.equal(organizationResponse.status, 200);
  const savedOrganization = await organizationResponse.json();
  assert.equal(savedOrganization.organization.name, 'ООО Память');

  const sectionResponse = await fetch(`${baseUrl}/api/memory?section=organizations`);
  assert.equal(sectionResponse.status, 200);
  const organizations = await sectionResponse.json();
  assert.equal(organizations[0].director, 'Иванов И.И.');

  const deleteResponse = await fetch(`${baseUrl}/api/memory/instruction/${saved.instruction.id}`, {
    method: 'DELETE',
  });
  assert.equal(deleteResponse.status, 200);
  const deleted = await deleteResponse.json();
  assert.equal(deleted.instruction.text, 'при расчёте отходов для торговли использовать коэффициент 0,7');
});

test('Цэпик saves memory commands and loads saved instructions in new projects', async () => {
  const started = await startAgentProject();
  const remembered = await selectAgentOption(
    started.id,
    'Запомни: при расчёте отходов для торговли использовать коэффициент 0,7'
  );
  assert.match(remembered.history.at(-1).text, /Запомнил инструкцию/);

  const organization = await selectAgentOption(
    started.id,
    'Запомни организацию: ООО Ромашка, директор Петров П.П., адрес г. Минск, ул. Цветочная, 7'
  );
  assert.match(organization.history.at(-1).text, /Запомнил организацию: ООО Ромашка/);

  const memoryList = await selectAgentOption(started.id, 'Покажи, что ты запомнил');
  assert.match(memoryList.history.at(-1).text, /при расчёте отходов для торговли использовать коэффициент 0,7/);
  assert.match(memoryList.history.at(-1).text, /ООО Ромашка/);

  const newProject = await startAgentProject();
  assert.match(newProject.systemPrompt, /при расчёте отходов для торговли использовать коэффициент 0,7/);
  assert.ok(
    newProject.history.some((message) =>
      message.text.includes('Я загрузил долговременную память') &&
      message.text.includes('при расчёте отходов для торговли использовать коэффициент 0,7')
    )
  );

  const forgottenInstruction = await selectAgentOption(started.id, 'Забудь инструкцию 1');
  assert.match(forgottenInstruction.history.at(-1).text, /Забыл инструкцию/);

  const forgottenOrganization = await selectAgentOption(started.id, 'Забудь организацию ООО Ромашка');
  assert.match(forgottenOrganization.history.at(-1).text, /Забыл организацию: ООО Ромашка/);
});

test('code112 applies saved organization data from memory', async () => {
  const organizationResponse = await fetch(`${baseUrl}/api/memory/organization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'ООО Авто Память',
      director: 'Смирнов С.С.',
      address: 'г. Гродно, ул. Авто, 5',
      okved: '45.20',
      typicalWastes: ['Отработанные фильтры'],
    }),
  });
  assert.equal(organizationResponse.status, 200);

  const project = await completeAgentPath(['waste', 'development', 'inventoryAct']);
  const updated = await selectAgentOption(project.id, 'Название организации: ООО Авто Память');
  assert.ok(updated.history.some((message) => /Найдены сохранённые данные для организации «ООО Авто Память»\. Использовать\?/.test(message.text)));

  const confirmed = await selectAgentOption(project.id, 'Да');
  assert.ok(confirmed.history.some((message) => /Применил сохранённые данные организации «ООО Авто Память»/.test(message.text)));
  assert.equal(confirmed.extractedData.code112.data.Юридический_адрес, 'г. Гродно, ул. Авто, 5');
  assert.equal(confirmed.extractedData.code112.data.Инициалы_фамилия_руководителя, 'Смирнов С.С.');
  assert.equal(confirmed.extractedData.code112.data.ОКВЭД, '45.20');
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

test('код 112 starts the inventory act generator and creates five DOCX files', async () => {
  const started = await startAgentProject();
  await selectAgentOption(started.id, 'waste');
  await selectAgentOption(started.id, 'development');
  const code112 = await selectAgentOption(started.id, 'inventoryAct');

  assert.equal(code112.status, 'package_selected');
  assert.equal(code112.packageCode, '112');
  assert.equal(code112.question, 'Укажите название организации, для которой разрабатывается документация.');
  assert.deepEqual(code112.availableOptions, []);
  assert.match(code112.history.at(-1).text, /Укажите название организации/);

  const prematureTitle = await selectAgentOption(started.id, 'Титул акта');
  assert.equal(prematureTitle.extractedData.code112.awaitingOrganizationName, true);
  assert.match(prematureTitle.history.at(-2).text, /Сначала нужно указать название организации/);

  const withOrganization = await selectAgentOption(started.id, 'ООО Фермент');
  assert.equal(withOrganization.question, 'К чему теперь приступить?');
  assert.deepEqual(
    withOrganization.availableOptions.map((option) => option.key),
    ['titleAct', 'appendix', 'sources', 'wasteFormation', 'measures', 'generateAll', 'pause']
  );
  assert.equal(withOrganization.extractedData.code112.data.Название_организации, 'ООО Фермент');
  assert.match(withOrganization.history.at(-1).text, /С чего хотите начать/);

  const generated = await selectAgentOption(started.id, 'generateAll');
  const files = generated.extractedData.code112.files;
  assert.equal(generated.extractedData.code112.status, 'ready');
  assert.equal(Object.values(files).filter((file) => file.status === 'ready').length, 5);
  assert.match(generated.history.at(-2).text, /Сформированы файлы/);

  const firstFile = files.titleAct;
  const downloadResponse = await fetch(`${baseUrl}${firstFile.downloadUrl}`);
  assert.equal(downloadResponse.status, 200);
  const buffer = Buffer.from(await downloadResponse.arrayBuffer());
  assert.equal(buffer.subarray(0, 2).toString('utf8'), 'PK');

  const { result: unknownCode, logs } = await captureConsoleLog(() => selectAgentOption(started.id, '999'));
  assert.equal(unknownCode.history.at(-2).text, unsupportedDocumentationMessage);
  assert.deepEqual(logs.find((entry) => entry[0] === '[Цэпик] Запрошена нереализованная ветка')[1], { projectId: started.id, code: '999' });
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
