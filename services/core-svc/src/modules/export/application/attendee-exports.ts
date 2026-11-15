// 예매자 명단 내려받기·이력 유스케이스(FR-027·064, POL-020·023, I-T53·J-T26).
// 권한은 컨트롤러 @Roles(partner_admin)가 보고, 여기서는 재인증·보유 기간·사유·파일 생성을 본다.
import { ProblemError, uuidv7, type Clock } from '@peaket/platform';
import type { ActorNameResolver } from '../domain/ports.js';
import type { AttendeeSource, AttendeeExportStore, BookersReauth, PartnerEventLookup } from '../domain/ports.js';
import {
  csvFile,
  ExportProblem,
  exportView,
  MAX_EXPORT_ROWS,
  retentionEnded,
  validateExportBody,
  xlsxFile,
  type AttendeeExportRecord,
  type AttendeeExportView,
  type ExportFile,
  type ExportFormat,
} from '../domain/export.js';
import { maskName, maskPhone } from '../../shop/index.js';

export interface ExportDeps {
  readonly store: AttendeeExportStore;
  readonly attendees: AttendeeSource;
  readonly events: PartnerEventLookup;
  readonly reauth: BookersReauth;
  readonly actors: ActorNameResolver;
  readonly clock: Clock;
}

export interface ExportActor {
  accountId: string;
  sessionId: string;
  role: string;
}

const notFound = () => new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
const retention = () => new ProblemError({ type: 'retention-ended', status: 410, title: '보관 기간이 끝났습니다' });
const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ExportProblem) throw new ProblemError({ type: e.type, status: e.status, title: e.title });
    throw e;
  }
};

const safeLabel = (title: string): string => title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || '공연';

export interface AttendeePageView {
  items: {
    orderId: string;
    buyerNameMasked: string;
    buyerPhoneMasked: string;
    eventId: string;
    seats: { seatLabel: string; tier: string }[];
    ticketCount: number;
  }[];
  nextCursor: string | null;
  bookingCount: number;
  ticketCount: number;
  asOf: string;
}

export class AttendeeExports {
  constructor(private readonly d: ExportDeps) {}

  // 뼈대(W7-audit 시험 단계): 넷째 인자 actor는 모양만 받는다. 행위자 확인과 LIST 접속기록은 구현 담당이 채운다(A2-19)
  async listAttendees(promoterId: string, eventId: string, q: { limit: number; cursor?: string }, _actor?: ExportActor): Promise<AttendeePageView> {
    return guard(async () => {
      const found = await this.d.events.find(promoterId, eventId);
      if (!found) throw notFound();
      const now = new Date(this.d.clock.now());
      if (retentionEnded(found.endsAt, now)) throw retention();
      // 뼈대(W7-audit 시험 단계): 원천이 페이지 모양이 되어 items만 꺼낸다. 원천 nextCursor를 쓰는 일은 구현 담당 몫(A2-17)
      const rows = (await this.d.attendees.list(promoterId, eventId, q.limit, q.cursor)).items;
      const totals = await this.d.attendees.count(promoterId, eventId);
      return {
        items: rows.map((r) => ({
          orderId: r.orderId,
          buyerNameMasked: maskName(r.buyerName),
          buyerPhoneMasked: maskPhone(r.buyerPhone),
          eventId,
          seats: r.seats ?? (r.seatLabel ? r.seatLabel.split(', ') : ['']).map((seatLabel) => ({ seatLabel, tier: 'GOODS' })),
          ticketCount: r.quantity,
        })),
        nextCursor: rows.length === q.limit ? Buffer.from(rows[rows.length - 1]!.orderId).toString('base64url') : null,
        bookingCount: totals.bookings,
        ticketCount: totals.tickets,
        asOf: now.toISOString(),
      };
    });
  }

  async create(promoterId: string, eventId: string, actor: ExportActor, token: string | undefined, body: { reason?: unknown; format?: unknown }): Promise<{ file: ExportFile; record: AttendeeExportView }> {
    return guard(async () => {
      const verified = await this.d.reauth.verify(token, { sessionId: actor.sessionId, promoterId });
      if (verified.accountId !== actor.accountId) throw new ExportProblem('reauth-required', 403, '다시 인증해 주세요');
      const found = await this.d.events.find(promoterId, eventId);
      if (!found) throw notFound();
      const now = new Date(this.d.clock.now());
      if (retentionEnded(found.endsAt, now)) throw retention();
      const { reason, format } = validateExportBody(body);
      if (format === 'PDF') throw new ExportProblem('export-format-unavailable', 503, 'PDF 형식은 아직 만들 수 없습니다');
      // A2-17: 한 번에 500만 행을 올리지 않고 1,000행 페이지를 커서로 이어 읽는다(상한은 MAX_EXPORT_ROWS).
      const rows: Awaited<ReturnType<AttendeeSource['list']>>['items'] = [];
      let cursor: string | undefined;
      for (;;) {
        // 뼈대(W7-audit 시험 단계): 원천이 페이지 모양이 되어 items만 꺼낸다. nextCursor로 끝을 보는 일은 구현 담당 몫(A2-17)
        const page = (await this.d.attendees.list(promoterId, eventId, 1_000, cursor)).items;
        rows.push(...page);
        if (rows.length > MAX_EXPORT_ROWS) throw new ExportProblem('invalid-query', 422, '한 번에 내려받을 수 있는 행 수를 넘었습니다');
        if (page.length < 1_000) break;
        const next = Buffer.from(page[page.length - 1]!.orderId).toString('base64url');
        if (next === cursor) break;
        cursor = next;
      }
      const label = safeLabel(found.title);
      const file = format === 'CSV' ? csvFile(rows, label) : xlsxFile(rows, label);
      const displayName = (await this.d.actors.displayName(actor.accountId).catch(() => undefined)) ?? (actor.role === 'partner_admin' ? '파트너 관리자' : actor.role);
      const record: AttendeeExportRecord = {
        exportId: uuidv7(this.d.clock),
        promoterId,
        eventId,
        actorAccountId: actor.accountId,
        actorDisplayName: displayName,
        actorRole: actor.role,
        reason,
        format,
        count: rows.length,
        result: 'COMPLETED',
        createdAt: now,
        expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      };
      await this.d.store.insert(record);
      await this.d.store.audit(record);
      return { file, record: exportView(record) };
    });
  }

  async history(promoterId: string, eventId: string, limit: number): Promise<{ items: AttendeeExportView[]; nextCursor: null }> {
    return guard(async () => {
      if (!(await this.d.events.find(promoterId, eventId))) throw notFound();
      return { items: (await this.d.store.list(promoterId, eventId, limit)).map(exportView), nextCursor: null };
    });
  }
}

export type { ExportFormat };
