import { memo } from 'react'
import FieldLabel from '../field-label/field-label.js'
import HelperText from '../helper-text/helper-text.js'

export interface TextFieldProps {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  helperText?: string
  invalid?: boolean
  disabled?: boolean
}

/**
 * Single-line text input. The base input primitive — DateSelector and the search
 * field both wrap it rather than reimplementing label and helper-text handling.
 */
const TextField = ({ id, label, value, onChange, helperText, invalid, disabled }: TextFieldProps) => (
  <div className="uk-field">
    <FieldLabel htmlFor={id}>{label}</FieldLabel>
    <input
      id={id}
      className="uk-field__input"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
    {helperText ? <HelperText text={helperText} tone={invalid ? 'error' : 'neutral'} /> : null}
  </div>
)

export default memo(TextField)
