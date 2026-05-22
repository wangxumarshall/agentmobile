import assert from 'node:assert/strict'
import { computeMobileKeyboardInset, isMobileKeyboardVisible, resolveMobileKeyboardViewportState } from './mobileKeyboard'

assert.equal(isMobileKeyboardVisible({
  viewportHeight: 540,
  viewportOffsetTop: 0,
  windowHeight: 900,
}), true)

assert.equal(isMobileKeyboardVisible({
  viewportHeight: 850,
  viewportOffsetTop: 0,
  windowHeight: 900,
}), false)

assert.equal(computeMobileKeyboardInset({
  viewportHeight: 500,
  viewportOffsetTop: 0,
  windowHeight: 900,
  keyboardVisible: false,
  layoutBottom: 900,
}), 0)

assert.equal(computeMobileKeyboardInset({
  viewportHeight: 500,
  viewportOffsetTop: 0,
  windowHeight: 900,
  keyboardVisible: true,
  layoutBottom: 500,
}), 0)

assert.equal(computeMobileKeyboardInset({
  viewportHeight: 500,
  viewportOffsetTop: 0,
  windowHeight: 900,
  keyboardVisible: true,
  layoutBottom: 900,
}), 400)

assert.equal(computeMobileKeyboardInset({
  viewportHeight: 500,
  viewportOffsetTop: 0,
  windowHeight: 900,
  keyboardVisible: true,
  layoutBottom: 1400,
  maxInsetRatio: 0.5,
}), 450)

const transitioningState = resolveMobileKeyboardViewportState({
  viewportHeight: 860,
  viewportOffsetTop: 0,
  windowHeight: 900,
  inputEnabled: true,
  layoutBottom: 900,
})
assert.equal(transitioningState.keyboardVisible, false)
assert.equal(transitioningState.keyboardInset, 0)
assert.equal(transitioningState.shouldLockInput, false)

const idleState = resolveMobileKeyboardViewportState({
  viewportHeight: 860,
  viewportOffsetTop: 0,
  windowHeight: 900,
  inputEnabled: false,
  layoutBottom: 900,
})
assert.equal(idleState.keyboardVisible, false)
assert.equal(idleState.shouldLockInput, true)

console.log('mobileKeyboard tests passed')
