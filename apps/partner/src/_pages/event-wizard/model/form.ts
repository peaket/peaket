// 공연 등록 위저드의 입력 값과 규칙(SCR-021, d5 §6.4, ADR-0118, ADR-0198, ADR-0245). React·브라우저를 모르는 순수 함수만 둔다.
// 서버가 다시 검사한다. 여기 검사는 등록 전에 그 칸에서 바로 알려 주려는 것이다.
import { validateDoc, type PeaketDoc } from '../../../features/rich-text/doc.ts';

export type QueueOrder = 'HYBRID' | 'PREQUEUE_SHUFFLE' | 'FIFO';
export type SeatAssignment = 'PICK' | 'AUTO';
export type PlaceChoice = { kind: 'picked'; id: string; name: string } | { kind: 'new'; name: string; address: string };
/** artistId가 없으면 새 이름 요청이다(판매 승인 때 운영자가 잇거나 만든다, ADR-0093) */
export interface ArtistChoice {
  artistId?: string;
  name: string;
}

export interface RoundDraft {
  /** 화면 목록용 키. 서버로 보내지 않는다 */
  key: string;
  /** 시각은 모두 datetime-local 값(YYYY-MM-DDTHH:mm, 한국 시각). 비었으면 '' */
  openAt: string;
  lobbyMinutes: number | '';
  entryOpensAt: string;
  startsAt: string;
  endsAt: string;
  reentryAllowed: boolean;
}

export interface WizardDraft {
  title: string;
  genre: string;
  ageRating: string;
  runningMinutes: string;
  place: PlaceChoice | null;
  artists: ArtistChoice[];
  aliases: string[];
  producer: string;
  notice: string;
  /** 공연 설명 구조 문서. 글자가 없으면 null(ADR-0247) */
  description: PeaketDoc | null;
  rounds: RoundDraft[];
  queueOrder: QueueOrder;
  seatAssignment: SeatAssignment;
  perPersonLimit: number;
}

export type InputStep = 1 | 2 | 4;

export interface FieldError {
  step: InputStep;
  /** 칸 이름(rounds.0.openAt처럼 회차는 차례를 넣는다). 칸을 짚을 수 없으면 'form' */
  field: string;
  message: string;
}

export const ALIAS_MAX = 5;
export const ARTIST_MAX = 20;
export const ROUND_MAX = 50;

export function blankRound(key: string): RoundDraft {
  return { key, openAt: '', lobbyMinutes: 10, entryOpensAt: '', startsAt: '', endsAt: '', reentryAllowed: false };
}

export function emptyDraft(): WizardDraft {
  return {
    title: '',
    genre: '',
    ageRating: '',
    runningMinutes: '',
    place: null,
    artists: [],
    aliases: [],
    producer: '',
    notice: '',
    description: null,
    rounds: [blankRound('r1')],
    queueOrder: 'HYBRID',
    seatAssignment: 'PICK',
    perPersonLimit: 4,
  };
}

/* ---------- 칸 검사 ---------- */

const HOUR = 3_600_000;
const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
/** PostgreSQL이 받지 못하는 글자(NUL, 짝이 깨진 서로게이트, ADR-0244) */
const UNSTORABLE = /\u0000|\p{Cs}/u;

/** 한국 시각 입력값의 밀리초. 비었거나 형식이 다르면 NaN */
function kst(v: string): number {
  return LOCAL_DATETIME.test(v) ? Date.parse(`${v}:00+09:00`) : Number.NaN;
}

function textIssue(value: string, label: string, max: number): string | null {
  if (UNSTORABLE.test(value)) return `${label}에 저장할 수 없는 글자가 있습니다`;
  return value.trim().length > max ? `${label}은(는) ${max.toLocaleString('en-US')}자까지 적을 수 있습니다` : null;
}

function descriptionIssue(doc: PeaketDoc): string | null {
  const errs = validateDoc(doc);
  if (errs.length === 0) return null;
  if (errs.some((e) => e.includes('글자는'))) return '공연 설명은 줄바꿈을 포함해 20,000자까지 적을 수 있습니다';
  if (errs.some((e) => e.includes('블록은') || e.includes('노드는'))) return '공연 설명의 문단과 줄이 너무 많습니다. 줄여 주세요';
  return errs.some((e) => e.includes('저장할 수 없는')) ? '공연 설명에 저장할 수 없는 글자가 있습니다' : '공연 설명에 저장할 수 없는 서식이 있습니다';
}

