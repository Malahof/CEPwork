import { GoogleGenerativeAI } from '@google/generative-ai';

const defaultModelName = 'gemini-2.0-flash';

export async function generateWithGemini(prompt, modelName = defaultModelName) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const error = new Error('GEMINI_API_KEY не настроен на сервере');
    error.statusCode = 503;
    throw error;
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    if (!text?.trim()) throw new Error('Gemini вернул пустой ответ');
    return text.trim();
  } catch (error) {
    console.error('Gemini API ошибка:', error);
    const wrappedError = new Error(`Gemini API error: ${error.message}`);
    wrappedError.statusCode = error.statusCode ?? error.status;
    wrappedError.code = error.code;
    wrappedError.type = error.type;
    throw wrappedError;
  }
}
