import { describe, expect, it } from 'bun:test'
import { splitFinalDeliveryText } from './final-delivery'

describe('splitFinalDeliveryText', () => {
  it('keeps short messages intact', () => {
    expect(splitFinalDeliveryText('done')).toEqual(['done'])
  })

  it('splits long messages at readable boundaries', () => {
    const text = `${'a '.repeat(1200)}\n\n${'b '.repeat(1200)}`
    const chunks = splitFinalDeliveryText(text)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(chunk => chunk.length <= 1900)).toBe(true)
    expect(chunks.join(' ')).toContain('a')
    expect(chunks.join(' ')).toContain('b')
  })
})
