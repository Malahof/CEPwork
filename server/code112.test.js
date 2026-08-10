import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import JSZip from 'jszip';
import {
  buildAppendixRows,
  createDocxFromTemplate,
  enrichWasteListWithHazardClasses,
  extractWasteListFromText,
  generate,
  getCode112Options,
  parseCommission,
  parseManualInput,
  parseWasteRows,
  registerCode112Upload,
  groupWastesByClass,
  sumHazardTotals,
} from './agent/generators/code112.js';

const tempDir = await mkdtemp(path.join(tmpdir(), 'cepwork-code112-'));

after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test('code112 parses manual fields and waste rows', () => {
  const parsed = parseManualInput([
    'Название организации: ООО Ромашка',
    'Дата акта: 21.06.2026',
    'Отход: 3532600;Лампы люминесцентные отработанные;1;12;шт.;обезвреживание;Цех №1;твердое',
  ].join('\n'));

  assert.equal(parsed.fields.Название_организации, 'ООО Ромашка');
  assert.equal(parsed.fields.Дата_акта, '21.06.2026');
  assert.equal(parsed.wastes[0].unit, 'шт.');
  assert.equal(parsed.wastes[0].handling, 'обезвреживание');
});

test('code112 ignores project page helper lines while syncing manual fields', () => {
  const parsed = parseManualInput([
    'Файл DOCX: `templates/docx/inventory_act/appendix_template.docx`',
    'Название организации: ООО Ромашка manual',
    'Дата акта: [дата_акта]',
    '`Отход: код;наименование;класс;количество;единица;способ обращения;источник;физическое состояние`',
    'Итоги: [сумма_кол4], [сумма_кол5], [сумма_кол6]',
  ].join('\n'), { ignoreTemplateInstructions: true });

  assert.deepEqual(parsed.fields, {
    Название_организации: 'ООО Ромашка manual',
  });
  assert.deepEqual(parsed.wastes, []);
});

test('code112 parses manual commission roles and names', () => {
  const members = parseCommission('председатель Сидоров С.С.; инженер Иванов И.И.; эколог Петров П.П.');

  assert.deepEqual(members, [
    { position: 'председатель', name: 'Сидоров С.С.' },
    { position: 'инженер', name: 'Иванов И.И.' },
    { position: 'эколог', name: 'Петров П.П.' },
  ]);
});

test('code112 builds appendix totals for tonnes and pieces', () => {
  const wastes = parseWasteRows([
    '3532600;Лампы люминесцентные отработанные;1;12;шт.;обезвреживание;Цех №1;твердое',
    '9120400;Отходы производства, подобные коммунальным;не указан;0,054;т;захоронение;Офис;смешанное',
  ].join('\n'));

  const hazardOne = sumHazardTotals(wastes.filter((waste) => waste.hazardClass === '1'));
  assert.equal(hazardOne.pieces, 12);
  assert.equal(hazardOne.tonnes, 0);

  const rows = buildAppendixRows(wastes);
  assert.ok(rows.some((row) => row.type === 'total' && row.cells.some((cell) => String(cell).includes('12 шт.'))));
  assert.ok(rows.some((row) => row.cells.includes('0,054 т / на 1 сотрудника в год')));
});

test('code112 extracts uploaded waste rows and groups them by classifier hazard class', async () => {
  const extracted = extractWasteListFromText([
    'Код;Наименование',
    '9120400;Отходы производства, подобные отходам жизнедеятельности населения',
    '1140202;Жилки табачного листа',
  ].join('\n'));
  const enriched = await enrichWasteListWithHazardClasses(extracted, {
    classifierText: [
      '1140202 Жилки табачного листа четвертый класс 020304',
      '9120400 Отходы производства, подобные отходам жизнедеятельности населения неопасные 200199',
    ].join('\n'),
  });
  const grouped = groupWastesByClass(enriched);

  assert.equal(enriched.length, 2);
  assert.equal(grouped[4][0].code, '1140202');
  assert.equal(grouped['non-hazardous'][0].code, '9120400');
});

