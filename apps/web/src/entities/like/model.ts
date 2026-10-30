// 관심 공연(찜)·알림 신청 목업(캔버스 보드 SCR-054-m·t·d의 카드와 d5 §5.28 표본을 옮겼다). 공연 이름·회차 시각은 production·performance 목업이 정본이고,
// 여기에는 신청 기록(어느 공연·회차를, 무슨 알림으로, 밤 웹 푸시를 켰는지, 끝났는지)만 둔다. FSD 규칙상 다른 entities를 가져오지 않는다(합치기는 페이지에서).

/** 알림 종류: 오픈 알림(FR-004) · 취소표 알림(FR-018) */
export type AlertKind = 'open' | 'cancel';

/** 신청이 끝난 까닭(d5 §5.28 상태 '신청 끝', API endReason) */
export type AlertEndReason = 'SENT_MAX' | 'BOOKED' | 'SALE_ENDED';

export interface AlertSubscription {
  id: string;
  productionId: string;
  /** 회차 단위 신청이면 회차 id. 없으면 공연 단위(다음에 오픈하는 회차, ADR-0093) */
  performanceId?: string;
  kind: AlertKind;
  /** 밤(21:00~08:00)에도 웹 푸시 받기(기본 꺼짐. 끄면 밤에는 이메일만) */
  nightPush: boolean;
  /** 끝났으면 그 까닭 */
  ended?: AlertEndReason;
}

export const ALERT_KIND_LABEL: Record<AlertKind, string> = { open: '오픈 알림', cancel: '취소표 알림' };
/** 배지 아이콘(키트 ic-이름) */
export const ALERT_KIND_ICON: Record<AlertKind, 'bell' | 'ticket'> = { open: 'bell', cancel: 'ticket' };
/** 보내는 길(채널) 글. 퍼블리싱 단계에서는 모두 웹 푸시·이메일이다 */
export const ALERT_CHANNEL_TEXT = '웹 푸시·이메일';

/** 끝난 까닭 글(d5 §5.28, 추천 적용 2026-10-30). 판매 종료로 끝난 신청에는 [다시 신청]을 두지 않는다 */
export const ALERT_END_TEXT: Record<AlertEndReason, string> = {
  SENT_MAX: '취소표 알림을 5번 보내 신청을 마쳤습니다',
  BOOKED: '이 회차를 예매하셔서 신청을 마쳤습니다',
  SALE_ENDED: '판매가 끝나 신청을 마쳤습니다',
};

export function canResubscribe(s: AlertSubscription): boolean {
  return s.ended !== 'SALE_ENDED';
}

/** 판매가 끝나 공연 목록(production 목업)에서 내려간 공연의 요약. 찜·알림 기록이 함께 가진다(추천안: 지난 공연도 찜 목록에 남긴다) */
export interface PastProductionSnapshot {
  id: string;
  title: string;
  /** 포스터 그림(production 목업의 PosterArt와 같은 값) */
  posterArt: 'lumen' | 'fest' | 'musical' | 'fanmeet' | 'gala' | 'jazz';
  posterShort: string;
  /** 마지막 회차 '9/26(토) 19:00' */
  lastShowText: string;
  venueName: string;
}

export const PAST_PRODUCTIONS: readonly PastProductionSnapshot[] = [
  { id: 'prd-jazz-0926', title: '재즈 나이트', posterArt: 'jazz', posterShort: 'JAZZ', lastShowText: '9/26(토) 19:00', venueName: '피켓 아레나' },
];

/** 찜한 지난 공연 id(지금 판매 목록에 있는 공연의 찜은 me 목업의 likedProductionIds) */
export const LIKED_PAST_PRODUCTION_IDS: readonly string[] = ['prd-jazz-0926'];

/** 오프라인에서 누르고 아직 서버에 저장하지 못한 찜(FR-019 오프라인 대기열, 상태 '오프라인 저장 대기') */
export const PENDING_LIKE_PRODUCTION_IDS: readonly string[] = ['prd-fanmeet', 'prd-fest'];

/** 알림 신청 목록(보드 '알림 신청 탭') */
export const ALERT_SUBSCRIPTIONS: readonly AlertSubscription[] = [
  { id: 'alr-lumen-1025-open', productionId: 'prd-lumen', performanceId: 'evt-lumen-1025', kind: 'open', nightPush: false },
  { id: 'alr-lumen-1026-cancel', productionId: 'prd-lumen', performanceId: 'evt-lumen-1026', kind: 'cancel', nightPush: true },
  { id: 'alr-fanmeet-open', productionId: 'prd-fanmeet', kind: 'open', nightPush: false },
  { id: 'alr-musical-1101-cancel', productionId: 'prd-musical', performanceId: 'evt-musical-1101', kind: 'cancel', nightPush: false, ended: 'SENT_MAX' },
];

/** 끝난 까닭 셋을 모두 보이는 표본(보드 '신청 끝 · 끝난 까닭 셋') */
export const ENDED_ALERT_SUBSCRIPTIONS: readonly AlertSubscription[] = [
  { id: 'alr-lumen-1026-cancel', productionId: 'prd-lumen', performanceId: 'evt-lumen-1026', kind: 'cancel', nightPush: true },
  { id: 'alr-musical-1101-cancel', productionId: 'prd-musical', performanceId: 'evt-musical-1101', kind: 'cancel', nightPush: false, ended: 'SENT_MAX' },
  { id: 'alr-fest-1107-cancel', productionId: 'prd-fest', performanceId: 'evt-fest-1107', kind: 'cancel', nightPush: false, ended: 'BOOKED' },
  { id: 'alr-jazz-0926-cancel', productionId: 'prd-jazz-0926', kind: 'cancel', nightPush: false, ended: 'SALE_ENDED' },
];
