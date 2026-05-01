/**
 * Formatting helpers for Telegram card messages.
 */

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function codeBlock(value: unknown, maxChars = 1200): string {
  return `<pre>${escapeHtml(truncateText(String(value ?? ''), maxChars))}</pre>`;
}

export function inlineCode(value: unknown): string {
  return `<code>${escapeHtml(value)}</code>`;
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, maxChars);
  return text.slice(0, maxChars - 3) + '...';
}
