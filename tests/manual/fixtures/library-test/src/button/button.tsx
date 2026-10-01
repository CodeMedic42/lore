/** Standard action button. Use `variant="primary"` for the single main action on a screen. */
const Button = ({ label, onClick, variant = 'secondary' }: ButtonProps) => (
  <button className={`uk-button uk-button--${variant}`} onClick={onClick} type="button">
    {label}
  </button>
)

export interface ButtonProps {
  label: string
  onClick: () => void
  variant?: 'primary' | 'secondary' | 'danger'
}

export default Button
