import nodemailer from 'nodemailer';
import type { FastifyBaseLogger } from 'fastify';

export interface Mailer {
  enabled: boolean;
  send(to: string, subject: string, text: string): Promise<void>;
}

/** SMTP_URL like smtps://user:pass@mail.example.com:465. Unset = mail off. */
export function createMailer(smtpUrl: string | null, from: string, log: FastifyBaseLogger): Mailer {
  if (!smtpUrl) return { enabled: false, send: async () => log.warn('SMTP_URL not set: email not sent') };
  const t = nodemailer.createTransport(smtpUrl);
  return {
    enabled: true,
    send: async (to, subject, text) => {
      await t.sendMail({ from, to, subject, text });
    },
  };
}
