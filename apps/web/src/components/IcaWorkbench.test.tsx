// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultIcaRecipe } from '../types'
import { IcaWorkbench } from './IcaWorkbench'
import { StackedEegComparison } from './StackedEegBrowser'

const simulateIcaMock = vi.fn()

vi.mock('../lib/api', () => ({
  applyIca: vi.fn(),
  fitIca: vi.fn(),
  simulateIca: (...args: unknown[]) => simulateIcaMock(...args),
}))

describe('IcaWorkbench flow', () => {
  beforeEach(() => {
    simulateIcaMock.mockReset()
    simulateIcaMock.mockResolvedValue({
      run_id: 'ica_input_test',
      state: 'completed',
      recipe: defaultIcaRecipe,
      sensor_trace: {
        x: [0, 0.004, 0.008],
        series: {
          Fp1: [0, 4, 0], Fp2: [0, 3.8, 0], F7: [0, 2, 0], F8: [0, 1.8, 0],
          C3: [0, 1, 0], C4: [0, 0.9, 0], O1: [0, 0.5, 0], O2: [0, 0.4, 0],
        },
        x_unit: 's',
        y_unit: 'µV',
      },
      source_labels: ['alpha', 'theta', 'beta', 'blink'],
      channel_names: ['Fp1', 'Fp2', 'F7', 'F8', 'C3', 'C4', 'O1', 'O2'],
      rank: 7,
      provenance: {},
    })
  })

  it('requires generated EEG before ICA fit and has no duplicate fit action', async () => {
    render(<IcaWorkbench activeLab="ica" onLabChange={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Fit ICA on generated EEG' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: /Fit default decomposition/i })).not.toBeInTheDocument()
    expect(screen.getByText('Start with the EEG you will clean.')).toBeVisible()
    expect(screen.getByText('Follow the signal through four steps.')).toBeVisible()
    expect(screen.queryByText(/NOW/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Generate simulated EEG' }))

    expect(await screen.findByText('Simulated EEG · inspect before ICA')).toBeVisible()
    expect(screen.getByRole('img', { name: 'Eight-channel simulated contaminated EEG browser' })).toBeVisible()
    expect(screen.getByText('8 channels · shared gain')).toBeVisible()
    expect(simulateIcaMock).toHaveBeenCalledWith(defaultIcaRecipe)
    expect(screen.getByRole('button', { name: 'Fit ICA on generated EEG' })).toBeEnabled()
  })

  it('renders every channel in the before and after EEG comparison', () => {
    const channelNames = ['Fp1', 'Fp2', 'F7', 'F8', 'C3', 'C4', 'O1', 'O2']
    const series = Object.fromEntries(channelNames.flatMap((channel) => [
      [`Before · ${channel}`, [0, 2, 0]],
      [`After · ${channel}`, [0, 1, 0]],
    ]))

    render(
      <StackedEegComparison
        x={[0, 0.5, 1]}
        series={series}
        channelNames={channelNames}
        ariaLabel="Eight-channel comparison test"
      />,
    )

    const comparison = screen.getByRole('img', { name: 'Eight-channel comparison test' })
    expect(comparison).toBeVisible()
    channelNames.forEach((channel) => expect(within(comparison).getByText(channel)).toBeVisible())
    expect(screen.getByText('Before · generated EEG')).toBeVisible()
    expect(screen.getByText('After · cleaned EEG')).toBeVisible()
  })
})
