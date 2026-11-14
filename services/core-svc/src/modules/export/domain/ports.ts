// export 저장·원천·재인증 포트. 메모리(단위 시험)와 Drizzle(운영)이 같은 모양을 쓴다.
import type { AttendeeRecord } from '../../shop/index.js';
import type { AttendeeExportRecord, ExportFormat } from './export.js';

export interface AttendeeExportStore {
  insert(record: AttendeeExportRecord): Promise<void>;
  list(promoterId: string, eventId: string, limit: number): Promise<AttendeeExportRecord[]>;
}

export interface AttendeeSource {
  list(promoterId: string, eventId: string, limit: number, cursor?: string): Promise<AttendeeRecord[]>;
  count(promoterId: string, eventId: string): Promise<{ bookings: number; tickets: number }>;
}

export interface PartnerEventLookup {
  /** 소속 파트너의 회차만. 없거나 다른 파트너 회차면 undefined */
  find(promoterId: string, eventId: string): Promise<{ eventId: string; title: string; endsAt: Date } | undefined>;
}

export interface BookersReauth {
  /** 없거나 틀리면 ExportProblem('reauth-required', 403). act는 BOOKER_EXPORT 고정 */
  verify(token: string | undefined, o: { sessionId: string; promoterId: string }): Promise<{ accountId: string; factors: string[] }>;
}

export interface ActorNameResolver {
  displayName(accountId: string): Promise<string | undefined>;
}

export interface ExportFileRequest {
  eventLabel: string;
  format: ExportFormat;
  rows: readonly AttendeeRecord[];
}

export const ATTENDEE_EXPORT_STORE = Symbol.for('peaket.export.store');
export const ATTENDEE_SOURCE = Symbol.for('peaket.export.attendee-source');
export const PARTNER_EVENT_LOOKUP = Symbol.for('peaket.export.event-lookup');
export const BOOKERS_REAUTH = Symbol.for('peaket.export.reauth');
