export interface HelperTextProps {
  text: string
  tone?: 'neutral' | 'error'
}

const HelperText = ({ text, tone = 'neutral' }: HelperTextProps) => (
  <span className={`uk-helper uk-helper--${tone}`}>{text}</span>
)

export default HelperText
