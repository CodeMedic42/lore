export interface CalendarDayProps {
  date: Date
  selected?: boolean
  inRange?: boolean
  onSelect: (date: Date) => void
}

const CalendarDay = ({ date, selected, inRange, onSelect }: CalendarDayProps) => (
  <button
    type="button"
    className={`uk-day${selected ? ' uk-day--selected' : ''}${inRange ? ' uk-day--in-range' : ''}`}
    onClick={() => onSelect(date)}
  >
    {date.getDate()}
  </button>
)

export default CalendarDay
