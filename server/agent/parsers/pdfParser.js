import { readFile } from 'node:fs/promises';
import { PDFParse } from 'pdf-parse';

export async function parsePdf(filePath) {
  const parser = new PDFParse({ data: await readFile(filePath) });

  try {
    const result = await parser.getText();
    return result.text.trim();
  } finally {
    await parser.destroy();
  }
}
