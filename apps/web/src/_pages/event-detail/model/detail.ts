// SCR-002 공연 상세 응답을 화면 값으로 바꾸고, 예매 버튼·배지를 시각으로 고른다(d5 §5.2, openapi EventPublicSummary, ADR-0200, BUILD_ORDER HOT-311).
// 계약의 칸은 모두 선택이라, 화면에 꼭 필요한 칸(회차·공연·공연명·시작·오픈·판매 종료)이 없으면 그리지 않는다(404와 같게 본다).
// 날짜·시각은 한국 시각으로 쓴다. 이 파일은 순수 함수만 둔다(node --test가 바로 불러 본다). 값은 서버 → 클라이언트로 넘길 수 있게 평평하다.
import type { EventPublicSummary } from '@peaket/api-client/model';
import { dateTimeText, parseTime, timeText } from '../../../shared/lib/kst.ts';

export type SortMode = 'HYBRID' | 'PREQUEUE_SHUFFLE' | 'FIFO';
export type SeatMode = 'PICK' | 'AUTO';
export type EventStatus = 'SCHEDULED' | 'CANCELLED' | 'POSTPONED';

export interface DetailRound {
  eventId: string;
  href: string;
  /** '12/24(목) 19:00' */
  label: string;
  current: boolean;
  openAtMs?: number;
  saleEndsAtMs?: number;
  status: EventStatus;
}

export interface DetailSeller {
  legalName: string;
  representative: string;
  address: string;
  phone: string;
  email: string;
  businessRegNo: string;
  mailOrderReportNo?: string;
  exemptionBasis?: string;
}

export interface EventDetail {
  eventId: string;
  productionId: string;
  title: string;
  roundLabel: string;
  genre?: NonNullable<EventPublicSummary['genre']>;
  /** '피켓 아레나 · 150분 · 만 7세 이상'(없는 칸은 뺀다) */
  infoLine: string;
  posterUrl?: string;
  posterAlt: string;
  place: { id?: string; name: string; address?: string };
  startsAtMs: number;
  openAtMs: number;
  lobbyOpensAtMs?: number;
  saleEndsAtMs: number;
  /** '11/20(금) 20:00' */
  openText: string;
  /** 로비 개방 '19:50'(로비가 없는 선착순은 없음) */
  lobbyText?: string;
  /** 오픈 시각 '20:00'(선착순의 '대기열은 20:00에 열립니다') */
  openTimeText: string;
  /** 양도 마감(공연 시작 2시간 전과 입장 시작 중 이른 때, POL-018·d5 §5.2 판매 조건) */
  transferDeadlineText: string;
  status: EventStatus;
  sortMode: SortMode;
  seatMode: SeatMode;
  perPersonLimit: number;
  reentryAllowed: boolean;
  /** 판매 정보 배지에 선예매가 있는가 */
  presale: boolean;
  rounds: DetailRound[];
  tiers: { id: string; name: string; price: number }[];
  /** 판매자 상호(판매자 줄과 중개자 고지) */
  sellerName: string;
  /** 판매자 신원정보 7항목. 판매 승인이 다 확인하지 않은 공연은 없다(ADR-0200 결정 4) */
  seller?: DetailSeller;
  /** 설명 글자판의 문단(빈 줄로 나눈다). 글자로만 그린다 */
  description: string[];
  detailImages: { url: string; alt: string }[];
  artists: string[];
  /** 상세정보 섹션을 보이는가(설명 글·상세 이미지가 모두 없으면 숨긴다, d5 §5.2 '상세정보 없음') */
  hasDetail: boolean;
}

const HOUR = 60 * 60_000;
export const eventHref = (eventId: string) => `/events/${encodeURIComponent(eventId)}`;

const SORT: readonly SortMode[] = ['HYBRID', 'PREQUEUE_SHUFFLE', 'FIFO'];
const STATUS: readonly EventStatus[] = ['SCHEDULED', 'CANCELLED', 'POSTPONED'];

