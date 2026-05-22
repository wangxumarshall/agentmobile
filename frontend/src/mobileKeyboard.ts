interface KeyboardViewportMetrics {
  viewportHeight: number
  viewportOffsetTop: number
  windowHeight: number
}

interface KeyboardInsetMetrics extends KeyboardViewportMetrics {
  keyboardVisible: boolean
  layoutBottom: number
  maxInsetRatio?: number
}

interface KeyboardViewportStateMetrics extends KeyboardViewportMetrics {
  inputEnabled: boolean
  layoutBottom: number
  maxInsetRatio?: number
}

interface KeyboardViewportState {
  keyboardVisible: boolean
  keyboardInset: number
  shouldLockInput: boolean
}

const DEFAULT_VISIBLE_RATIO = 0.8
const DEFAULT_VISIBLE_DELTA_PX = 120
const DEFAULT_MAX_INSET_RATIO = 0.6

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isMobileKeyboardVisible({
  viewportHeight,
  viewportOffsetTop,
  windowHeight,
}: KeyboardViewportMetrics): boolean {
  if (!isFiniteNumber(viewportHeight) || !isFiniteNumber(viewportOffsetTop) || !isFiniteNumber(windowHeight) || windowHeight <= 0) {
    return false
  }
  const obscuredHeight = Math.max(0, windowHeight - viewportHeight - viewportOffsetTop)
  return obscuredHeight >= DEFAULT_VISIBLE_DELTA_PX || viewportHeight < windowHeight * DEFAULT_VISIBLE_RATIO
}

export function computeMobileKeyboardInset({
  viewportHeight,
  viewportOffsetTop,
  windowHeight,
  keyboardVisible,
  layoutBottom,
  maxInsetRatio = DEFAULT_MAX_INSET_RATIO,
}: KeyboardInsetMetrics): number {
  if (!keyboardVisible) return 0
  if (!isFiniteNumber(viewportHeight) || !isFiniteNumber(viewportOffsetTop) || !isFiniteNumber(windowHeight) || !isFiniteNumber(layoutBottom)) {
    return 0
  }
  if (windowHeight <= 0 || layoutBottom <= 0) return 0

  const viewportBottom = viewportHeight + viewportOffsetTop
  const overlap = Math.max(0, Math.round(layoutBottom - viewportBottom))
  const maxInset = Math.max(0, Math.round(windowHeight * maxInsetRatio))
  return Math.min(overlap, maxInset)
}

export function resolveMobileKeyboardViewportState({
  viewportHeight,
  viewportOffsetTop,
  windowHeight,
  inputEnabled,
  layoutBottom,
  maxInsetRatio,
}: KeyboardViewportStateMetrics): KeyboardViewportState {
  const keyboardVisible = isMobileKeyboardVisible({
    viewportHeight,
    viewportOffsetTop,
    windowHeight,
  })

  return {
    keyboardVisible,
    keyboardInset: computeMobileKeyboardInset({
      viewportHeight,
      viewportOffsetTop,
      windowHeight,
      keyboardVisible,
      layoutBottom,
      maxInsetRatio,
    }),
    shouldLockInput: !keyboardVisible && !inputEnabled,
  }
}
