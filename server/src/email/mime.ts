import { randomBytes } from 'node:crypto';

const encodeHeader = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`);
const wrap = (b64: string) => b64.replace(/.{1,76}/g, '$&\r\n');
const sanitiseHeader = (v: string) => v.replace(/[\r\n]+/g, ' ');

export interface MimeInput {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  messageId: string;
  headers?: Record<string, string>;
  attachments: { filename: string; contentType: string; content: Buffer }[];
  date?: Date;
}

/**
 * Builds an RFC 5322 message. Used for the downloadable .eml when no mailbox is connected
 * (demonstration mode) and as the archived copy of what was submitted.
 */
export function buildMime(m: MimeInput) {
  const boundary = `cc_${randomBytes(12).toString('hex')}`;
  const lines = [
    `From: ${sanitiseHeader(m.from)}`,
    `To: ${m.to.map(sanitiseHeader).join(', ')}`,
    ...(m.cc.length ? [`Cc: ${m.cc.map(sanitiseHeader).join(', ')}`] : []),
    `Subject: ${encodeHeader(sanitiseHeader(m.subject))}`,
    `Date: ${(m.date ?? new Date()).toUTCString()}`,
    `Message-ID: ${sanitiseHeader(m.messageId)}`,
    'MIME-Version: 1.0',
    ...Object.entries(m.headers ?? {}).map(([k, v]) => `${k.replace(/[^A-Za-z0-9-]/g, '')}: ${sanitiseHeader(v)}`),
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(Buffer.from(m.text, 'utf8').toString('base64')),
  ];
  for (const a of m.attachments) {
    lines.push(
      `--${boundary}`,
      `Content-Type: ${a.contentType}; name="${encodeHeader(a.filename)}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${encodeHeader(a.filename)}"`,
      '',
      wrap(a.content.toString('base64')),
    );
  }
  lines.push(`--${boundary}--`, '');
  return Buffer.from(lines.join('\r\n'), 'utf8');
}