function paragraphs(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function seller(s: EventPublicSummary['seller']): DetailSeller | undefined {
  if (!s?.legalName || !s.representative || !s.address || !s.phone || !s.email || !s.businessRegNo) return undefined;
  if (!s.mailOrderReportNo && !s.exemptionBasis) return undefined;
  return {
    legalName: s.legalName,
    representative: s.representative,
    address: s.address,
    phone: s.phone,
    email: s.email,
    businessRegNo: s.businessRegNo,
    ...(s.mailOrderReportNo ? { mailOrderReportNo: s.mailOrderReportNo } : {}),
    ...(s.exemptionBasis ? { exemptionBasis: s.exemptionBasis } : {}),
  };
}

export function toEventDetail(e: EventPublicSummary): EventDetail | undefined {
  const startsAtMs = parseTime(e.startsAt);
  const openAtMs = parseTime(e.openAt);
  const saleEndsAtMs = parseTime(e.saleEndsAt);
  if (!e.eventId || !e.productionId || !e.title || startsAtMs === undefined || openAtMs === undefined || saleEndsAtMs === undefined) return undefined;
  const eventId = e.eventId;
  const sortMode: SortMode = SORT.includes(e.queueOrder as SortMode) ? (e.queueOrder as SortMode) : 'HYBRID';
  const lobbyOpensAtMs = sortMode === 'FIFO' ? undefined : parseTime(e.lobbyOpensAt);
  const entryOpensAtMs = parseTime(e.entryOpensAt);
  const status: EventStatus = STATUS.includes(e.status as EventStatus) ? (e.status as EventStatus) : 'SCHEDULED';

  const roundStatus = (v: unknown): EventStatus => (STATUS.includes(v as EventStatus) ? (v as EventStatus) : 'SCHEDULED');
  const seen = new Set<string>();
  const rounds: { s: number; round: DetailRound }[] = [];
  for (const r of e.rounds ?? []) {
    const s = parseTime(r.startsAt);
    if (!r.eventId || s === undefined || seen.has(r.eventId)) continue;
    seen.add(r.eventId);
    const openAt = parseTime(r.openAt);
    const saleEndsAt = parseTime(r.saleEndsAt);
    rounds.push({
      s,
      round: {
        eventId: r.eventId,
        href: eventHref(r.eventId),
        label: dateTimeText(s),
        current: r.eventId === eventId,
        ...(openAt !== undefined ? { openAtMs: openAt } : {}),
        ...(saleEndsAt !== undefined ? { saleEndsAtMs: saleEndsAt } : {}),
        status: roundStatus(r.status),
      },
    });
  }
  // 회차 목록에는 이 회차가 늘 있다(계약). 빠졌으면 넣는다
  if (!seen.has(eventId)) {
    rounds.push({ s: startsAtMs, round: { eventId, href: eventHref(eventId), label: dateTimeText(startsAtMs), current: true, openAtMs, saleEndsAtMs, status } });
  }
  rounds.sort((a, b) => a.s - b.s);

  const place = { ...(e.placeId ? { id: e.placeId } : {}), name: e.placeName ?? '', ...(e.placeAddress ? { address: e.placeAddress } : {}) };
  const description = paragraphs(e.descriptionText);
  const detailImages = (e.detailImages ?? []).filter((i) => i.url && i.alt).map((i) => ({ url: i.url, alt: i.alt }));
  const transferDeadline = Math.min(startsAtMs - 2 * HOUR, entryOpensAtMs ?? Number.POSITIVE_INFINITY);
  const s = seller(e.seller);

  return {
    eventId,
    productionId: e.productionId,
    title: e.title,
    roundLabel: dateTimeText(startsAtMs),
    ...(e.genre ? { genre: e.genre } : {}),
    infoLine: [place.name, e.runningMinutes ? `${e.runningMinutes}분` : '', e.ageRating ?? ''].filter(Boolean).join(' · '),
    ...(e.posterUrl ? { posterUrl: e.posterUrl } : {}),
    posterAlt: e.posterAlt || `${e.title} 포스터`,
    place,
    startsAtMs,
    openAtMs,
    ...(lobbyOpensAtMs !== undefined ? { lobbyOpensAtMs, lobbyText: timeText(lobbyOpensAtMs) } : {}),
    saleEndsAtMs,
    openText: dateTimeText(openAtMs),
    openTimeText: timeText(openAtMs),
    transferDeadlineText: dateTimeText(transferDeadline),
    status,
    sortMode,
    seatMode: e.seatAssignment === 'AUTO' ? 'AUTO' : 'PICK',
    perPersonLimit: e.perPersonLimit ?? 4,
    reentryAllowed: e.reentryAllowed ?? false,
    presale: (e.badges ?? []).includes('PRESALE'),
    rounds: rounds.map((r) => r.round),
    tiers: (e.priceTiers ?? []).flatMap((t) => (t.tierId && t.name && typeof t.price === 'number' ? [{ id: t.tierId, name: t.name, price: t.price }] : [])),
    sellerName: s?.legalName ?? e.sellerName ?? '',
    ...(s ? { seller: s } : {}),
    description,
    detailImages,
    artists: (e.artists ?? []).flatMap((a) => (a.name ? [a.name] : [])),
    hasDetail: description.length > 0 || detailImages.length > 0,
  };
}

/** 예매 버튼 상태(d5 §5.2 상태 표). 개인 상태(비로그인·본인확인·예매 제한·선예매)는 HOT-320·340이 얹는다 */
export type BookingPhase = 'closed' | 'pending' | 'notYet' | 'lobby' | 'fifo' | 'queue' | 'ended' | 'cancelled';

/**
 * 지금 시각(서버 시각 보정)으로 예매 버튼 상태와 다음에 바뀔 시각을 고른다.
 * unlockAtMs는 이 기기의 [로비 입장]이 열리는 시각(로비 개방 + 0~60초, lobby-unlock.ts). 로비 시간 안에서 아직 모르면 'pending'(뼈대)이다:
 * 열리는 시각이 이미 지난 사람에게 비활성 버튼이 잠깐 비치지 않게 한다(queue-admission §2 '버튼은 처음부터 열려 있다').
 */
export function bookingPhase(
  d: Pick<EventDetail, 'status' | 'openAtMs' | 'lobbyOpensAtMs' | 'saleEndsAtMs'>,
  nowMs: number,
  unlockAtMs: number | undefined,
): { phase: BookingPhase; nextAt?: number } {
  if (d.status === 'CANCELLED') return { phase: 'cancelled' };
  if (nowMs >= d.saleEndsAtMs) return { phase: 'ended' };
  if (nowMs >= d.openAtMs) return { phase: 'queue', nextAt: d.saleEndsAtMs };
  if (d.lobbyOpensAtMs === undefined) return { phase: 'fifo', nextAt: d.openAtMs };
  if (nowMs < d.lobbyOpensAtMs) return { phase: 'closed', nextAt: d.lobbyOpensAtMs };
  if (unlockAtMs === undefined) return { phase: 'pending', nextAt: d.openAtMs };
  if (nowMs < unlockAtMs) return { phase: 'notYet', nextAt: unlockAtMs };
  return { phase: 'lobby', nextAt: d.openAtMs };
}

/**
 * 등급 배지. 판매 중의 등급별 매진은 실시간 출처(HOT-010)가 정해지기 전이라 고정 글 '판매 중'(POL-029 원본 장애 때와 같은 모양)이다.
 * 상태를 아직 모르면(첫 그리기) 없음: 화면이 뼈대를 둔다.
 */
export function tierBadge(phase: BookingPhase | undefined): { text: string; kind: 'badge'; tone: 'primary' | 'neutral' } | { text: string; kind: 'muted' } | undefined {
  if (!phase) return undefined;
  if (phase === 'queue') return { text: '판매 중', kind: 'muted' };
  if (phase === 'ended' || phase === 'cancelled') return { text: '판매 종료', kind: 'badge', tone: 'neutral' };
  return { text: '오픈 예정', kind: 'badge', tone: 'primary' };
}

/** 회차 칩 배지: 회차마다 그 회차의 오픈·판매 종료로 고른다(d5 §5.2 '판매 종료' 행) */
export function roundBadge(r: DetailRound, nowMs: number): { text: string; tone: 'primary' | 'success' | 'neutral' } {
  if (r.status === 'CANCELLED') return { text: '취소', tone: 'neutral' };
  if (r.saleEndsAtMs !== undefined && nowMs >= r.saleEndsAtMs) return { text: '판매 종료', tone: 'neutral' };
  if (r.openAtMs !== undefined && nowMs < r.openAtMs) return { text: '오픈 예정', tone: 'primary' };
  return { text: '판매 중', tone: 'success' };
}

/** JSON-LD 글: `<`·U+2028·U+2029를 JSON 이스케이프(역빗금 u 네 자리)로 바꿔 스크립트 블록을 끝내거나 HTML 주석을 열지 못하게 한다(JSON으로 읽으면 같은 값, asvs/catalog-review 1.2.3) */
export function jsonLdText(data: unknown): string {
  return JSON.stringify(data).replace(/[<\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * 구조화 데이터의 판매 상태(schema.org Offer availability, docs/frontend.md '회차 상세의 정규 주소'의 '판매 상태'). 그린 때(ISR, 300초)의 시각으로
 * 정한다: 오픈 전 PreOrder, 판매 중 InStock, 판매 종료·취소 뒤 Discontinued. 등급별 실시간 매진은 HOT-010의 출처가 정해지면 SoldOut을 더한다.
 */
export function offerAvailability(d: Pick<EventDetail, 'status' | 'openAtMs' | 'saleEndsAtMs'>, nowMs: number): string {
  if (d.status === 'CANCELLED' || nowMs >= d.saleEndsAtMs) return 'https://schema.org/Discontinued';
  if (nowMs < d.openAtMs) return 'https://schema.org/PreOrder';
  return 'https://schema.org/InStock';
}
