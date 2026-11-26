// ops-svc CS 문의 답변·진행 경과·닫기와 건 상세 기록(F-06-5, openapi createOpsCaseReply·CsCaseDetail.messages).
import { ProblemError } from '@peaket/platform';
import type { AuditChain } from '../../audit/index.js';
import type { CsActor, CsCaseDetailReader } from '../domain/cs-case.js';
import type { SupportCaseMessage, SupportCaseReplyPort, SupportCaseRecord } from '../domain/support-case.js';
import type { CsCases, CsCaseUpdateBody, CsCaseView } from './cs-cases.js';

export type { SupportCaseMessage, SupportCaseReplyPort, SupportCaseRecord } from '../domain/support-case.js';

const PROBLEM = (type: string, status: number, title: string) => new ProblemError({ type, status, title });
const CANDIDATE = /\d[\d -]{8,20}\d/g;
/** 글 속 계좌번호 꼴을 가린다. 저장값은 바꾸지 않고 콘솔 응답만 가린다 */
export function maskAccountNumbers(text: string): string {
  let out = text;
  const found: { index: number; text: string }[] = [];
  for (const m of text.matchAll(CANDIDATE)) {
    const raw = m[0];
    const index = m.index ?? 0;
    const digits = raw.replace(/[ -]/g, '');
    if (digits.length < 10 || digits.length > 14) continue;
    if (/^01[016789]/.test(digits)) continue;
    if (/^20\d{11}$/.test(digits)) continue;
    if (text.slice(Math.max(0, index - 4), index).toLowerCase() === 'ord-') continue;
    found.push({ index, text: raw });
  }
  for (let i = found.length - 1; i >= 0; i -= 1) {
    const m = found[i]!;
    out = `${out.slice(0, m.index)}(계좌번호 지움)${out.slice(m.index + m.text.length)}`;
  }
  return out;
}

const displayOf = (author: string): string => {
  const a = author.endsWith('_FAN') ? 'FAN' : author.endsWith('_AGENT') ? 'AGENT' : author.endsWith('_SYSTEM') ? 'SYSTEM' : author;
  return a === 'AGENT' ? '피켓 고객센터' : a === 'FAN' ? '나' : '피켓';
};
const kindOf = (kind: string): string => {
  if (kind.endsWith('_PROGRESS')) return 'PROGRESS';
  if (kind.endsWith('_ANSWER')) return 'ANSWER';
  return kind.endsWith('_MESSAGE') ? 'MESSAGE' : kind;
};
const authorKindOf = (author: string): string => {
  if (author.endsWith('_FAN')) return 'FAN';
  if (author.endsWith('_AGENT')) return 'AGENT';
  if (author.endsWith('_SYSTEM')) return 'SYSTEM';
  return author;
};
const isInquiryCase = (kind: string): boolean => kind === 'INQUIRY' || kind === 'DISPUTE' || kind === 'MINOR_CONTRACT_CANCEL';

export interface CaseRepliesDeps {
  readonly cases: CsCases;
  readonly supportCases?: SupportCaseReplyPort;
  readonly audit: AuditChain;
  readonly clock: { now(): number };
  readonly logger?: { warn(obj: object, msg: string): void };
}

export class CaseReplies {
  constructor(private readonly d: CaseRepliesDeps) {}

  async reply(actor: CsActor, caseId: string, requestId: string, kind: 'ANSWER' | 'PROGRESS', body: string): Promise<Record<string, unknown>> {
    const clean = body.normalize('NFC');
    const length = [...new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(clean)].length;
    if (clean.trim() === '' || length < 1 || length > 2_000) throw PROBLEM('invalid-body', 422, '답변은 1~2,000자입니다');
    const { view } = await this.d.cases.get(actor, caseId);
    if (view.status === 'RESOLVED') throw PROBLEM('case-already-resolved', 409, '이미 해결한 건입니다');
    if (!isInquiryCase(view.kind)) throw PROBLEM('case-not-inquiry', 409, '문의가 이어진 건이 아닙니다');
    if (!this.d.supportCases) throw PROBLEM('support-unavailable', 503, '문의 연결을 사용할 수 없습니다');
    let out: Awaited<ReturnType<SupportCaseReplyPort['reply']>>;
    try {
      out = await this.d.supportCases.reply({ requestId, inquiryId: view.targetRef, kind, body, actedBy: actor.accountId });
    } catch {
      throw PROBLEM('support-unavailable', 503, '문의 연결을 사용할 수 없습니다');
    }
    if (out.result === 'INQUIRY_CLOSED') throw PROBLEM('inquiry-closed', 409, '닫힌 문의입니다');
    const message = out.message!;
    try {
      await this.d.audit.append({
        recordType: 'CS_CASE_REPLIED',
        recordId: caseId,
        nowMs: this.d.clock.now(),
        payload: { caseId, inquiryId: view.targetRef, kind, length: [...body].length },
      });
    } catch (err) {
      this.d.logger?.warn({ event: 'cs-case-reply-audit-failed', err: err instanceof Error ? err.name : 'unknown' }, '답변 감사 기록을 남기지 못했다');
    }
    return {
      messageId: message.messageId,
      authorKind: 'AGENT',
      authorDisplay: '피켓 고객센터',
      kind: kindOf(message.kind),
      body: maskAccountNumbers(message.body),
      createdAt: new Date(message.createdAtMs).toISOString(),
    };
  }

  /** 건 해결. 문의가 이어진 건이면 core CloseInquiry를 먼저 부르고 성공해야 지역 건을 닫는다 */
  async resolve(actor: CsActor, caseId: string, ifMatch: string | undefined, body: CsCaseUpdateBody): Promise<{ view: CsCaseView; version: number }> {
    if (body.status === 'RESOLVED') {
      const { view } = await this.d.cases.get(actor, caseId);
      if (isInquiryCase(view.kind) && this.d.supportCases) {
        try {
          await this.d.supportCases.close({ requestId: caseId, inquiryId: view.targetRef, actedBy: actor.accountId });
        } catch {
          throw PROBLEM('support-unavailable', 503, '문의 연결을 사용할 수 없습니다');
        }
      }
    }
    return this.d.cases.update(actor, caseId, ifMatch, body);
  }
}

/** GET /v1/ops/cases/{caseId}의 정본 messages. 담당자 ID·이름은 싣지 않고 계좌번호를 가린다 */
export class CaseInquiryDetail implements CsCaseDetailReader {
  constructor(private readonly supportCases: SupportCaseReplyPort | undefined) {}

  async read(c: { targetRef: string; kind: string }, actor: CsActor): Promise<Record<string, unknown>> {
    if (!isInquiryCase(c.kind) || !this.supportCases) return {};
    try {
      const record = await this.supportCases.read(c.targetRef, actor.accountId);
      if (!record) return { messages: [] };
      return {
        messages: record.messages.map((m) => ({
          messageId: m.messageId,
          authorKind: authorKindOf(m.authorKind),
          authorDisplay: displayOf(m.authorKind),
          kind: kindOf(m.kind),
          body: maskAccountNumbers(m.body),
          createdAt: new Date(m.createdAtMs).toISOString(),
        })),
      };
    } catch {
      return { messages: [] };
    }
  }
}
