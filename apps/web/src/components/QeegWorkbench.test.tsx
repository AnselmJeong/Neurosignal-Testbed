import { describe, expect, it } from 'vitest'

import { parseIcaExclusions } from './ImportedQeegWorkbench'

describe('parseIcaExclusions', () => {
  it('keeps an empty field empty so the first ICA fit excludes nothing', () => {
    expect(parseIcaExclusions('')).toEqual([])
    expect(parseIcaExclusions('  ')).toEqual([])
  })

  it('accepts only non-negative integer component indices', () => {
    expect(parseIcaExclusions('0, 3, -1, 2.5, nope')).toEqual([0, 3])
  })
})
