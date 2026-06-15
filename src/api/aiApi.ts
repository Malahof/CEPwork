interface GenerateEcoDocumentRequest {
  documentRequest: string;
  sources: string;
  draft?: string;
  corrections?: string;
}

interface GenerateEcoDocumentResponse {
  draft: string;
}

export async function generateEcoDocument(
  payload: GenerateEcoDocumentRequest
): Promise<GenerateEcoDocumentResponse> {
  const response = await fetch('/api/ai/eco-agent', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const body = (await response.json()) as Partial<GenerateEcoDocumentResponse> & {
    error?: string;
  };

  if (!response.ok || !body.draft) {
    throw new Error(body.error ?? 'Не удалось получить ответ Gemini');
  }

  return { draft: body.draft };
}
