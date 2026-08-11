import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveDisposalMethod } from './agent/disposalResolver.js';
import {
  WASTE_EXTRACTION_MODES,
  extractWasteDataFromText,
  normalizeWasteExtractionMode,
} from './agent/wasteDataExtractor.js';

test('waste extractor reads old appendix rows with norms and annual quantities', () => {
  const text = [
    'Код отхода*;Наименование отхода*;Норматив образования;Количество образующихся отходов производства в год;Подлежит использованию;Подлежит захоронению',
    '5350202;Субстанции, полуфабрикаты и остатки фармацевтических препаратов;0,004 т / на 1 т продукции в год;4,8;−;4,8',
    '9120400;Отходы производства, подобные отходам жизнедеятельности населения;0,054 т / на 1 сотрудника в год;14,46;−;14,46',
  ].join('\n');

  const wastes = extractWasteDataFromText(text, WASTE_EXTRACTION_MODES.all);

  assert.equal(wastes.length, 2);
  assert.deepEqual(wastes[0], {
    code: '5350202',
    name: 'Субстанции, полуфабрикаты и остатки фармацевтических препаратов',
    norm: '0,004 т / на 1 т продукции в год',
    quantity: '4,8',
  });
  assert.equal(wastes[1].code, '9120400');
  assert.equal(wastes[1].quantity, '14,46');
});

test('waste extractor supports chat mode labels', () => {
  assert.equal(normalizeWasteExtractionMode('Только коды и наименования'), WASTE_EXTRACTION_MODES.codesNames);
  assert.equal(normalizeWasteExtractionMode('Извлечь все данные'), WASTE_EXTRACTION_MODES.all);
});

test('disposal resolver checks references in priority order and skips own-only utilization', async () => {
  assert.deepEqual(
    await resolveDisposalMethod('1111111', {
      referenceTexts: {
        zagotovka: '1111111 принимается к заготовке',
        utilizationPart1: '',
        utilizationPart2: '',
        neutralization: '',
      },
    }),
    { method: 'заготовка', source: 'minpriroda:zagotovka' }
  );

  assert.deepEqual(
    await resolveDisposalMethod('2222222', {
      referenceTexts: {
        zagotovka: '',
        utilizationPart1: '2222222 использует собственные отходы',
        utilizationPart2: '2222222 принимает отходы сторонних организаций',
        neutralization: '',
      },
    }),
    { method: 'использование', source: 'ecoinfo:utilization:2' }
  );

  assert.deepEqual(
    await resolveDisposalMethod('9120400', {
      referenceTexts: {
        zagotovka: '9120400',
        utilizationPart1: '9120400',
        utilizationPart2: '',
        neutralization: '9120400',
      },
    }),
    { method: null, source: 'manual: 9120400' }
  );
});
