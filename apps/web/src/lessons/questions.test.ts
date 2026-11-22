import { readFileSync, existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { LABS } from '../components/LabNavigator'
import { SUGGESTED_QUESTIONS } from './questions'
import { LIBRARY } from './library'

const MANUAL = '/mnt/project-files/app-manual/neurosignal-testbed-manual.md'

describe('suggested questions and library', () => {
  it('covers every lab with at least two questions and two readings', () => {
    for (const lab of Object.keys(LABS) as (keyof typeof LABS)[]) {
      expect(SUGGESTED_QUESTIONS[lab].length).toBeGreaterThanOrEqual(2)
      expect(LIBRARY[lab].length).toBeGreaterThanOrEqual(2)
    }
  })

  // The manual lives outside the repository; check the section names against it when it is there.
  it.runIf(existsSync(MANUAL))('points to section headings that exist in the manual', () => {
    const headings = readFileSync(MANUAL, 'utf8').split('\n').filter((line) => line.startsWith('#')).join('\n')
    for (const items of Object.values(SUGGESTED_QUESTIONS)) {
      for (const item of items) {
        const last = item.section.split(' › ').pop()!.replace(/\s*\(.*\)$/, '').split(',')[0]!.trim()
        expect(headings, item.section).toContain(last)
      }
    }
  })
})