test('code112 creates a DOCX file from the prepared inventory act template', async () => {
  const outputPath = path.join(tempDir, 'title.docx');
  await createDocxFromTemplate(path.resolve('templates/docx/inventory_act/title_page_template.docx'), {
    organizationName: 'ООО Ромашка',
    legalAddress: 'г. Минск',
    actDate: '21.06.2026',
    startDate: '20.06.2026',
    managerPosition: 'Директор',
    managerName: 'И.И. Иванов',
    chairPosition: 'Главный инженер',
    chairName: 'П.П. Петров',
    commission: [
      { position: 'Эколог', name: 'С.С. Сидоров' },
      { position: 'Мастер', name: 'А.А. Алексеев' },
    ],
    wastes: [],
    appendixRows: [],
  }, outputPath);

  const buffer = await readFile(outputPath);
  assert.equal(buffer.subarray(0, 2).toString('utf8'), 'PK');
  const xml = await readDocxDocumentXml(outputPath);
  assert.match(xml, /УТВЕРЖДАЮ/);
  assert.match(xml, /ООО Ромашка/);
  assert.doesNotMatch(xml, /\[название_организации\]/);
});

test('code112 rejects non-DOCX templates instead of building documents from scratch', async () => {
  await assert.rejects(
    createDocxFromTemplate(path.resolve('templates/docx/code112/title-act.json'), {}, path.join(tempDir, 'legacy.docx')),
    /только DOCX-шаблоны/
  );
});

test('code112 accepts manual source fields from the menu', async () => {
  const project = {
    id: 'code112-menu-source',
    extractedData: {},
    history: [],
  };

  await generate(project, { now: 1, outputDir: tempDir, docsPath: path.join(tempDir, 'menu-source-docs.json') });
  await generate(project, {
    answer: 'ООО Меню',
    now: 2,
    outputDir: tempDir,
    docsPath: path.join(tempDir, 'menu-source-docs.json'),
  });
  await generate(project, {
    answer: 'Комиссия: председатель Сидоров С.С.; инженер Иванов И.И.; эколог Петров П.П.',
    now: 3,
    outputDir: tempDir,
    docsPath: path.join(tempDir, 'menu-source-docs.json'),
  });

  assert.equal(
    project.extractedData.code112.data.Комиссия,
    'председатель Сидоров С.С.; инженер Иванов И.И.; эколог Петров П.П.'
  );
  assert.match(project.history.at(-2).text, /Данные сохранены для акта инвентаризации/);
  assert.doesNotMatch(project.history.at(-2).text, /не нашёл такой пункт/);
});

test('code112 asks for organization before creating editable pages', async () => {
  const project = {
    id: 'code112-organization-first',
    extractedData: {},
    history: [],
  };
  const docsPath = path.join(tempDir, 'organization-first-docs.json');

  await generate(project, { now: 1, outputDir: tempDir, docsPath, memory: null });

  assert.equal(project.extractedData.code112.awaitingOrganizationName, true);
  assert.match(project.history.at(-1).text, /Укажите название организации/);
  assert.deepEqual(getCode112Options(project), []);
  await assert.rejects(readFile(docsPath, 'utf8'), /ENOENT/);

  await generate(project, {
    answer: 'Титул акта',
    now: 2,
    outputDir: tempDir,
    docsPath,
    memory: null,
  });

  assert.equal(project.extractedData.code112.awaitingOrganizationName, true);
  assert.match(project.history.at(-2).text, /Сначала нужно указать название организации/);

  await generate(project, {
    answer: 'ООО Фермент',
    now: 3,
    outputDir: tempDir,
    docsPath,
    memory: null,
  });

  assert.equal(project.extractedData.code112.awaitingOrganizationName, false);
  assert.equal(project.extractedData.code112.data.Название_организации, 'ООО Фермент');
  assert.match(project.history.at(-1).text, /С чего хотите начать/);
  assert.deepEqual(
    getCode112Options(project).map((option) => option.key),
    ['titleAct', 'appendix', 'sources', 'wasteFormation', 'measures', 'generateAll', 'pause'],
  );

  const snapshot = JSON.parse(await readFile(docsPath, 'utf8'));
  const projectFolder = snapshot.folders.find((item) => item.id === 'agent-code112-organization-first');
  assert.equal(projectFolder.title, 'ООО Фермент');
  const workFolder = snapshot.folders.find((item) => item.id === 'agent-code112-organization-first-code112');
  assert.equal(workFolder.parentId, projectFolder.id);
  assert.equal(snapshot.pages.filter((item) => item.parentId === workFolder.id).length, 5);
});

