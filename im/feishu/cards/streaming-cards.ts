/**
 * Feishu streaming preview card builders.
 *
 * Build Feishu Card 2.0 JSON structures for real-time streaming previews.
 */

/**
 * Build a streaming card skeleton for Feishu CardKit.
 *
 * This creates a card with `streaming_mode: true` that supports
 * real-time text updates without full card replacement.
 */
export function buildStreamingCardSkeleton(): Record<string, unknown> {
  return {
    config: {
      wide_screen_mode: true,
      streaming_mode: true,
    },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: '⚡️ Streaming...',
      },
    },
    i18n_elements: {
      zh_cn: [
        {
          tag: 'markdown',
          content: '',
          element_id: 'stream_content',
        },
      ],
    },
  };
}

/**
 * Build a finalized (non-streaming) card from accumulated text.
 */
export function buildFinalCard(text: string, title?: string): Record<string, unknown> {
  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: title || '✅ Complete',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: text,
      },
    ],
  };
}

/**
 * Build a status card header.
 */
export function buildStatusHeader(status: 'streaming' | 'complete' | 'error'): Record<string, unknown> {
  const config = {
    streaming: { template: 'blue', content: '⚡️ Streaming...' },
    complete: { template: 'green', content: '✅ Complete' },
    error: { template: 'red', content: '❌ Error' },
  }[status];

  return {
    template: config.template,
    title: {
      tag: 'plain_text',
      content: config.content,
    },
  };
}
