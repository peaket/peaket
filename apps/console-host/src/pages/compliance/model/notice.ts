// SCR-032 통보 탭의 순수 모델(F-07-11, d5 §7.5, openapi /v1/ops/compliance/notices*).
// 응답에서 계정·주문·팬 이름 같은 신원 칸을 버리고, 화면이 보여 줄 기관·요약·사유·후기 ID만 남긴다.
// 역할별 가능한 조치와 등록·차단·철회 요청 계획을 여기서 정한다(화면은 글자 노드로만 그린다).
export type NoticeRequester = 'AGENCY' | 'POLICE';
export type NoticeStatus = 'OPEN' | 'TAKEN_DOWN' | 'WITHDRAWN';
export type NoticeDeadline = 'H24' | 'H10';
export type NoticeAction = 'TAKEDOWN' | 'WITHDRAWAL';

export interface NoticeView {
  readonly view: 'SUMMARY' | 'FULL';
  readonly noticeId: string;
  readonly requester: NoticeRequester;
  readonly agencyName: string;
  readonly dueAt: string;
  readonly status: NoticeStatus;
  readonly receivedAt?: string;
  readonly deadline?: NoticeDeadline;
  readonly reviewIds?: string[];
  readonly summary?: string;
  readonly documents?: unknown[];
  readonly takenDownAt?: string | null;
  readonly withdrawnAt?: string | null;
}

export interface NoticeFilter {
  readonly status?: NoticeStatus;
  readonly sort: 'DUE_ASC' | 'LATEST';
  readonly cursor?: string;
  readonly limit: number;
}

export interface NoticeCreateBody {
  readonly requester: NoticeRequester;
  readonly agencyName: string;
  readonly receivedAt: string;
  readonly deadline: NoticeDeadline;
  readonly reviewIds: string[];
  readonly summary?: string;
}

export const NOTICE_REASON_MAX = 2_000;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const requesterOf = (v: unknown): NoticeRequester => (v === 'POLICE' ? 'POLICE' : 'AGENCY');
const statusOf = (v: unknown): NoticeStatus => (v === 'TAKEN_DOWN' || v === 'WITHDRAWN' ? v : 'OPEN');
const deadlineOf = (v: unknown): NoticeDeadline | undefined => (v === 'H10' ? 'H10' : v === 'H24' ? 'H24' : undefined);

