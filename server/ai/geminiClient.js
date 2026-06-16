import { GoogleGenerativeAI } from '@google/generative-ai';

const defaultModelName = 'gemini-2.5-flash';
const retryStatusCodes = new Set([429, 503]);

export async function generateWithGemini(prompt, modelName = defaultModelName) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const error = new Error('GEMINI_API_KEY не настроен на сервере');
    error.statusCode = 503;
    error.code = 'missing_gemini_api_key';
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

export async function generateWithGeminiWithRetry(prompt, modelName = defaultModelName, maxRetries = 3) {
  return retryGeminiRequest(() => generateWithGemini(prompt, modelName), maxRetries);
}

export async function retryGeminiRequest(request, maxRetries = 3, wait = delay) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      if (!isRetryableGeminiError(error) || attempt === maxRetries) {
        throw error;
      }

      const waitTime = 2 ** (attempt + 1) * 1000;
      console.log(`Retry ${attempt + 1} after ${waitTime}ms`);
      await wait(waitTime);
    }
  }
}

function isRetryableGeminiError(error) {
  if (error?.code === 'missing_gemini_api_key') {
    return false;
  }

  return retryStatusCodes.has(error?.statusCode ?? error?.status);
}

function delay(waitTime) {
  return new Promise((resolve) => {
    setTimeout(resolve, waitTime);
  });
}
