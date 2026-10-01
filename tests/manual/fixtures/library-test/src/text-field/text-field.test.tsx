import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import TextField from './text-field.js'

describe('TextField', () => {
  it('renders its label', () => {
    const { getByText } = render(
      <TextField id="a" label="Full name" value="" onChange={() => {}} />,
    )
    expect(getByText('Full name')).toBeTruthy()
  })
})
