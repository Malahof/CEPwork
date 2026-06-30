import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import JSZip from 'jszip';
import {
  buildAppendixRows,
  createDocxFromTemplate,
  generate,
  getCode112Options,
  parseCommission,
  parseManualInput,
  parseWasteRows,
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

test('code112 creates a DOCX file from a template descriptor', async () => {
  const outputPath = path.join(tempDir, 'title.docx');
  await createDocxFromTemplate(path.resolve('templates/docx/code112/title-act.json'), {
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
});

test('code112 accepts manual source fields from the menu', async () => {
  const project = {
    id: 'code112-menu-source',
    extractedData: {},
    history: [],
  };

  await generate(project, { now: 1, outputDir: tempDir });
  await generate(project, {
    answer: 'Комиссия: председатель Сидоров С.С.; инженер Иванов И.И.; эколог Петров П.П.',
    now: 2,
    outputDir: tempDir,
  });

  assert.equal(
    project.extractedData.code112.data.Комиссия,
    'председатель Сидоров С.С.; инженер Иванов И.И.; эколог Петров П.П.'
  );
  assert.match(project.history.at(-2).text, /Данные сохранены для акта инвентаризации/);
  assert.doesNotMatch(project.history.at(-2).text, /не нашёл такой пункт/);
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

  await generate(project, { now: 1, outputDir: tempDir, memory });
  await generate(project, {
    answer: 'Название организации: ООО Ромашка',
    now: 2,
    outputDir: tempDir,
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

  await generate(project, { now: 1, outputDir: tempDir, memory });
  await generate(project, {
    answer: [
      'Название организации: ООО Дата',
      'Дата акта: 25 апреля 2026',
      'Дата начала: 2026-04-24',
    ].join('\n'),
    now: 2,
    outputDir: tempDir,
    memory,
  });
  await generate(project, { answer: 'Сгенерировать все', now: 3, outputDir: tempDir, memory });

  const xml = await readDocxDocumentXml(project.extractedData.code112.files.titleAct.path);
  assert.match(xml, /25\.04\.2026/);
  assert.match(xml, /24\.04\.2026/);
  assert.match(xml, /А\.А\. Альфов/);
  assert.match(xml, /Б\.Б\. Бетов/);
  assert.equal(countOccurrences(xml, 'А.А. Альфов') + countOccurrences(xml, 'Б.Б. Бетов'), 2);
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
