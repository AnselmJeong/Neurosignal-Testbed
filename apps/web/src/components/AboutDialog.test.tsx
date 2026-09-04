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
    fireEvent.click(screen.getByRole('button', { name: 'About NeuroSignal' }))

    expect(screen.getByRole('dialog', { name: 'Explore signals. Question every result.' })).toBeVisible()
    expect(screen.getByText(APP_VERSION)).toHaveTextContent('0.2.0')
    expect(screen.getByText('Developed by Anselm Jeong')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Close About dialog' })).toHaveFocus()
  })

  it('closes the About dialog when Escape is pressed', () => {
    render(<AboutExperience />)
    fireEvent.click(screen.getByRole('button', { name: 'About NeuroSignal' }))

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