/** 목록·상세 응답 한 건을 화면 모델로 옮긴다. 모르는 칸(계정·주문·팬 이름·본문)은 옮기지 않는다 */
export function noticeViewOf(raw: Record<string, unknown>): NoticeView {
  const view = raw.view === 'FULL' ? 'FULL' : 'SUMMARY';
  const out: NoticeView = {
    view,
    noticeId: str(raw.noticeId) ?? '',
    requester: requesterOf(raw.requester),
    agencyName: str(raw.agencyName) ?? '',
    dueAt: str(raw.dueAt) ?? '',
    status: statusOf(raw.status),
  };
  const receivedAt = str(raw.receivedAt);
  const deadline = deadlineOf(raw.deadline);
  const summary = str(raw.summary);
  const takenDownAt = raw.takenDownAt === null ? null : str(raw.takenDownAt);
  const withdrawnAt = raw.withdrawnAt === null ? null : str(raw.withdrawnAt);
  const reviewIds = Array.isArray(raw.reviewIds) ? raw.reviewIds.filter((x): x is string => typeof x === 'string') : undefined;
  const documents = Array.isArray(raw.documents) ? [...raw.documents] : undefined;
  return {
    ...out,
    ...(receivedAt !== undefined ? { receivedAt } : {}),
    ...(deadline !== undefined ? { deadline } : {}),
    ...(reviewIds !== undefined ? { reviewIds } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(documents !== undefined ? { documents } : {}),
    ...(takenDownAt !== undefined ? { takenDownAt } : {}),
    ...(withdrawnAt !== undefined ? { withdrawnAt } : {}),
  };
}

/** 상세도 같은 모델이다. 응답에 섞여 온 신원·본문 칸은 위에서 이미 버린다 */
export function noticeDetailOf(raw: Record<string, unknown>): NoticeView {
  return noticeViewOf(raw);
}

/** 주소(?status=&sort=&cursor=&limit=)를 목록 조건으로 옮긴다. 잘못된 값은 기본값으로 되돌린다 */
export function noticeFilterOf(search: string | { get(name: string): string | null }): NoticeFilter {
  const get = (name: string): string | null => {
    if (typeof search === 'string') return new URLSearchParams(search).get(name);
    return search.get(name);
  };
  const rawStatus = get('status');
  const status = rawStatus === 'OPEN' || rawStatus === 'TAKEN_DOWN' || rawStatus === 'WITHDRAWN' ? rawStatus : undefined;
  const sort = get('sort') === 'LATEST' ? 'LATEST' : 'DUE_ASC';
  const rawLimit = Number(get('limit') ?? '50');
  const limit = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 100 ? rawLimit : 50;
  const cursor = get('cursor') ?? undefined;
  return { ...(status ? { status } : {}), sort, ...(cursor ? { cursor } : {}), limit };
}

export interface NoticeCreateForm {
  readonly requester: string;
  readonly agencyName: string;
  readonly receivedAt: string;
  readonly deadline: string;
  readonly reviewIds: string;
  readonly summary: string;
}

export type NoticeCreatePlan = { readonly ok: true; readonly body: NoticeCreateBody } | { readonly ok: false; readonly errors: string[] };

/** 등록 입력을 검사한다(기관 1~100자, 요약 2,000자, 후기 1~100개·중복 없음, 시각·기한 형식) */
export function noticeCreatePlan(form: NoticeCreateForm): NoticeCreatePlan {
  const errors: string[] = [];
  const requester = form.requester === 'POLICE' ? 'POLICE' : form.requester === 'AGENCY' ? 'AGENCY' : null;
  const deadline = form.deadline === 'H10' ? 'H10' : form.deadline === 'H24' ? 'H24' : null;
  const agencyName = form.agencyName.trim();
  const summary = form.summary.trim();
  const reviewIds = [...new Set(form.reviewIds.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))];
  const receivedAtMs = Date.parse(form.receivedAt);
  if (!requester) errors.push('접수 기관 종류를 골라 주세요');
  if (!deadline) errors.push('처리 기한을 골라 주세요');
  if (agencyName.length < 1 || agencyName.length > 100) errors.push('기관 이름은 1~100자입니다');
  if (summary.length > NOTICE_REASON_MAX) errors.push('요약은 2,000자까지입니다');
  if (reviewIds.length < 1 || reviewIds.length > 100) errors.push('후기 ID는 1~100개입니다');
  if (Number.isNaN(receivedAtMs)) errors.push('접수 시각을 다시 적어 주세요');
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      requester: requester!,
      agencyName,
      receivedAt: new Date(receivedAtMs).toISOString(),
      deadline: deadline!,
      reviewIds,
      ...(summary ? { summary } : {}),
    },
  };
}

export type NoticeActionPlan =
  | { readonly ok: true; readonly body: { readonly reason: string }; readonly headers: { readonly 'Idempotency-Key': string } }
  | { readonly ok: false; readonly errors: string[] };

/** 차단·철회 사유를 검사하고, 같은 재시도에 같은 Idempotency-Key를 싣는 머리를 만든다 */
export function noticeActionPlan(reason: string, idempotencyKey: string): NoticeActionPlan {
  const text = reason.trim();
  const errors: string[] = [];
  if (text.length < 1 || text.length > NOTICE_REASON_MAX) errors.push('사유는 1~2,000자입니다');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) errors.push('멱등 키가 UUID v4가 아닙니다');
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, body: { reason: text }, headers: { 'Idempotency-Key': idempotencyKey } };
}

/** 역할과 지금 상태에서 할 수 있는 조치. CS는 읽기만 하고(요약), operator·commander가 차단·철회한다 */
export function noticeActionsFor(detail: Pick<NoticeView, 'status'>, role: string | undefined): readonly NoticeAction[] {
  if (role !== 'operator' && role !== 'commander') return [];
  if (detail.status === 'OPEN') return ['TAKEDOWN'];
  if (detail.status === 'TAKEN_DOWN') return ['WITHDRAWAL'];
  return [];
}

export const noticeStatusLabel = (status: NoticeStatus): string => (status === 'OPEN' ? '접수' : status === 'TAKEN_DOWN' ? '차단함' : '철회함');
export const noticeRequesterLabel = (requester: NoticeRequester): string => (requester === 'POLICE' ? '수사기관' : '신고기관');
export const noticeActionLabel = (action: NoticeAction): string => (action === 'TAKEDOWN' ? '노출 차단' : '통보 철회');
