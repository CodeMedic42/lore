import { eachDayOfInterval, endOfMonth, startOfMonth } from 'date-fns'
import CalendarDay from './calendar-day.js'

export interface CalendarProps {
  month: Date
  selected?: Date
  rangeStart?: Date
  rangeEnd?: Date
  onSelect: (date: Date) => void
}

/** Month grid. Purely presentational — it holds no selection state of its own. */
const Calendar = ({ month, selected, rangeStart, rangeEnd, onSelect }: CalendarProps) => {
  const days = eachDayOfInterval({ start: startOfMonth(month), end: endOfMonth(month) })
  return (
    <div className="uk-calendar">
      {days.map((day) => (
        <CalendarDay
          key={day.toISOString()}
          date={day}
          selected={selected?.getTime() === day.getTime()}
          inRange={Boolean(rangeStart && rangeEnd && day >= rangeStart && day <= rangeEnd)}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}

export default Calendar
