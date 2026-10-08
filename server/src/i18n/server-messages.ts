/**
 * Server-side translations for content that leaves the application: system emails,
 * exports and generated reports. Internal status codes are never translated in storage.
 */
export type Lang = 'pt-PT' | 'en';

type Dict = Record<string, string>;

const en: Dict = {
  'email.invitation.subject': 'Invitation to join {org} on Crew Coordinator',
  'email.invitation.body':
    'Hello,\n\n{inviter} has invited you to join the {org} workspace on Crew Coordinator.\n\nAccept the invitation by signing in with your organisation account:\n{inviteUrl}\n\nThe link expires in 7 days. After you sign in, an administrator must approve your access.\n\nIf you were not expecting this invitation, you can ignore this message.',
  'email.reminder.prefix': 'REMINDER',
  'email.reminder.intro': 'This is a reminder about our request sent on {sentAt}. We have not yet recorded a reply.',
  'email.amendment.prefix': 'AMENDMENT',
  'email.amendment.intro': 'Please note the following changes to our previous request:',
  'email.reference.footer': 'Please keep the reference {ref} in the subject line when replying.',
  'status.draft': 'Draft',
  'status.requested': 'Requested',
  'status.acknowledged': 'Acknowledged',
  'status.quoted': 'Quoted',
  'status.proposed': 'Proposed',
  'status.confirmed': 'Confirmed',
  'status.change_pending_review': 'Change pending review',
  'status.cancelled': 'Cancelled',
  'status.completed': 'Completed',
  'type.flight': 'Flight',
  'type.hotel': 'Hotel',
  'type.transfer': 'Ground transport',
  'type.medical': 'Medical appointment',
  'type.training': 'Training',
  'type.immigration': 'Immigration',
  'export.generated': 'Generated {at} ({tz}) by {user}',
  'export.col.reference': 'Reference',
  'export.col.person': 'Person',
  'export.col.employee_no': 'Employee no.',
  'export.col.type': 'Type',
  'export.col.status': 'Status',
  'export.col.supplier': 'Supplier',
  'export.col.starts_at': 'Start',
  'export.col.ends_at': 'End',
  'export.col.booking_reference': 'Booking reference',
  'export.col.cost': 'Cost',
  'export.col.currency': 'Currency',
  'export.col.crew_change': 'Crew change',
  'export.col.full_name': 'Name',
  'export.col.job_title': 'Job title',
  'export.col.nationality': 'Nationality',
  'export.col.email': 'Email',
  'export.col.phone': 'Phone',
  'export.col.passport_number': 'Passport number',
  'export.col.passport_expiry': 'Passport expiry',
};

const pt: Dict = {
  'email.invitation.subject': 'Convite para aderir a {org} no Crew Coordinator',
  'email.invitation.body':
    'Olá,\n\n{inviter} convidou-o a aderir ao espaço de trabalho {org} no Crew Coordinator.\n\nAceite o convite iniciando sessão com a conta da sua organização:\n{inviteUrl}\n\nA ligação expira dentro de 7 dias. Depois de iniciar sessão, um administrador tem de aprovar o seu acesso.\n\nSe não esperava este convite, pode ignorar esta mensagem.',
  'email.reminder.prefix': 'LEMBRETE',
  'email.reminder.intro': 'Este é um lembrete sobre o nosso pedido enviado em {sentAt}. Ainda não registámos uma resposta.',
  'email.amendment.prefix': 'ALTERAÇÃO',
  'email.amendment.intro': 'Tenha em atenção as seguintes alterações ao nosso pedido anterior:',
  'email.reference.footer': 'Mantenha a referência {ref} no assunto ao responder.',
  'status.draft': 'Rascunho',
  'status.requested': 'Pedido',
  'status.acknowledged': 'Receção confirmada',
  'status.quoted': 'Orçamentado',
  'status.proposed': 'Proposto',
  'status.confirmed': 'Confirmado',
  'status.change_pending_review': 'Alteração por rever',
  'status.cancelled': 'Cancelado',
  'status.completed': 'Concluído',
  'type.flight': 'Voo',
  'type.hotel': 'Hotel',
  'type.transfer': 'Transporte terrestre',
  'type.medical': 'Consulta médica',
  'type.training': 'Formação',
  'type.immigration': 'Imigração',
  'export.generated': 'Gerado em {at} ({tz}) por {user}',
  'export.col.reference': 'Referência',
  'export.col.person': 'Pessoa',
  'export.col.employee_no': 'N.º de colaborador',
  'export.col.type': 'Tipo',
  'export.col.status': 'Estado',
  'export.col.supplier': 'Fornecedor',
  'export.col.starts_at': 'Início',
  'export.col.ends_at': 'Fim',
  'export.col.booking_reference': 'Referência de reserva',
  'export.col.cost': 'Custo',
  'export.col.currency': 'Moeda',
  'export.col.crew_change': 'Troca de tripulação',
  'export.col.full_name': 'Nome',
  'export.col.job_title': 'Função',
  'export.col.nationality': 'Nacionalidade',
  'export.col.email': 'Email',
  'export.col.phone': 'Telefone',
  'export.col.passport_number': 'N.º de passaporte',
  'export.col.passport_expiry': 'Validade do passaporte',
};

export const SERVER_DICTS: Record<Lang, Dict> = { en, 'pt-PT': pt };

export function st(lang: Lang, key: string, params: Record<string, unknown> = {}) {
  const s = SERVER_DICTS[lang]?.[key] ?? SERVER_DICTS.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (params[k] === undefined ? `{${k}}` : String(params[k])));
}

export function renderSystemEmail(kind: 'invitation', lang: Lang, params: Record<string, unknown>) {
  return { language: lang, subject: st(lang, `email.${kind}.subject`, params), body: st(lang, `email.${kind}.body`, params) };
}

export function formatDateTime(value: Date | string | null | undefined, lang: Lang, timeZone: string) {
  if (!value) return '';
  const d = new Date(value);
  return new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(d);
}

export function tzLabel(timeZone: string, lang: Lang, at = new Date()) {
  const part = new Intl.DateTimeFormat(lang, { timeZone, timeZoneName: 'short' }).formatToParts(at).find((p) => p.type === 'timeZoneName');
  return part?.value ?? timeZone;
}
