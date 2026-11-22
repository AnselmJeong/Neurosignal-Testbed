// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { artifactClip, ARTIFACTS } from '../lessons/games'
import { ArtifactGame, PracticeGames, Sandbox } from './PracticeGames'

afterEach(cleanup)

describe('PracticeGames', () => {
  it('shows today’s question with the date', () => {
    render(<PracticeGames activeLab="practice" onLabChange={vi.fn()} today={new Date(2026, 10, 22)} />)
    expect(screen.getByText(/2026년 11월 22일의 문제/)).toBeInTheDocument()
    expect(screen.getByText('문제 #20261122')).toBeInTheDocument()
  })

  it('opens clues one at a time and scores an early right answer higher', () => {
    const onScore = vi.fn()
    render(<ArtifactGame seed={7} onScore={onScore} />)
    expect(screen.queryByText('2 · 파형 전체')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /다음 단서 열기/ }))
    expect(screen.getByText('2 · 파형 전체')).toBeInTheDocument()
    const kind = artifactClip(7).kind
    fireEvent.click(screen.getByRole('button', { name: new RegExp(ARTIFACTS[kind].label) }))
    expect(onScore).toHaveBeenCalledWith(3)
    expect(screen.getByText('맞았습니다.')).toBeInTheDocument()
    expect(screen.getByText('4 · 아티팩트 크기 지형도')).toBeInTheDocument()
  })

  it('raises the sandbox score when the right filters are applied', () => {
    render(<Sandbox />)
    const score = () => Number(screen.getByText(/점$/, { selector: '.practice-score' }).textContent!.replace('점', ''))
    const before = score()
    fireEvent.change(screen.getByLabelText('High-pass cutoff'), { target: { value: '1' } })
    fireEvent.click(screen.getByLabelText('60 Hz notch'))
    fireEvent.change(screen.getByLabelText('Low-pass cutoff'), { target: { value: '30' } })
    expect(score()).toBeGreaterThan(before + 30)
  })
})
