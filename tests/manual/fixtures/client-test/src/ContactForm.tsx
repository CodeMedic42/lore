import { useState } from 'react'
import { Card, TextField, Button } from '@acme/ui-kit'

export interface ContactDetails {
  fullName: string
  email: string
  message: string
}

/** Customer enquiry form on the marketing site. Submits to /v1/enquiries. */
export const ContactForm = () => {
  const [details, setDetails] = useState<ContactDetails>({
    fullName: '',
    email: '',
    message: '',
  })

  return (
    <Card title="Get in touch">
      <TextField
        id="full-name"
        label="Full name"
        value={details.fullName}
        onChange={(fullName) => setDetails({ ...details, fullName })}
      />
      <TextField
        id="email"
        label="Email"
        value={details.email}
        onChange={(email) => setDetails({ ...details, email })}
      />
      <TextField
        id="message"
        label="Message"
        value={details.message}
        onChange={(message) => setDetails({ ...details, message })}
      />
      {/* TODO: customers need to tell us when they are available for a callback */}
      <Button label="Send" onClick={() => {}} variant="primary" />
    </Card>
  )
}
