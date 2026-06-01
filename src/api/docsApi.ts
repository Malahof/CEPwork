import type { DocsSnapshot } from '../types';

const DOCS_ENDPOINT = '/api/docs';

export async function fetchDocs(): Promise<DocsSnapshot> {
  const response = await fetch(DOCS_ENDPOINT);
  if (!response.ok) {
    throw new Error('Не удалось загрузить документы с сервера');
  }
  return response.json() as Promise<DocsSnapshot>;
}

export async function saveDocs(snapshot: DocsSnapshot): Promise<DocsSnapshot> {
  const response = await fetch(DOCS_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(snapshot),
  });

  if (!response.ok) {
    throw new Error('Не удалось сохранить документы на сервере');
  }

  return response.json() as Promise<DocsSnapshot>;
}
