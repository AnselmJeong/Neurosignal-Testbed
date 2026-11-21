// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { AboutExperience, APP_VERSION } from './AboutDialog'

afterEach(cleanup)

describe('AboutExperience', () => {
  it('opens the About dialog with the release version and developer credit', () => {
    render(<AboutExperience />)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'NeuroSignal 정보' }))

    expect(screen.getByRole('dialog', { name: '신호를 탐구하고, 모든 결과를 의심하라.' })).toBeVisible()
    expect(screen.getByText(APP_VERSION)).toHaveTextContent('0.2.5')
    expect(screen.getByText('Anselm Jeong')).toBeVisible()
    expect(screen.getByRole('button', { name: '정보 창 닫기' })).toHaveFocus()
  })

  it('closes the About dialog when Escape is pressed', () => {
    render(<AboutExperience />)
    fireEvent.click(screen.getByRole('button', { name: 'NeuroSignal 정보' }))

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
