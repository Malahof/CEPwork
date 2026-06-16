import XLSX from 'xlsx';

export async function parseXlsx(filePath) {
  const workbook = XLSX.readFile(filePath);
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return '';

  const worksheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: '',
    blankrows: false,
  });

  return rows
    .map((row) => row.map((cell) => String(cell).trim()).filter(Boolean).join('\t'))
    .filter(Boolean)
    .join('\n')
    .trim();
}