function validateBasic(d: WizardDraft): FieldError[] {
  const errs: FieldError[] = [];
  const add = (field: string, message: string) => errs.push({ step: 1, field, message });
  const required = (field: string, value: string, label: string, max: number) => {
    if (value.trim() === '') add(field, `${label}을(를) 입력해 주세요`);
    else {
      const issue = textIssue(value, label, max);
      if (issue) add(field, issue);
    }
  };
  required('title', d.title, '공연명', 100);
  if (d.genre === '') add('genre', '장르를 골라 주세요');
  required('ageRating', d.ageRating, '관람 연령', 30);
  if (d.runningMinutes.trim() === '') add('runningMinutes', '러닝타임을 입력해 주세요');
  else if (!/^[1-9]\d*$/.test(d.runningMinutes.trim()) || Number(d.runningMinutes) > 1440) add('runningMinutes', '러닝타임은 1~1,440분 사이의 정수로 적어 주세요');
  required('producer', d.producer, '기획사·제작사', 200);
  const noticeIssue = textIssue(d.notice, '안내 사항', 1000);
  if (noticeIssue) add('notice', noticeIssue);
  const docIssue = d.description ? descriptionIssue(d.description) : null;
  if (docIssue) add('description', docIssue);

  if (d.place === null) add('place', '공연장을 찾아 고르거나 새 공연장을 요청해 주세요');
  else if (d.place.kind === 'new') {
    const issue = d.place.name.trim() === '' || d.place.address.trim() === '' ? '새 공연장의 이름과 주소를 적어 주세요' : (textIssue(d.place.name, '공연장 이름', 100) ?? textIssue(d.place.address, '공연장 주소', 200));
    if (issue) add('place', issue);
  }

  if (d.artists.length === 0) add('artists', '아티스트를 한 명 이상 더해 주세요');
  else if (d.artists.length > ARTIST_MAX) add('artists', `아티스트는 ${ARTIST_MAX}명까지 더할 수 있습니다`);
  else if (new Set(d.artists.flatMap((a) => (a.artistId ? [a.artistId] : []))).size !== d.artists.filter((a) => a.artistId).length) add('artists', '같은 아티스트를 두 번 더할 수 없습니다');
  else {
    const issue = d.artists.map((a) => (a.artistId ? null : textIssue(a.name, '아티스트 이름', 100))).find(Boolean);
    if (issue) add('artists', issue);
  }

  if (d.aliases.length > ALIAS_MAX) add('aliases', `다른 이름은 ${ALIAS_MAX}개까지 적을 수 있습니다`);
  else if (new Set(d.aliases.map((a) => a.trim())).size !== d.aliases.length) add('aliases', '같은 이름을 두 번 적을 수 없습니다');
  else {
    const issue = d.aliases.map((a) => textIssue(a, '다른 이름', 100)).find(Boolean);
    if (issue) add('aliases', issue);
  }
  return errs;
}

function validateRounds(d: WizardDraft, now: number | undefined): FieldError[] {
  const errs: FieldError[] = [];
  if (d.rounds.length === 0) return [{ step: 2, field: 'rounds', message: '회차를 하나 이상 더해 주세요' }];
  if (d.rounds.length > ROUND_MAX) return [{ step: 2, field: 'rounds', message: `회차는 ${ROUND_MAX}개까지 더할 수 있습니다` }];
  d.rounds.forEach((r, i) => {
    const add = (name: string, message: string) => errs.push({ step: 2, field: `rounds.${i}.${name}`, message });
    const starts = kst(r.startsAt);
    const ends = kst(r.endsAt);
    const open = kst(r.openAt);
    const startsOk = Number.isFinite(starts);
    if (!startsOk) add('startsAt', '공연 시작 시각을 입력해 주세요');
    if (!Number.isFinite(ends)) add('endsAt', '공연 종료 예정 시각을 입력해 주세요');
    else if (startsOk && ends <= starts) add('endsAt', '공연 종료 예정은 공연 시작 뒤여야 합니다');
    if (!Number.isFinite(open)) add('openAt', '오픈 시각을 입력해 주세요');
    else if (startsOk && open >= starts - 24 * HOUR) add('openAt', '오픈 시각은 판매 종료(공연 시작 24시간 전)보다 앞이어야 합니다');
    else if (now !== undefined && open <= now) add('openAt', '오픈 시각은 지금보다 뒤여야 합니다');
    const entry = kst(r.entryOpensAt);
    if (!Number.isFinite(entry)) add('entryOpensAt', '입장 시작 시각을 입력해 주세요');
    else if (startsOk && entry > starts) add('entryOpensAt', '입장 시작은 공연 시작 전이어야 합니다');
    if (typeof r.lobbyMinutes !== 'number' || !Number.isInteger(r.lobbyMinutes) || r.lobbyMinutes < 0 || r.lobbyMinutes > 60) add('lobbyMinutes', '로비 개방은 0~60분 사이로 적어 주세요');
  });
  return errs;
}

