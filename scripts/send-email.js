import { Resend } from 'resend';

// Replace 're_xxxxxxxxx' with your real Resend API key or set RESEND_API_KEY environment variable.
const apiKey = process.env.RESEND_API_KEY || 're_xxxxxxxxx';
const resend = new Resend(apiKey);

async function sendEmail() {
  try {
    const data = await resend.emails.send({
      from: 'onboarding@zeyksbook.app',
      to: 'zeyksbook@gmail.com',
      subject: 'Hello World',
      html: '<p>Congrats on sending your <strong>first email</strong>!</p>'
    });
    console.log('Email sent successfully:', data);
  } catch (error) {
    console.error('Failed to send email:', error);
  }
}

sendEmail();
