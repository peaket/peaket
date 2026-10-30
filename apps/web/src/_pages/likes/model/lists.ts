// SCR-054 카드 목록을 목업에서 만든다. 찜은 me 목업의 likedProductionIds(공연 단위, ADR-0093) + 판매 목록에서 내려간 지난 공연,
// 알림 신청은 like 목업이다. 공연 이름·포스터·기간·회차 시각은 production·performance·venue 목업에서 읽는다.
import {
  ALERT_CHANNEL_TEXT,
  ALERT_END_TEXT,
  ALERT_KIND_ICON,
  ALERT_KIND_LABEL,
  ALERT_SUBSCRIPTIONS,
  ENDED_ALERT_SUBSCRIPTIONS,
  LIKED_PAST_PRODUCTION_IDS,
  PAST_PRODUCTIONS,
  PENDING_LIKE_PRODUCTION_IDS,
  canResubscribe,
  type AlertSubscription,
} from '@/entities/like';
import { ME } from '@/entities/me';
import { getPerformance } from '@/entities/performance';
import { getProduction, productionHref, type PosterArt } from '@/entities/production';
import { getVenue } from '@/entities/venue';

export interface LikeCard {
  id: string;
  title: string;
  /** 공연 상세(첫 회차). 지난 공연은 상세가 없어 링크 없음 */
  href?: string;
  art: PosterArt;
  posterShort: string;
  /** 둘째 줄(오픈 일시·회차·공연장) */
  sub: string;
  badge: { text: string; cls: string };
  /** 오프라인에서 눌러 저장을 기다리는 찜 */
  pending: boolean;
}

export interface AlertItem {
  id: string;
  title: string;
  /** 회차 시각 또는 '… 오픈' */
  when: string;
  kindLabel: string;
  kindIcon: 'bell' | 'ticket';
  channel: string;
  nightPush: boolean;
  /** 끝났으면 까닭 글 */
  endedText?: string;
  /** [다시 신청]을 보인다(판매 종료로 끝난 신청은 아니다) */
  resubscribe: boolean;
  /** 버튼의 화면 낭독용 덧붙임(공연·회차·알림 종류) */
  srLabel: string;
}

function likeCard(id: string, pendingIds: readonly string[]): LikeCard | null {
  const p = getProduction(id);
  if (p) {
    const venue = getVenue(p.venueId)?.name ?? '';
    const rounds = p.performanceIds.length;
    const pending = pendingIds.includes(p.id);
    switch (p.status) {
      case 'upcoming':
        return { id: p.id, title: p.title, href: productionHref(p), art: p.poster.art, posterShort: p.poster.short, sub: `${p.openText} 오픈`, badge: { text: '오픈 예정', cls: 'badge badge-primary' }, pending };
      case 'sold_out':
        return { id: p.id, title: p.title, href: productionHref(p), art: p.poster.art, posterShort: p.poster.short, sub: `회차 ${rounds}개 · ${venue}`, badge: { text: '매진', cls: 'badge badge-danger' }, pending };
      case 'ended':
        return { id: p.id, title: p.title, href: productionHref(p), art: p.poster.art, posterShort: p.poster.short, sub: `${p.periodText} · ${venue}`, badge: { text: '지난 공연', cls: 'badge' }, pending };
      default:
        return { id: p.id, title: p.title, href: productionHref(p), art: p.poster.art, posterShort: p.poster.short, sub: `${p.periodText} · ${rounds}회차`, badge: { text: '판매 중', cls: 'badge badge-success' }, pending };
    }
  }
  const past = PAST_PRODUCTIONS.find((x) => x.id === id);
  if (!past) return null;
  return {
    id: past.id,
    title: past.title,
    art: past.posterArt,
    posterShort: past.posterShort,
    sub: `${past.lastShowText} · ${past.venueName}`,
    badge: { text: '지난 공연', cls: 'badge' },
    pending: pendingIds.includes(past.id),
  };
}

/** 관심 공연 카드(보드 순서: 찜한 공연 → 지난 공연) */
export function likeCards(offline: boolean): LikeCard[] {
  const pendingIds = offline ? PENDING_LIKE_PRODUCTION_IDS : [];
  return [...ME.likedProductionIds, ...LIKED_PAST_PRODUCTION_IDS].map((id) => likeCard(id, pendingIds)).filter((c): c is LikeCard => c !== null);
}

function alertItem(s: AlertSubscription): AlertItem {
  const p = getProduction(s.productionId);
  const past = p ? undefined : PAST_PRODUCTIONS.find((x) => x.id === s.productionId);
  const title = p?.title ?? past?.title ?? '';
  const perf = s.performanceId ? getPerformance(s.performanceId) : undefined;
  // 회차 단위 신청은 회차 시각, 공연 단위 오픈 알림은 오픈 일시, 지난 공연은 마지막 회차
  const when = perf?.label ?? (p ? `${p.openText} 오픈` : (past?.lastShowText ?? ''));
  const kindLabel = ALERT_KIND_LABEL[s.kind];
  return {
    id: s.id,
    title,
    when,
    kindLabel,
    kindIcon: ALERT_KIND_ICON[s.kind],
    channel: ALERT_CHANNEL_TEXT,
    nightPush: s.nightPush,
    endedText: s.ended ? ALERT_END_TEXT[s.ended] : undefined,
    resubscribe: canResubscribe(s),
    srLabel: `${title} ${when} ${kindLabel}`,
  };
}

/** 알림 신청 카드(끝난 신청도 함께, 끝나지 않은 것이 먼저인 보드 순서 그대로) */
export function alertItems(endedSample: boolean): AlertItem[] {
  return (endedSample ? ENDED_ALERT_SUBSCRIPTIONS : ALERT_SUBSCRIPTIONS).map(alertItem);
}

/** 탭 배지 숫자: 알림 신청은 끝나지 않은 신청만 센다(보드 '알림 신청 3', 끝난 까닭 셋 상태는 1) */
export function activeAlertCount(items: readonly AlertItem[]): number {
  return items.filter((a) => !a.endedText).length;
}
