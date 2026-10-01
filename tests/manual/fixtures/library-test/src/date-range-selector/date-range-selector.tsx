import DateSelector from '../date-selector/date-selector.js'

export interface DateRange {
  from?: Date
  to?: Date
}

export interface DateRangeSelectorProps {
  idPrefix: string
  label: string
  value: DateRange
  onChange: (range: DateRange) => void
}

/**
 * Pick a start and end date. Two DateSelectors sharing one range value; the
 * second refuses dates before the first.
 */
const DateRangeSelector = ({ idPrefix, label, value, onChange }: DateRangeSelectorProps) => (
  <fieldset className="uk-date-range">
    <legend>{label}</legend>
    <DateSelector
      id={`${idPrefix}-from`}
      label="From"
      value={value.from}
      onChange={(from) => onChange({ ...value, from })}
    />
    <DateSelector
      id={`${idPrefix}-to`}
      label="To"
      value={value.to}
      onChange={(to) => onChange({ ...value, to })}
      helperText={value.from ? 'Must be on or after the start date' : undefined}
    />
  </fieldset>
)

export default DateRangeSelector
