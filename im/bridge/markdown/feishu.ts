/**
 * Feishu Markdown formatting utilities.
 *
 * Converts Markdown text to Feishu Card content format.
 * Feishu supports a subset of Markdown in card elements.
 */

import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
});

/**
 * Build Feishu card markdown content.
 *
 * Feishu card markdown supports:
 * - Bold: **text**
 * - Italic: *text*
 * - Links: [text](url)
 * - Code: `text`
 * - Code blocks: ```language\ncode\n```
 * - Lists: - item or 1. item
 * - Headers: # ## ###
 */
export function buildCardContent(markdown: string): string {
  // Preprocess Markdown for Feishu compatibility
  const processed = preprocessFeishuMarkdown(markdown);
  return processed;
}

/**
 * Build Feishu post content (rich text with multiple elements).
 */
export function buildPostContent(
  title: string,
  sections: Array<{ tag: string; text: string }>,
): Record<string, unknown> {
  const content = {
    zh_cn: {
      title,
      content: sections.map(section => ({
        tag: section.tag,
        text: section.text,
      })),
    },
  };

  return content;
}

/**
 * Preprocess Markdown to ensure Feishu compatibility.
 *
 * - Remove unsupported HTML tags
 * - Normalize line endings
 * - Escape special characters that might break Feishu parser
 */
export function preprocessFeishuMarkdown(markdown: string): string {
  let result = markdown;

  // Normalize line endings
  result = result.replace(/\r\n/g, '\n');

  // Remove unsupported HTML tags (keep safe ones)
  result = result.replace(/<br\s*\/?>/gi, '\n');
  result = result.replace(/<[^>]+>/g, '');

  // Ensure code blocks have proper language markers
  result = result.replace(/```(\s*)\n/g, '```\n');

  // Fix headers (Feishu only supports # ## ###)
  result = result.replace(/^(#{4,6})\s/gm, '### ');

  return result;
}

/**
 * HTML to Feishu Markdown converter.
 */
export function htmlToFeishuMarkdown(html: string): string {
  let result = html;

  // Convert strong/bold
  result = result.replace(/<strong>(.*?)<\/strong>/g, '**$1**');
  result = result.replace(/<b>(.*?)<\/b>/g, '**$1**');

  // Convert em/italic
  result = result.replace(/<em>(.*?)<\/em>/g, '*$1*');
  result = result.replace(/<i>(.*?)<\/i>/g, '*$1*');

  // Convert code
  result = result.replace(/<code>(.*?)<\/code>/g, '`$1`');

  // Convert links
  result = result.replace(/<a\s+href="([^"]*)">(.*?)<\/a>/g, '[$2]($1)');

  // Convert line breaks
  result = result.replace(/<br\s*\/?>/gi, '\n');

  // Convert paragraphs
  result = result.replace(/<p>(.*?)<\/p>/g, '$1\n\n');

  // Convert lists
  result = result.replace(/<li>(.*?)<\/li>/g, '- $1\n');
  result = result.replace(/<\/?(?:ul|ol)>/gi, '');

  // Convert headers
  result = result.replace(/<h1>(.*?)<\/h1>/g, '# $1\n');
  result = result.replace(/<h2>(.*?)<\/h2>/g, '## $1\n');
  result = result.replace(/<h3>(.*?)<\/h3>/g, '### $1\n');

  // Strip remaining HTML
  result = result.replace(/<[^>]+>/g, '');

  // Decode entities
  result = result.replace(/&amp;/g, '&');
  result = result.replace(/&lt;/g, '<');
  result = result.replace(/&gt;/g, '>');
  result = result.replace(/&quot;/g, '"');
  result = result.replace(/&#39;/g, "'");
  result = result.replace(/&nbsp;/g, ' ');

  return result.trim();
}
