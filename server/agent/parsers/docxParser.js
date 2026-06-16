import mammoth from 'mammoth';

export async function parseDocx(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value.trim();
}
