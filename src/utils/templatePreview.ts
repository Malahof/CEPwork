export function renderTemplatePreview(content: string, values?: Record<string, string>): string {
  if (!values) return content;
  return content.replace(/\[([^\]]+)\]/g, (match, rawKey: string) => {
    const value = values[rawKey.trim()];
    return value?.trim() ? value : match;
  });
}
