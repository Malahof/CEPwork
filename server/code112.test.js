import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  buildAppendixRows,
  createDocxFromTemplate,
  generate,
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
