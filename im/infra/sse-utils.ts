/**
 * SSE (Server-Sent Events) utilities for the IM bridge.
 *
 * Encodes structured SSE events into the canonical format expected
 * by the conversation engine and channel adapters.
 */

export interface CanonicalTurnEvent<TType extends string> {
  type: TType;
  data?: Record<string, unknown>;
  text?: string;
}

export type SSEEventType =
  | 'text'
  | 'text_segment'
  | 'tool_use'
  | 'tool_result'
  | 'permission_request'
  | 'approval_request'
  | 'structured_input_request'
  | 'plan_state'
  | 'plan_delta'
  | 'plan_result'
  | 'activity_event'
  | 'status'
  | 'result'
  | 'error'
  | 'mode_changed'
  | 'server_request_resolved'
  | 'server_request_ignored'
  | 'turn_interrupted'
  | 'prompt_interrupted';

/**
 * Encode a canonical turn event into SSE data format.
 */
export function encodeCanonicalTurnEvent(
  event: CanonicalTurnEvent<SSEEventType>,
): string {
  const payload = {
    type: event.type,
    ...(event.data !== undefined ? { data: event.data } : {}),
    ...(event.text !== undefined ? { text: event.text } : {}),
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Emit a canonical turn event to a ReadableStream controller.
 */
export function emitCanonicalTurnEvent(
  controller: ReadableStreamDefaultController<string>,
  event: CanonicalTurnEvent<SSEEventType>,
): void {
  controller.enqueue(encodeCanonicalTurnEvent(event));
}

/**
 * Shorthand for creating a canonical SSE event.
 */
export function sseEvent<TType extends SSEEventType>(
  type: TType,
  data?: Record<string, unknown>,
  text?: string,
): CanonicalTurnEvent<TType> {
  return { type, data, text };
}
