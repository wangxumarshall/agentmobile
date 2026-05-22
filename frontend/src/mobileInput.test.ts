import assert from 'node:assert/strict'
import { mapSpecialKey, shouldSkipInput, stripMobileInputArtifacts } from './mobileInput'

assert.equal(mapSpecialKey('Enter'), '\r')
assert.equal(mapSpecialKey('ArrowLeft'), '\x1b[D')
assert.equal(mapSpecialKey('c', true), '\x03')
assert.equal(mapSpecialKey('a'), null)

assert.equal(stripMobileInputArtifacts('n\u200b你\ufeff'), 'n你')
assert.equal(stripMobileInputArtifacts('\u2060abc'), 'abc')

assert.equal(shouldSkipInput({ nativeEvent: { isComposing: true } }, false), true)
assert.equal(shouldSkipInput({ nativeEvent: { inputType: 'insertCompositionText' } }, false), true)
assert.equal(shouldSkipInput({ nativeEvent: { inputType: 'insertText' } }, true), true)
assert.equal(shouldSkipInput({ nativeEvent: { inputType: 'insertText' } }, false), false)

console.log('mobileInput tests passed')
