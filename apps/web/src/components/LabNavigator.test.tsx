// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import { render, screen, within } from '@testing-library/react'
import { FlaskConical, ScanSearch } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'

import { LabNavigator } from './LabNavigator'

const steps = [
  { label: 'Generate', description: 'Create sensor EEG with a known blink.', icon: FlaskConical },
  { label: 'Inspect EEG', description: 'Find where the blink appears in the sensors.', icon: ScanSearch },
]

describe('LabNavigator lesson progress', () => {
  it('explains each non-interactive step and identifies the current one', () => {
    render(<LabNavigator activeLab="ica" onLabChange={vi.fn()} steps={steps} step={1} />)

    const progress = screen.getByRole('list', { name: 'ICA lesson progress' })

    expect(within(progress).queryByRole('button')).not.toBeInTheDocument()
    expect(within(progress).getByText('Create sensor EEG with a known blink.')).toBeVisible()
    expect(within(progress).getByText('Find where the blink appears in the sensors.')).toBeVisible()
    expect(within(progress).getByText('01 · Completed')).toBeVisible()
    expect(within(progress).getByText('02 · Current step')).toBeVisible()
    expect(screen.getByText('Step 2 of 2')).toBeVisible()
  })
})
