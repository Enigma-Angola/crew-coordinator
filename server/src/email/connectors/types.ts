export interface InboundEmail {
  providerMessageId: string | null;
  internetMessageId: string | null;
  conversationId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: string | null;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  receivedAt: Date;
  attachments: { filename: string; contentType: string; content: Buffer }[];
}

export interface OutboundEmail {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  idempotencyKey: string;
  attachments: { filename: string; contentType: string; content: Buffer }[];
}

/** The provider definitely did not accept the message; it is safe to retry or correct. */
export class SendFailed extends Error {
  constructor(public code: string, public retryable = false, public retryAfterSeconds?: number) {
    super(code);
  }
}

/** The request may or may not have been accepted (timeout, connection reset, 5xx). */
export class SendUncertain extends Error {
  constructor(public code: string) {
    super(code);
  }
}

/** The mailbox authorisation has expired or been revoked; a user must reconnect it. */
export class ReauthorisationRequired extends Error {
  constructor() {
    super('reauthorisation_required');
  }
}

export class ProviderRateLimited extends Error {
  constructor(public retryAfterSeconds: number) {
    super('rate_limited');
  }
}

export interface ConnectorInfo {
  provider: 'microsoft' | 'google';
  available: boolean;
  reason?: string;
}
