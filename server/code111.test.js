import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import JSZip from 'jszip';
import { generate, getCode111Options } from './agent/generators/code111.js';
import { extractLocality, buildOrganizationData } from './agent/organizationParser.js';

const tempDir = await mkdtemp(path.join(tmpdir(), 'cepwork-code111-'));

after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const EMPTY_REFS = { zagotovka: '', utilizationPart1: '', utilizationPart2: '', neutralization: '' };

async function readDocxText(filePath) {
  const zip = await JSZip.loadAsync(await readFile(filePath));
  const xml = await zip.file('word/document.xml').async('string');
  return [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
}

test('organizationParser extracts locality from address', () => {
  assert.equal(
    extractLocality('225373, Республика Беларусь Брестская область Ляховичский район д. Флерьяново пер. Лермонтова 2А'),
    'д. Флерьяново'
  );
  assert.equal(buildOrganizationData({ fullName: 'ООО «Фермент»', legalAddress: 'г. Минск' }).название_организации_полное, 'ООО «Фермент»');
});

test('code111 collects data step by step and generates instruction + statement', async () => {
  const project = {
    id: 'code111-basic',
    packageCode: '111',
    packageTitle: 'Инструкция',
    extractedData: {},
    history: [],
  };
  const docsPath = path.join(tempDir, 'docs-111.json');
  const referencePath = path.join(tempDir, 'waste_reference.json');
  const ctx = { outputDir: tempDir, docsPath, referencePath, referenceTexts: EMPTY_REFS, fetchImpl: async () => { throw new Error('offline'); } };

  // 1. UNP -> fetch fails -> manual
  await generate(project, { ...ctx, now: 1 });
  await generate(project, { ...ctx, answer: '100220725', now: 2 });
  const s = () => project.extractedData.code111;
  assert.equal(s().step, 'orgManual');

  // manual org fields
  const fields = ['ООО «Фермент»', 'ООО «Фермент»', 'г. Минск, ул. Тестовая, 1', '01.02.2020', 'Мингорисполком', 'Производство'];
  for (let i = 0; i < fields.length; i++) {
    await generate(project, { ...ctx, answer: fields[i], now: 10 + i });
  }
  assert.equal(s().data.название_организации_полное, 'ООО «Фермент»');

  // manager
  await generate(project, { ...ctx, answer: 'Директор', now: 20 });
  await generate(project, { ...ctx, answer: 'И.И. Иванов', now: 21 });

  // addresses
  await generate(project, { ...ctx, answer: 'г. Минск, ул. Тестовая, 1\nг. Борисов, ул. Заводская, 5', now: 22 });
  assert.equal(s().addresses.length, 2);

  // conditionals: 4 yes/no questions
  for (let i = 0; i < 4; i++) {
    await generate(project, { ...ctx, answer: i === 0 ? 'да' : 'нет', now: 30 + i });
  }
  assert.equal(s().conditionalBlocks['аренда'], true);
  assert.equal(s().conditionalBlocks['цех'], false);

  // positions: default accepted
  await generate(project, { ...ctx, answer: 'Подходит', now: 40 });

  // wastes
  await generate(project, {
    ...ctx,
    answer: '9120400;Отходы производства, подобные отходам жизнедеятельности;неопасные;твердое\n1140202;Жилки табачного листа;4;твердое',
    now: 41,
  });
  // first waste not in reference -> prompt add
  assert.equal(s().pendingReference?.code, '9120400');
  await generate(project, { ...ctx, answer: 'да', now: 42 });
  await generate(project, { ...ctx, answer: 'Бытовая деятельность;смешанный;0,2', now: 43 });
  // second waste not in reference
  assert.equal(s().pendingReference?.code, '1140202');
  await generate(project, { ...ctx, answer: 'нет', now: 44 });

  // waste details
  await generate(project, {
    ...ctx,
    answer: '9120400;г. Минск, ул. Тестовая, 1;контейнер;0,8 м3\n1140202;г. Борисов, ул. Заводская, 5;площадка;10х10х1 м',
    now: 45,
  });

  // pod10 + report
  await generate(project, { ...ctx, answer: 'да', now: 46 });
  await generate(project, { ...ctx, answer: 'да', now: 47 });
  assert.equal(s().step, 'ready');

  // menu options include generate
  const opts = getCode111Options(project).map((o) => o.key);
  assert.ok(opts.includes('generateDocs'));
  assert.ok(!opts.includes('statement')); // not generated yet

  // generate instruction (without archiving)
  await generate(project, { ...ctx, answer: 'generatedocs', now: 50 });
  assert.deepEqual(getCode111Options(project).map((o) => o.key), ['archive', 'separate', 'cancel']);
  await generate(project, { ...ctx, answer: 'separate', now: 51 });
  assert.equal(s().files.instruction.status, 'ready');
  assert.equal(s().instructionGenerated, true);
  assert.notEqual(project.status, 'completed');

  const text = await readDocxText(s().files.instruction.path);
  assert.match(text, /ООО «Фермент»/);
  assert.match(text, /9120400/);
  assert.match(text, /1140202/);

  // statement flow
  assert.ok(getCode111Options(project).map((o) => o.key).includes('statement'));
  await generate(project, { ...ctx, answer: 'statement', now: 60 });
  await generate(project, { ...ctx, answer: 'Минского областного комитета', now: 61 });
  await generate(project, { ...ctx, answer: 'г. Минск, ул. Офисная, 1', now: 62 });
  await generate(project, { ...ctx, answer: 'пропустить', now: 63 });
  await generate(project, { ...ctx, answer: 'нет', now: 64 });
  await generate(project, { ...ctx, answer: 'да', now: 65 });
  assert.equal(s().files.application.status, 'ready');

  const appText = await readDocxText(s().files.application.path);
  assert.match(appText, /Минского областного комитета/);
  assert.match(appText, /ООО «Фермент»/);
});
