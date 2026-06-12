const imageStubMessage = 'Изображения пока не поддерживаются, введите данные вручную';

export async function parseImage(filePath) {
  if (process.env.AGENT_ENABLE_OCR !== 'true') return imageStubMessage;

  try {
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker('rus+eng');
    const result = await worker.recognize(filePath);
    await worker.terminate();
    return result.data.text.trim();
  } catch {
    return '';
  }
}
