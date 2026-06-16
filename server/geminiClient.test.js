import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retryGeminiRequest } from './ai/geminiClient.js';

test('retryGeminiRequest retries 429/503 with exponential backoff', async () => {
  const waitTimes = [];
  let calls = 0;

  const result = await retryGeminiRequest(
    async () => {
      calls += 1;
      if (calls < 3) {
        const error = new Error('Gemini high demand');
        error.statusCode = calls === 1 ? 503 : 429;
        throw error;
      }
      return 'draft';
    },
    3,
    async (waitTime) => {
      waitTimes.push(waitTime);
    }
  );

  assert.equal(result, 'draft');
  assert.equal(calls, 3);
  assert.deepEqual(waitTimes, [2000, 4000]);
});

test('retryGeminiRequest does not retry non-retryable Gemini errors', async () => {
  const authError = new Error('Invalid API key');
  authError.statusCode = 401;
  let calls = 0;

  await assert.rejects(
    () =>
      retryGeminiRequest(
        async () => {
          calls += 1;
          throw authError;
        },
        3,
        async () => {
          throw new Error('wait should not be called');
        }
      ),
    /Invalid API key/
  );

  assert.equal(calls, 1);
});
