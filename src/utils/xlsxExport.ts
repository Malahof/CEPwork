import * as XLSX from 'xlsx';
import type { DocFolder, DocPage } from '../types';

type Row = string[];

type RegistryRow = {
  type: string;
  title: string;
  path: string;
  parent: string;
  createdAt: string;
  updatedAt: string;
  words: number;
  characters: number;
};

function sanitizeFileName(title: string): string {
  const safeTitle = title
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\p{Cc}]+/gu, '_')
    .trim();

  return safeTitle || 'document';
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(line);
}

function splitTableRow(line: string): Row {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => stripInlineMarkdown(cell));
}

function parseMarkdownTable(lines: string[], startIndex: number): {
  rows: Row[];
  nextIndex: number;
} {
  const rows: Row[] = [splitTableRow(lines[startIndex])];
  let index = startIndex + 2;

  while (index < lines.length && lines[index].trim().includes('|')) {
    rows.push(splitTableRow(lines[index]));
    index += 1;
  }

  return { rows, nextIndex: index };
}

function markdownToRows(markdown: string): Row[] {
  const rows: Row[] = [];
  const lines = markdown.split(/\r?\n/);
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (
      trimmed.includes('|') &&
      index + 1 < lines.length &&
      isTableSeparator(lines[index + 1])
    ) {
      const table = parseMarkdownTable(lines, index);
      rows.push(...table.rows);
      index = table.nextIndex;
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      rows.push([`H${heading[1].length}`, stripInlineMarkdown(heading[2])]);
      index += 1;
      continue;
    }

    const listItem = trimmed.match(/^[-*+]\s+(?:\[[ xX]\]\s+)?(.+)$/);
    if (listItem) {
      rows.push(['•', stripInlineMarkdown(listItem[1])]);
      index += 1;
      continue;
    }

    const orderedListItem = trimmed.match(/^\d+\.\s+(.+)$/);
    if (orderedListItem) {
      rows.push(['1.', stripInlineMarkdown(orderedListItem[1])]);
      index += 1;
      continue;
    }

    const blockquote = trimmed.match(/^>\s?(.+)$/);
    if (blockquote) {
      rows.push(['>', stripInlineMarkdown(blockquote[1])]);
      index += 1;
      continue;
    }

    rows.push([stripInlineMarkdown(trimmed)]);
    index += 1;
  }

  return rows.length ? rows : [['']];
}

function downloadWorkbook(workbook: XLSX.WorkBook, fileName: string): void {
  XLSX.writeFile(workbook, `${sanitizeFileName(fileName)}.xlsx`, {
    bookType: 'xlsx',
    type: 'array',
    compression: true,
  });
}

function fitColumns(sheet: XLSX.WorkSheet, rows: Row[], minWidths: number[]): void {
  const widths = rows.reduce<number[]>((columns, row) => {
    row.forEach((cell, index) => {
      columns[index] = Math.max(columns[index] ?? 0, cell.length, minWidths[index] ?? 10);
    });
    return columns;
  }, []);

  sheet['!cols'] = widths.map((width) => ({ wch: Math.min(Math.max(width + 2, 10), 80) }));
}

export function exportToXlsx(title: string, markdown: string): void {
  const rows = markdownToRows(markdown);
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(rows);

  fitColumns(worksheet, rows, [12, 60]);
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Документ');
  downloadWorkbook(workbook, title);
}

function formatDate(value: number): string {
  return new Date(value).toLocaleString('ru-RU');
}

function wordCount(content: string): number {
  return content.trim().split(/\s+/).filter(Boolean).length;
}

function folderPath(folderId: string | null, folderMap: Map<string, DocFolder>): string[] {
  if (!folderId) return [];

  const folder = folderMap.get(folderId);
  if (!folder) return [];

  return [...folderPath(folder.parentId, folderMap), folder.title];
}

function pagePath(page: DocPage, folderMap: Map<string, DocFolder>): string {
  return [...folderPath(page.parentId, folderMap), page.title].join(' / ');
}

function buildRegistryRows(pages: DocPage[], folders: DocFolder[]): RegistryRow[] {
  const folderMap = new Map(folders.map((folder) => [folder.id, folder]));
  const sortedPages = [...pages].sort((left, right) =>
    pagePath(left, folderMap).localeCompare(pagePath(right, folderMap), 'ru')
  );

  return sortedPages.map((page) => {
    const parentPath = folderPath(page.parentId, folderMap).join(' / ');
    return {
      type: 'Страница',
      title: page.title,
      path: pagePath(page, folderMap),
      parent: parentPath || 'Корень',
      createdAt: formatDate(page.createdAt),
      updatedAt: formatDate(page.updatedAt),
      words: wordCount(page.content),
      characters: page.content.length,
    };
  });
}

export function exportDocumentRegistry(pages: DocPage[], folders: DocFolder[]): void {
  const rows = buildRegistryRows(pages, folders);
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(rows, {
    header: ['type', 'title', 'path', 'parent', 'createdAt', 'updatedAt', 'words', 'characters'],
  });

  XLSX.utils.sheet_add_aoa(
    worksheet,
    [['Тип', 'Название', 'Путь', 'Папка', 'Создано', 'Обновлено', 'Слов', 'Символов']],
    { origin: 'A1' }
  );
  fitColumns(
    worksheet,
    [
      ['Тип', 'Название', 'Путь', 'Папка', 'Создано', 'Обновлено', 'Слов', 'Символов'],
      ...rows.map((row) => [
        row.type,
        row.title,
        row.path,
        row.parent,
        row.createdAt,
        row.updatedAt,
        String(row.words),
        String(row.characters),
      ]),
    ],
    [10, 20, 40, 20, 20, 20, 8, 10]
  );

  XLSX.utils.book_append_sheet(workbook, worksheet, 'Реестр документов');
  downloadWorkbook(workbook, 'Реестр документов');
}