test('code112 extracts organization from inventory act phrase', async () => {
  const project = {
    id: 'code112-organization-phrase',
    extractedData: {},
    history: [],
  };
  const docsPath = path.join(tempDir, 'organization-phrase-docs.json');

  await generate(project, { now: 1, outputDir: tempDir, docsPath, memory: null });
  await generate(project, {
    answer: 'Давай создадим акт инвентаризации для ООО "Фермент"',
    now: 2,
    outputDir: tempDir,
    docsPath,
    memory: null,
  });

  assert.equal(project.extractedData.code112.awaitingOrganizationName, false);
  assert.equal(project.extractedData.code112.data.Название_организации, 'ООО "Фермент"');
  const snapshot = JSON.parse(await readFile(docsPath, 'utf8'));
  assert.equal(
    snapshot.folders.find((item) => item.id === 'agent-code112-organization-phrase').title,
    'ООО "Фермент"',
  );
});

test('code112 fills editable appendix page from uploaded waste list before DOCX generation', async () => {
  const project = {
    id: 'code112-uploaded-wastes',
    packageCode: '112',
    packageTitle: 'Акт инвентаризации',
    extractedData: {},
    history: [],
  };
  const docsPath = path.join(tempDir, 'uploaded-wastes-docs.json');

  await generate(project, { now: 1, outputDir: tempDir, docsPath, memory: null });
  await generate(project, {
    answer: 'ООО Фермент',
    now: 2,
    outputDir: tempDir,
    docsPath,
    memory: null,
  });
  await registerCode112Upload(
    project,
    {
      fileName: 'wastes.csv',
      mimeType: 'text/csv',
      charCount: 122,
      text: [
        'Код;Наименование',
        '9120400;Отходы производства, подобные отходам жизнедеятельности населения',
        '1140202;Жилки табачного листа',
      ].join('\n'),
      uploadedAt: 3,
    },
    {
      now: 3,
      classifierText: [
        '1140202 Жилки табачного листа четвертый класс 020304',
        '9120400 Отходы производства, подобные отходам жизнедеятельности населения неопасные 200199',
      ].join('\n'),
    }
  );

  assert.equal(project.extractedData.code112.pendingWasteExtraction.fileName, 'wastes.csv');

  await generate(project, {
    answer: 'Только коды и наименования',
    now: 4,
    outputDir: tempDir,
    docsPath,
    memory: null,
    classifierText: [
      '1140202 Жилки табачного листа четвертый класс 020304',
      '9120400 Отходы производства, подобные отходам жизнедеятельности населения неопасные 200199',
    ].join('\n'),
    referenceTexts: {
      zagotovka: '',
      utilizationPart1: '',
      utilizationPart2: '',
      neutralization: '',
    },
  });

  assert.equal(project.extractedData.code112.extractedWasteList.length, 2);
  assert.equal(project.extractedData.code112.pendingWasteImport.count, 2);

  await generate(project, {
    answer: 'используй загруженный файл',
    now: 5,
    outputDir: tempDir,
    docsPath,
    memory: null,
  });

  await generate(project, {
    answer: 'захоронение',
    now: 6,
    outputDir: tempDir,
    docsPath,
    memory: null,
  });
  await generate(project, {
    answer: 'захоронение',
    now: 7,
    outputDir: tempDir,
    docsPath,
    memory: null,
  });

  assert.equal(project.extractedData.code112.files.appendix.status, 'in_progress');
  assert.equal(project.extractedData.code112.files.appendix.downloadUrl, null);
  assert.equal(project.extractedData.code112.wastes.length, 2);
  assert.match(project.history.at(-2).text, /Заполнил редактируемые страниц/);

  const snapshot = JSON.parse(await readFile(docsPath, 'utf8'));
  const appendixPage = snapshot.pages.find((item) => item.id === 'agent-code112-uploaded-wastes-code112-appendix');
  assert.match(appendixPage.content, /9120400/);
  assert.match(appendixPage.content, /Неопасные отходы/);
  assert.match(appendixPage.content, /1140202/);
  assert.match(appendixPage.content, /4 класс опасности/);
  assert.doesNotMatch(appendixPage.content, /\[код\]/);
  const sourcesPage = snapshot.pages.find((item) => item.id === 'agent-code112-uploaded-wastes-code112-sources');
  const wasteFormationPage = snapshot.pages.find((item) => item.id === 'agent-code112-uploaded-wastes-code112-wasteFormation');
  assert.match(sourcesPage.content, /1140202/);
  assert.match(sourcesPage.content, /9120400/);
  assert.match(wasteFormationPage.content, /1140202/);
  assert.match(wasteFormationPage.content, /9120400/);
});

