// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MATH_STEPS } from '../lessons/mathSteps'
import { MathSteps } from './MathSteps'

describe('MathSteps', () => {
  afterEach(cleanup)

  it('gives every lab 3–4 named steps with one MathML formula each', () => {
    for (const steps of Object.values(MATH_STEPS)) {
      expect(steps.length).toBeGreaterThanOrEqual(3)
      expect(steps.length).toBeLessThanOrEqual(4)
    }
    const { container } = render(<MathSteps lab="ica" />)
    expect(container.querySelectorAll('math')).toHaveLength(4)
    expect(container.querySelector('math[aria-label="x_clean = x − Σ_{k∈excluded} a_k u_k(t)"]')).not.toBeNull()
    expect(screen.getByText('백색화(Whiten)')).toBeInTheDocument()
  })

  it('links a step to the matching view on the canvas', () => {
    const onClick = vi.fn()
    render(<MathSteps lab="ica" actions={{ rotate: { label: '성분 시계열 보기', onClick }, remove: { label: '처리 전 / 후 보기', onClick, disabled: true } }} />)
    fireEvent.click(screen.getByText(/수식으로 보기/))
    fireEvent.click(screen.getByRole('button', { name: '성분 시계열 보기' }))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '처리 전 / 후 보기' })).toBeDisabled()
  })
})