function validatePolicy(d: WizardDraft): FieldError[] {
  return Number.isInteger(d.perPersonLimit) && d.perPersonLimit >= 1 && d.perPersonLimit <= 10 ? [] : [{ step: 4, field: 'perPersonLimit', message: '1인 한도는 1~10매 사이로 정해 주세요' }];
}

/** 한 단계의 입력을 검사한다. now를 주면 이미 지난 오픈 시각도 막는다 */
export function validateStep(d: WizardDraft, step: InputStep, now?: number): FieldError[] {
  if (step === 1) return validateBasic(d);
  return step === 2 ? validateRounds(d, now) : validatePolicy(d);
}

/* ---------- 등록 본문 ---------- */

const QUEUE_FLAGS: Record<QueueOrder, { lobbyShuffle: boolean; openBatch: boolean }> = {
  HYBRID: { lobbyShuffle: true, openBatch: true },
  PREQUEUE_SHUFFLE: { lobbyShuffle: true, openBatch: false },
  FIFO: { lobbyShuffle: false, openBatch: true },
};

/** 기기 시간대와 상관없이 입력한 한국 시각 그대로 보낸다 */
const toInstant = (v: string) => `${v}:00+09:00`;

/** 검사를 통과한 값 → POST /v1/partner/productions 본문(PartnerProductionCreate) */
export function toCreateBody(d: WizardDraft) {
  const flags = QUEUE_FLAGS[d.queueOrder];
  const notice = d.notice.trim();
  const aliases = d.aliases.map((a) => a.trim());
  return {
    title: d.title.trim(),
    genre: d.genre,
    ageRating: d.ageRating.trim(),
    runningMinutes: Number(d.runningMinutes.trim()),
    ...(d.place?.kind === 'picked' ? { placeId: d.place.id } : {}),
    ...(d.place?.kind === 'new' ? { newPlace: { name: d.place.name.trim(), address: d.place.address.trim() } } : {}),
    artists: d.artists.map((a) => (a.artistId ? { artistId: a.artistId } : { name: a.name.trim() })),
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(d.description ? { description: d.description } : {}),
    kopisFields: { producer: d.producer.trim(), ...(notice ? { notice } : {}) },
    events: d.rounds.map((r) => ({
      openAt: toInstant(r.openAt),
      lobbyMinutes: r.lobbyMinutes === '' ? 10 : r.lobbyMinutes,
      entryOpensAt: toInstant(r.entryOpensAt),
      startsAt: toInstant(r.startsAt),
      endsAt: toInstant(r.endsAt),
      reentryAllowed: r.reentryAllowed,
      ...flags,
      seatAssignment: d.seatAssignment,
      perPersonLimit: d.perPersonLimit,
    })),
  };
}

/* ---------- 서버 판정 → 칸 오류 ---------- */

/** (가능: HH:MM). 고른 날과 다른 날이면 날짜도 붙인다. 시각이 없거나 깨졌으면 빈 글 */
function possible(iso: unknown, openAt?: string): string {
  if (typeof iso !== 'string') return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const kstIso = new Date(t + 9 * HOUR).toISOString();
  const sameDay = openAt === undefined || openAt.slice(0, 10) === kstIso.slice(0, 10);
  return `(가능: ${sameDay ? '' : `${kstIso.slice(5, 7)}/${kstIso.slice(8, 10)} `}${kstIso.slice(11, 16)})`;
}

