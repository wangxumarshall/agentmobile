const ZERO_WIDTH_OR_IME_MARKERS = /[\u200b-\u200f\u2060-\u206f\ufeff]/g

export function stripMobileInputArtifacts(value: string): string {
  return value.replace(ZERO_WIDTH_OR_IME_MARKERS, '')
}

export function mapSpecialKey(key: string, ctrlKey = false): string | null {
  if (ctrlKey && key.length === 1) {
    return String.fromCharCode(key.toLowerCase().charCodeAt(0) - 96)
  }

  switch (key) {
    case 'Enter':
      return '\r'
    case 'Backspace':
      return '\x7f'
    case 'Tab':
      return '\t'
    case 'Escape':
      return '\x1b'
    case 'Delete':
      return '\x1b[3~'
    case 'ArrowUp':
      return '\x1b[A'
    case 'ArrowDown':
      return '\x1b[B'
    case 'ArrowRight':
      return '\x1b[C'
    case 'ArrowLeft':
      return '\x1b[D'
    case 'Home':
      return '\x1b[H'
    case 'End':
      return '\x1b[F'
    case 'PageUp':
      return '\x1b[5~'
    case 'PageDown':
      return '\x1b[6~'
    default:
      return null
  }
}

export function shouldSkipInput(event: unknown, isComposing: boolean): boolean {
  if (isComposing) return true
  const nativeEvent = typeof event === 'object' && event !== null && 'nativeEvent' in event
    ? (event as { nativeEvent?: { isComposing?: boolean; inputType?: string } }).nativeEvent
    : undefined
  if (nativeEvent?.isComposing) return true
  const inputType = nativeEvent?.inputType
  return typeof inputType === 'string' && inputType.includes('Composition')
}
