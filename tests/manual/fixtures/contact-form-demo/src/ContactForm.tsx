import { useState } from 'react'
import TextField from '@reformjs/reactive/fields/text-field'
import SelectField from '@reformjs/reactive/fields/select-field'
import Card from '@reformjs/reactive/arrangement/card'

export interface ContactDetails {
  fullName: string
  email: string
  enquiryType: string
}

/** Customer enquiry form on the marketing site. Submits to /v1/enquiries. */
export const ContactForm = () => {
  const [details, setDetails] = useState<ContactDetails>({
    fullName: '',
    email: '',
    enquiryType: 'general',
  })

  return (
    <Card>
      <TextField
        label="Full name"
        value={details.fullName}
        onChange={(fullName) => setDetails({ ...details, fullName })}
      />
      <TextField
        label="Email"
        value={details.email}
        onChange={(email) => setDetails({ ...details, email })}
      />
      <SelectField
        label="Enquiry type"
        value={details.enquiryType}
        onChange={(enquiryType) => setDetails({ ...details, enquiryType })}
      />
      {/* TODO: customers need to tell us when they are available to be called back */}
    </Card>
  )
}
