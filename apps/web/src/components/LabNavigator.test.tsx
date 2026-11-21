// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, within } from '@testing-library/react'
import { FlaskConical, ScanSearch } from 'lucide-react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LabNavigator } from './LabNavigator'

const steps = [
  { label: 'Generate', description: 'Create sensor EEG with a known blink.', icon: FlaskConical },
  { label: 'Inspect EEG', description: 'Find where the blink appears in the sensors.', icon: ScanSearch },
]

afterEach(cleanup)

describe('LabNavigator lesson progress', () => {
  it('explains each non-interactive step and identifies the current one', () => {
    render(<LabNavigator activeLab="ica" onLabChange={vi.fn()} steps={steps} step={1} />)

    const progress = screen.getByRole('list', { name: 'ICA 학습 진행' })

    expect(within(progress).queryByRole('button')).not.toBeInTheDocument()
    expect(within(progress).getByText('Create sensor EEG with a known blink.')).toBeVisible()
    expect(within(progress).getByText('Find where the blink appears in the sensors.')).toBeVisible()
    expect(within(progress).getByText('01 · 완료')).toBeVisible()
    expect(within(progress).getByText('02 · 현재 단계')).toBeVisible()
    expect(screen.getByText('2단계 중 2')).toBeVisible()
  })
})

describe('LabNavigator labs', () => {
  it('lists JR Benchmark as lab 07 and switches to it', () => {
    const onLabChange = vi.fn()
    render(<LabNavigator activeLab="filter" onLabChange={onLabChange} steps={steps} step={0} />)

    const labs = within(screen.getByRole('region', { name: 'Lab 목록' })).getAllByRole('button').filter((button) => !button.classList.contains('lab-start-button') && button.title !== 'Lab 준비 · Phase primer')
    expect(labs[6]).toHaveTextContent('07JR 벤치마크')
    labs[6]!.click()
    expect(onLabChange).toHaveBeenCalledWith('benchmark')
  })

  it('lists eight labs with Information Flow last and switches to it', () => {
    const onLabChange = vi.fn()
    render(<LabNavigator activeLab="filter" onLabChange={onLabChange} steps={steps} step={0} />)

    const labs = within(screen.getByRole('region', { name: 'Lab 목록' })).getAllByRole('button').filter((button) => !button.classList.contains('lab-start-button') && button.title !== 'Lab 준비 · Phase primer')
    expect(labs).toHaveLength(8)
    expect(labs[7]).toHaveTextContent('08정보 흐름')
    labs[7]!.click()
    expect(onLabChange).toHaveBeenCalledWith('flow')
  })

  it('offers the phase primer between Lab 02 and Lab 03', () => {
    const onLabChange = vi.fn()
    render(<LabNavigator activeLab="filter" onLabChange={onLabChange} steps={steps} step={0} />)
    const buttons = within(screen.getByRole('region', { name: 'Lab 목록' })).getAllByRole('button')
    const primer = screen.getByTitle('Lab 준비 · Phase primer')
    expect(buttons.indexOf(primer)).toBe(3)
    primer.click()
    expect(onLabChange).toHaveBeenCalledWith('phase')
  })
})
