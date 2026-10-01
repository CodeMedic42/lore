import { useState } from 'react'
import { format } from 'date-fns'
import TextField from '../text-field/text-field.js'
import Calendar from '../calendar/calendar.js'

export interface DateSelectorProps {
  id: string
  label: string
  value?: Date
  onChange: (date: Date) => void
  helperText?: string
}

/** Pick a single date. A read-only TextField that opens a Calendar on focus. */
const DateSelector = ({ id, label, value, onChange, helperText }: DateSelectorProps) => {
  const [open, setOpen] = useState(false)
  return (
    <div className="uk-date-selector">
      <TextField
        id={id}
        label={label}
        value={value ? format(value, 'yyyy-MM-dd') : ''}
        onChange={() => setOpen(true)}
        helperText={helperText}
      />
      {open ? (
        <Calendar
          month={value ?? new Date()}
          selected={value}
          onSelect={(date) => {
            onChange(date)
            setOpen(false)
          }}
        />
      ) : null}
    </div>
  )
}

export default DateSelector
