export function extractJson(text: string) {
  const fenceMatch = text.match(/```json([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    return fenceMatch[1].trim();
  }
  const braceIndex = text.indexOf('{');
  if (braceIndex >= 0) {
    const lastBrace = text.lastIndexOf('}');
    if (lastBrace > braceIndex) {
      return text.slice(braceIndex, lastBrace + 1);
    }
  }
  return text;
}

export function safeJsonParse<T = unknown>(text: string): T {
  const payload = extractJson(text);
  return JSON.parse(payload) as T;
}