const FALLBACK_MESSAGE = '등록하지 못했습니다. 입력한 내용을 확인한 뒤 다시 시도해 주세요';
/** 응답을 못 받았거나 서버 오류: 저장됐을 수도 있다. 같은 본문이면 같은 멱등 키라 다시 보내도 공연이 둘이 되지 않는다 */
const UNKNOWN_RESULT_MESSAGE = '공연이 등록되었는지 확인하지 못했습니다. 내용을 바꾸지 말고 다시 눌러 주세요. 입력한 내용은 이 브라우저에 남아 있습니다';

const formError = (message: string): FieldError[] => [{ step: 4, field: 'form', message }];

/** 입력이 바뀌었을 때 지울 오류. 'rounds.*'는 회차 오류 전부다(회차를 지우면 차례가 밀린다) */
export function clearFieldErrors(errors: readonly FieldError[], field: string): FieldError[] {
  const stays = (f: string) => (field === 'rounds.*' ? f !== 'rounds' && !f.startsWith('rounds.') : f !== field);
  return errors.filter((e) => e.field !== 'form' && stays(e.field));
}

/** 등록 실패 응답 → 보여 줄 오류. 칸을 짚을 수 없으면 field가 'form'이다(서버의 title·detail 원문은 보이지 않는다) */
export function problemToErrors(p: { status: number; type: string; extensions: Record<string, unknown> }, draft?: WizardDraft): FieldError[] {
  const index = p.extensions.eventIndex;
  const openAt = typeof index === 'number' ? draft?.rounds[index]?.openAt : undefined;
  const atOpen = (message: string): FieldError[] =>
    typeof index === 'number' && Number.isInteger(index) && index >= 0 ? [{ step: 2, field: `rounds.${index}.openAt`, message }] : formError(message);
  switch (p.type) {
    case 'open-too-close':
      return atOpen(`다른 공연과 5분 이상 떨어져야 합니다${possible(p.extensions.suggestedOpenAt, openAt)}`);
    case 'open-maintenance-window':
      return atOpen('수요일 03:00~06:30에는 오픈할 수 없습니다');
    case 'event-schedule-invalid':
      return atOpen('오픈은 지금보다 뒤, 공연 시작 24시간 전보다 앞이어야 합니다. 일정을 다시 확인해 주세요');
    case 'queue-order-invalid':
      return [{ step: 4, field: 'queueOrder', message: '대기열 정렬 방식을 다시 골라 주세요' }];
    case 'not-found':
      return [{ step: 1, field: 'place', message: '공연장이나 아티스트를 찾지 못했습니다. 다시 골라 주세요' }];
    default:
      if (p.status === 403) return formError('이 공연을 등록할 권한이 없습니다');
      if (p.status === 429) return formError('요청이 많습니다. 잠시 뒤 다시 시도해 주세요');
      if (p.status === 0 || p.status >= 500) return formError(UNKNOWN_RESULT_MESSAGE);
      return formError(FALLBACK_MESSAGE);
  }
}

/** 저장은 되었지만 알릴 것(ADR-0062, d5 §6.4 '대형 간격 경고') */
export function warningText(w: { code: string; suggestedOpenAt?: string }): string {
  return `이 공연이 판매 승인에서 대형 공연(예상 대기 50만 명 이상)으로 정해지면 다른 대형 공연과 30분 이상 떨어져야 합니다. 그때 오픈 시각을 바꿔야 할 수 있습니다${possible(w.suggestedOpenAt)}`;
}

/* ---------- 전산망 항목 상태 ---------- */

export type KopisStatus = '입력됨' | '입력 필요' | '비어 있음';

const placeFilled = (p: PlaceChoice | null) => p !== null && (p.kind === 'picked' || (p.name.trim() !== '' && p.address.trim() !== ''));

