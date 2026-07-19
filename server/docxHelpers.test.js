import assert from 'node:assert/strict';
import { test } from 'node:test';
import JSZip from 'jszip';
import { parseDateToFormat, processRepeatingBlocks } from './utils/docxHelpers.js';

test('parseDateToFormat normalizes numeric and Russian text dates', () => {
  assert.equal(parseDateToFormat('25 апреля 2026'), '25.04.2026');
  assert.equal(parseDateToFormat('2026-04-25'), '25.04.2026');
  assert.equal(parseDateToFormat('25/4/26'), '25.04.2026');
  assert.equal(parseDateToFormat('25.04.2026', 'YYYY-MM-DD'), '2026-04-25');
});

test('processRepeatingBlocks resizes DOCX table rows and replaces variables', async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.folder('word').file('document.xml', [
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl>',
    '<w:tr><w:tc><w:p><w:r><w:t>Header</w:t></w:r></w:p></w:tc></w:tr>',
    '<w:tr><w:tc><w:p><w:r><w:t>[строка_отхода][code]</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>[name]</w:t></w:r></w:p></w:tc></w:tr>',
    '</w:tbl></w:body></w:document>',
  ].join(''));
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });

  const processed = await processRepeatingBlocks(buffer, '[строка_отхода]', [
    { code: '111', name: 'Первый отход' },
    { code: '222', name: 'Второй отход' },
  ], { blockType: 'tableRow' });
  const resultZip = await JSZip.loadAsync(processed);
  const xml = await resultZip.file('word/document.xml').async('string');

  assert.match(xml, /111/);
  assert.match(xml, /Первый отход/);
  assert.match(xml, /222/);
  assert.match(xml, /Второй отход/);
  assert.doesNotMatch(xml, /\[строка_отхода\]/);
  assert.equal((xml.match(/<w:tr>/g) ?? []).length, 3);
});