test('code112 resumes legacy projects without organization at the organization prompt', async () => {
  const project = {
    id: 'code112-legacy-resume',
    packageTitle: 'Акт инвентаризации',
    extractedData: {
      code112: {
        status: 'in_progress',
        startedAt: 1,
        updatedAt: 1,
        activeDocument: null,
        data: {},
        wastes: [],
        memory: {
          dateFormat: 'DD.MM.YYYY',
          pendingOrganization: null,
          appliedOrganizations: [],
          skippedOrganizations: [],
          defaultMembersApplied: false,
          savedInstructions: [],
          geminiSystemPrompt: '',
        },
        files: {},
      },
    },
    history: [],
  };
  const docsPath = path.join(tempDir, 'legacy-resume-docs.json');

  await generate(project, { answer: '', now: 2, outputDir: tempDir, docsPath, memory: null });

  assert.equal(project.extractedData.code112.awaitingOrganizationName, true);
  assert.match(project.history.at(-1).text, /Укажите название организации/);
  await assert.rejects(readFile(docsPath, 'utf8'), /ENOENT/);
});

test('code112 confirms and applies saved organization data from memory', async () => {
  const project = {
    id: 'code112-memory-organization',
    extractedData: {},
    history: [],
  };
  const memory = {
    userPreferences: {},
    savedInstructions: [{ id: 'i1', text: 'при расчёте отходов использовать коэффициент 0,7', createdAt: 1 }],
    organizations: [
      {
        id: 'org1',
        name: 'ООО Ромашка',
        address: 'г. Минск, ул. Центральная, 1',
        director: 'И.И. Иванов',
        okved: '47.11',
        typicalWastes: ['9120400;Отходы производства, подобные коммунальным;не указан;0,054;т;захоронение;Офис;смешанное'],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };

  await generate(project, { now: 1, outputDir: tempDir, docsPath: path.join(tempDir, 'memory-org-docs.json'), memory });
  await generate(project, {
    answer: 'Название организации: ООО Ромашка',
    now: 2,
    outputDir: tempDir,
    docsPath: path.join(tempDir, 'memory-org-docs.json'),
    memory,
  });

  assert.match(project.history.at(-1).text, /Найдены сохранённые данные для организации «ООО Ромашка»\. Использовать\?/);
  assert.deepEqual(
    getCode112Options(project).map((option) => option.label),
    ['Да', 'Нет'],
  );

  await generate(project, {
    answer: 'Да',
    now: 3,
    outputDir: tempDir,
    docsPath: path.join(tempDir, 'memory-org-docs.json'),
    memory,
  });

  assert.equal(project.extractedData.code112.data.Юридический_адрес, 'г. Минск, ул. Центральная, 1');
  assert.equal(project.extractedData.code112.data.Инициалы_фамилия_руководителя, 'И.И. Иванов');
  assert.equal(project.extractedData.code112.data.ОКВЭД, '47.11');
  assert.ok(project.extractedData.code112.wastes.some((waste) => waste.code === '9120400'));
  assert.match(project.extractedData.code112.memory.geminiSystemPrompt, /коэффициент 0,7/);
});

test('code112 uses default commission members and normalizes dates in DOCX', async () => {
  const project = {
    id: 'code112-memory-members',
    packageTitle: 'Акт инвентаризации',
    extractedData: {},
    history: [],
  };
  const memory = {
    userPreferences: {
      dateFormat: 'DD.MM.YYYY',
      defaultMembers: [
        { position: 'Эколог', name: 'А.А. Альфов' },
        { position: 'Инженер', name: 'Б.Б. Бетов' },
      ],
    },
    organizations: [],
    savedInstructions: [],
  };

  const docsPath = path.join(tempDir, 'memory-members-docs.json');
  await generate(project, { now: 1, outputDir: tempDir, docsPath, memory });
  await generate(project, {
    answer: [
      'Название организации: ООО Дата',
      'Дата акта: 25 апреля 2026',
      'Дата начала: 2026-04-24',
    ].join('\n'),
    now: 2,
    outputDir: tempDir,
    docsPath,
    memory,
  });
  await generate(project, { answer: 'Сгенерировать все', now: 3, outputDir: tempDir, docsPath, memory });

  const xml = await readDocxDocumentXml(project.extractedData.code112.files.titleAct.path);
  assert.match(xml, /25\.04\.2026/);
  assert.match(xml, /24\.04\.2026/);
  assert.match(xml, /А\.А\. Альфов/);
  assert.match(xml, /Б\.Б\. Бетов/);
  assert.equal(countOccurrences(xml, 'А.А. Альфов') + countOccurrences(xml, 'Б.Б. Бетов'), 2);
});

test('code112 adds generated documents to docs tree and activates the title page', async () => {
  const project = {
    id: 'code112-docs-tree',
    packageTitle: 'Акт инвентаризации',
    extractedData: {},
    history: [],
  };
  const docsPath = path.join(tempDir, 'docs-tree.json');

  await generate(project, { now: 1, outputDir: tempDir, docsPath, memory: null });
  assert.equal(project.extractedData.code112.awaitingOrganizationName, true);

  await generate(project, {
    answer: [
      'Название организации: ООО ДокДерево',
      'Дата акта: 25.04.2026',
      'Дата начала: 24.04.2026',
      'Должность руководителя: Директор',
      'Инициалы фамилия руководителя: И.И. Иванов',
      'Юридический адрес: г. Минск',
      'Должность председателя: Главный инженер',
      'Инициалы фамилия председателя: П.П. Петров',
      'Комиссия: эколог С.С. Сидоров; мастер А.А. Алексеев',
      'Отход: 9120400;Отходы производства, подобные коммунальным;4;0,054;т;захоронение;Офис;смешанное',
    ].join('\n'),
    now: 2,
    outputDir: tempDir,
    docsPath,
    memory: null,
  });
  await generate(project, { answer: 'Сгенерировать все', now: 3, outputDir: tempDir, docsPath, memory: null });

  const snapshot = JSON.parse(await readFile(docsPath, 'utf8'));
  const inProgressFolder = snapshot.folders.find((item) => item.id === 'in-progress');
  assert.equal(inProgressFolder.title, 'В разработке');
  const projectFolder = snapshot.folders.find((item) => item.id === 'agent-code112-docs-tree');
  assert.equal(projectFolder.title, 'ООО ДокДерево');
  assert.equal(projectFolder.parentId, 'in-progress');
  const folder = snapshot.folders.find((item) => item.id === 'agent-code112-docs-tree-code112');
  assert.equal(folder.title, 'Акт инвентаризации');
  assert.equal(folder.parentId, projectFolder.id);
  const pages = snapshot.pages.filter((item) => item.parentId === folder.id);
  assert.equal(pages.length, 5);
  assert.equal(snapshot.activePageId, 'agent-code112-docs-tree-code112-titleAct');
  const activePage = pages.find((item) => item.id === snapshot.activePageId);
  assert.match(activePage.content, /\[название_организации\]/);
  assert.equal(activePage.templateValues.название_организации, 'ООО ДокДерево');
  assert.equal(pages.some((page) => page.isTemplate), false);
});

test('code112 renders exactly the entered commission member count', async () => {
  for (const count of [2, 8]) {
    const outputPath = path.join(tempDir, `members-${count}.docx`);
    const members = Array.from({ length: count }, (_, index) => ({
      position: `Должность ${index + 1}`,
      name: `Участник ${index + 1}`,
    }));

    await createDocxFromTemplate(path.resolve('templates/docx/inventory_act/title_page_template.docx'), {
      organizationName: 'ООО Комиссия',
      legalAddress: 'г. Минск',
      actDate: '25.04.2026',
      startDate: '24.04.2026',
      managerPosition: 'Директор',
      managerName: 'И.И. Иванов',
      chairPosition: 'Председатель комиссии',
      chairName: 'П.П. Петров',
      commission: members,
      wastes: [],
      appendixRows: [],
    }, outputPath);

    const xml = await readDocxDocumentXml(outputPath);
    assert.equal(countOccurrences(xml, 'Участник'), count);
    assert.doesNotMatch(xml, /\[должность_члена_комиссии\]|\[инициалы_фамилия_члена_комиссии\]/);
  }
});

async function readDocxDocumentXml(filePath) {
  const zip = await JSZip.loadAsync(await readFile(filePath));
  return zip.file('word/document.xml').async('string');
}

function countOccurrences(text, value) {
  return (text.match(new RegExp(value, 'g')) ?? []).length;
}
