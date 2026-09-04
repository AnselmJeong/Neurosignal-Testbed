// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { MixingMatrix } from './MixingMatrix'

describe('MixingMatrix', () => {
  it('selects a sensor row with pointer or keyboard input', () => {
    const onSelectRow = vi.fn()
    render(
      <MixingMatrix
        values={[
          [-0.8, 0.2, 0.1],
          [0.4, 0.7, -0.2],
        ]}
        selectedRow={0}
        onSelectRow={onSelectRow}
      />,
    )

    const secondRow = screen.getByRole('button', { name: 'Show EEG 02 sensor trace' })
    fireEvent.click(secondRow)
    fireEvent.keyDown(secondRow, { key: 'Enter' })

    expect(onSelectRow).toHaveBeenNthCalledWith(1, 1)
    expect(onSelectRow).toHaveBeenNthCalledWith(2, 1)
  })
})
