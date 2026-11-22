// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SignalJourney } from './SignalJourney'

afterEach(cleanup)

describe('SignalJourney', () => {
  it('walks seven scenes and links each to its lab', () => {
    const onLabChange = vi.fn()
    render(<SignalJourney activeLab="journey" onLabChange={onLabChange} />)
    expect(screen.getAllByRole('heading', { level: 2 }).filter((heading) => heading.id.startsWith('journey-scene-'))).toHaveLength(7)
    fireEvent.click(screen.getByRole('button', { name: /Lab 02 ICA로 가기/ }))
    expect(onLabChange).toHaveBeenCalledWith('ica')
  })

  it('updates the readouts when a control moves', () => {
    render(<SignalJourney activeLab="journey" onLabChange={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Source frequency'), { target: { value: '20' } })
    expect(screen.getByText(/1초에 20번 · 한 번에 50 ms · 베타/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Lead of A over B'), { target: { value: '-30' } })
    expect(screen.getByText(/봉우리 -30 ms · B가 30 ms 먼저 움직임/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '실제 기록' }))
    expect(screen.getByText('정답 레이어 없음')).toBeInTheDocument()
  })
})