/** 입력에서 알 수 있는 전산망 항목의 상태(항목 이름 → 상태). 나머지 항목(자동 집계, 가격)은 고정 표를 따른다 */
export function kopisStatus(d: WizardDraft): Record<string, KopisStatus> {
  const need = (ok: boolean): KopisStatus => (ok ? '입력됨' : '입력 필요');
  const every = (f: (r: RoundDraft) => boolean) => d.rounds.length > 0 && d.rounds.every(f);
  return {
    '공연 명칭·종류': need(d.title.trim() !== '' && d.genre !== ''),
    '기간·장소': need(placeFilled(d.place) && every((r) => r.startsAt !== '' && r.endsAt !== '')),
    시간: need(d.runningMinutes.trim() !== '' && every((r) => r.startsAt !== '')),
    '관람 가능 연령': need(d.ageRating.trim() !== ''),
    '출연진·제작진·기획사·제작사': need(d.artists.length > 0 && d.producer.trim() !== ''),
    '안내 사항': d.notice.trim() === '' ? '비어 있음' : '입력됨',
  };
}

/* ---------- 임시저장 ---------- */

const DRAFT_VERSION = 1;
const QUEUE_ORDERS: readonly unknown[] = ['HYBRID', 'PREQUEUE_SHUFFLE', 'FIFO'];
const SEAT_ASSIGNMENTS: readonly unknown[] = ['PICK', 'AUTO'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

function isPlace(v: unknown): boolean {
  if (v === null) return true;
  if (!isRecord(v)) return false;
  return v.kind === 'picked' ? isStr(v.id) && isStr(v.name) : v.kind === 'new' && isStr(v.name) && isStr(v.address);
}

function isRound(v: unknown): boolean {
  return (
    isRecord(v) &&
    isStr(v.key) &&
    isStr(v.openAt) &&
    (typeof v.lobbyMinutes === 'number' || v.lobbyMinutes === '') &&
    isStr(v.entryOpensAt) &&
    isStr(v.startsAt) &&
    isStr(v.endsAt) &&
    typeof v.reentryAllowed === 'boolean'
  );
}

/** 모양만 본다. 상한을 넘긴 글도 임시저장은 잃지 않는다(ADR-0247 결정 3). 칸이 없으면 설명이 생기기 전의 임시저장이다 */
function isDescription(v: unknown): boolean {
  return v === null || v === undefined || validateDoc(v, 'shape').length === 0;
}

function isDraft(v: unknown): v is WizardDraft {
  if (!isRecord(v)) return false;
  return (
    isDescription(v.description) &&
    [v.title, v.genre, v.ageRating, v.runningMinutes, v.producer, v.notice].every(isStr) &&
    isPlace(v.place) &&
    Array.isArray(v.artists) &&
    v.artists.every((a) => isRecord(a) && isStr(a.name) && (a.artistId === undefined || isStr(a.artistId))) &&
    Array.isArray(v.aliases) &&
    v.aliases.every(isStr) &&
    Array.isArray(v.rounds) &&
    v.rounds.every(isRound) &&
    QUEUE_ORDERS.includes(v.queueOrder) &&
    SEAT_ASSIGNMENTS.includes(v.seatAssignment) &&
    typeof v.perPersonLimit === 'number'
  );
}

export function serializeDraft(d: WizardDraft): string {
  return JSON.stringify({ v: DRAFT_VERSION, draft: d });
}

/** 저장한 글 → 임시저장 값. 판이 다르거나 모양이 깨졌으면 null(새로 시작한다) */
export function parseDraft(raw: string | null): WizardDraft | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) && parsed.v === DRAFT_VERSION && isDraft(parsed.draft) ? { ...parsed.draft, description: parsed.draft.description ?? null } : null;
  } catch {
    return null;
  }
}

/* ---------- 멱등 키 ---------- */

export interface RequestKey {
  key: string;
  body: string;
}

/** 같은 본문을 다시 보내면 처음 키를 쓰고, 입력을 고치면 새 키를 만든다(ADR-0245 결정 5) */
export function requestKeyFor(prev: RequestKey | null, body: unknown, make: () => string): RequestKey {
  const json = JSON.stringify(body);
  return prev && prev.body === json ? prev : { key: make(), body: json };
}

/** 저장한 글 → 키(새로고침 뒤 재시도도 같은 키를 쓰게 한다) */
export function parseRequestKey(raw: string | null): RequestKey | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) && isStr(parsed.key) && isStr(parsed.body) ? { key: parsed.key, body: parsed.body } : null;
  } catch {
    return null;
  }
}
