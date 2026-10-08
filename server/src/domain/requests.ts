import { z } from 'zod';
import { zonedToUtc } from '../util/time.js';

const dt = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'local_datetime'); // local wall-clock time at the location
const d = z.string().date();
const s = (n = 160) => z.string().trim().max(n);

/** Structured details per request type. Times are local to the request's location_tz. */
export const DETAIL_SCHEMAS = {
  flight: z.object({
    from: s(80).optional(), to: s(80).optional(), airline: s(80).optional(), flight_no: s(12).optional(),
    depart_local: dt.optional(), arrive_local: dt.optional(), arrive_tz: s(60).optional(), cabin: s(30).optional(),
  }),
  hotel: z.object({
    hotel_name: s().optional(), city: s(80).optional(), check_in: d.optional(), check_out: d.optional(), room_type: s(60).optional(), confirmation_no: s(40).optional(),
  }),
  transfer: z.object({
    pickup_local: dt.optional(), pickup_location: s().optional(), dropoff_location: s().optional(), vehicle: s(60).optional(), driver_contact: s(80).optional(),
  }),
  medical: z.object({ appointment_local: dt.optional(), clinic: s().optional(), exam_type: s(80).optional() }),
  training: z.object({ course: s().optional(), location: s().optional(), starts_on: d.optional(), ends_on: d.optional() }),
  immigration: z.object({ document_type: s(80).optional(), destination_country: s(80).optional(), submission_deadline: d.optional() }),
} as const;

export type RequestType = keyof typeof DETAIL_SCHEMAS;
export const REQUEST_TYPES = Object.keys(DETAIL_SCHEMAS) as RequestType[];

/** Detail fields whose change alters the arrangement itself and therefore needs human review. */
export const CRITICAL_FIELDS: Record<RequestType, string[]> = {
  flight: ['depart_local', 'arrive_local', 'flight_no', 'from', 'to'],
  hotel: ['check_in', 'check_out', 'hotel_name'],
  transfer: ['pickup_local', 'pickup_location', 'dropoff_location'],
  medical: ['appointment_local', 'clinic'],
  training: ['starts_on', 'ends_on', 'course', 'location'],
  immigration: ['submission_deadline', 'document_type'],
};

const split = (v: string) => v.split('T') as [string, string];

/** Derives the normalised UTC start/end of a request from its local details. */
export function normaliseTimes(type: RequestType, details: Record<string, any>, tz: string): { starts_at: Date | null; ends_at: Date | null } {
  const at = (v?: string, zone = tz) => (v ? zonedToUtc(...split(v), zone) : null);
  const day = (v?: string, time = '00:00') => (v ? zonedToUtc(v, time, tz) : null);
  switch (type) {
    case 'flight':
      return { starts_at: at(details.depart_local), ends_at: at(details.arrive_local, details.arrive_tz || tz) };
    case 'hotel':
      return { starts_at: day(details.check_in, '14:00'), ends_at: day(details.check_out, '12:00') };
    case 'transfer':
      return { starts_at: at(details.pickup_local), ends_at: null };
    case 'medical':
      return { starts_at: at(details.appointment_local), ends_at: null };
    case 'training':
      return { starts_at: day(details.starts_on, '08:00'), ends_at: day(details.ends_on, '17:00') };
    case 'immigration':
      return { starts_at: day(details.submission_deadline, '17:00'), ends_at: null };
  }
}

/** Fields required before a request can be sent, used when templates do not override them. */
export const DEFAULT_REQUIRED: Record<RequestType, string[]> = {
  flight: ['details.from', 'details.to', 'details.depart_local'],
  hotel: ['details.city', 'details.check_in', 'details.check_out'],
  transfer: ['details.pickup_local', 'details.pickup_location', 'details.dropoff_location'],
  medical: ['details.appointment_local', 'details.exam_type'],
  training: ['details.course', 'details.starts_on'],
  immigration: ['details.document_type', 'details.destination_country'],
};

/** Business status transitions that a person may record directly. */
export const STATUS_FLOW: Record<string, string[]> = {
  draft: ['requested', 'cancelled'],
  requested: ['acknowledged', 'quoted', 'proposed', 'confirmed', 'cancelled'],
  acknowledged: ['quoted', 'proposed', 'confirmed', 'cancelled'],
  quoted: ['proposed', 'confirmed', 'cancelled'],
  proposed: ['confirmed', 'cancelled'],
  change_pending_review: ['confirmed', 'cancelled'],
  confirmed: ['completed', 'cancelled', 'change_pending_review'],
  completed: [],
  cancelled: [],
};
