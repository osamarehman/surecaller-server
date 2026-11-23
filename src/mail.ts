import nodemailer from 'nodemailer';
import type { FastifyBaseLogger } from 'fastify';

export interface Mailer {
  enabled: boolean;
  send(to: string, subject: string, text: string): Promise<void>;
}

const SMTP_TIMEOUT_MS = 10_000;

/** SMTP_URL like smtps://user:pass@mail.example.com:465. Unset = mail off. */
export function createMailer(smtpUrl: string | null, from: string, log: FastifyBaseLogger): Mailer {
  if (!smtpUrl) return { enabled: false, send: async () => log.warn('SMTP_URL not set: email not sent') };
  // POST /v1/email-codes waits on the send: bound the connect, greeting and idle socket instead of
  // nodemailer's defaults (2 min, 30 s, 10 min). Settings in SMTP_URL's query string win.
  const t = nodemailer.createTransport({
    url: smtpUrl,
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });
  return {
    enabled: true,
    send: async (to, subject, text) => {
      await t.sendMail({ from, to, subject, text });
    },
  };
}
