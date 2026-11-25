// 월렛 카드·화면 상태의 순수 규칙(FIX-wallet-tickets, docs/frontend.md §4.2.4 '월렛 목록 세부' 상태별 카드·화면 상태, d5 §5.13, O-T52 ②~⑥).
// 저장된 스냅샷(entities/wallet) 하나를 카드 하나로, 저장 수와 받기 결과를 화면 하나로 바꾼다. 저장소·네트워크를 부르지 않아 첫 화면 묶음에 넣어도 가볍다.
// 경로 별칭 없이 읽힌다(node 시험이 바로 읽는다).
import type { WalletTicketSnapshot } from '../../entities/wallet/index.ts';

/** 받기 실패의 까닭: 끊김·시간 초과(network) · 5xx·정의 밖 상태(server) · 모양이 틀린 200(bad-response) · 앞 쪽과 같은 커서(cursor-loop) */
export type WalletSyncFailure = 'network' | 'server' | 'bad-response' | 'cursor-loop';

/** 한 번 받기의 결과(sync.ts syncWallet) */
export type WalletSyncResult =
  | { kind: 'ok'; count: number }
  | { kind: 'unavailable' }
  | { kind: 'needs-login' }
  | { kind: 'failed'; reason: WalletSyncFailure };

/** 카드 배지(frontend §4.2.4 '상태별 카드'의 글 그대로) */
export type WalletBadge = '사용 가능' | '받은 티켓' | '양도 요청 중' | '취소 접수됨' | '환급됨' | '확인 중' | '무효' | '지난 공연';

export interface WalletCard {
  ticketId: string;
  eventId: string;
  /** 공연명. null이면 화면은 "공연 정보를 불러오지 못했습니다" */
  title: string | null;
  placeName: string | null;
  /** 회차 시작(ISO). 요약을 읽었으면 요약 값, 아니면 발권 때 받은 값 */
  startsAt: string | null;
  badge: WalletBadge;
  /** 배지 아래 문장(정본의 따옴표 문장). 없으면 null */
  note: string | null;
  /** QR 자리(이 기기 키가 없으면 입장용 등록 버튼, 등록된 키가 있으면 회전 QR) */
  showQr: boolean;
  /** QR·등록 버튼의 대체 글. 그 표의 티켓 ID를 싣는다(§3.7) */
  qrLabel: string;
  /** 저장된 티켓 상태(돌려주기 버튼이 끝난 표를 가른다) */
  status?: string;
  /** 받은 표인가(SCR-013 돌려주기 버튼) */
  received: boolean;
  /** 받은 표의 보낸 분 가린 닉네임(없으면 '회원') */
  receivedFromNickname?: string | null;
  /** 입장 시작(공개 요약이 알면 그것, 없으면 null). 돌려주기 버튼 경계 */
  entryOpensAt: string | null;
  /** 진행 중인 양도 요청 ID(결제자 표). 있으면 SCR-014 ⑥로 잇는다 */
  pendingOfferId?: string;
}

export type WalletScreen = 'loading' | 'empty' | 'error' | 'list' | 'login';

/** QR 자리가 없는 상태의 배지와 문장(frontend §4.2.4 '상태별 카드') */
const CLOSED: Readonly<Record<'TRANSFER_PENDING' | 'CANCEL_REQUESTED' | 'REFUNDED' | 'FLAGGED' | 'VOIDED', { badge: WalletBadge; note: string | null }>> = {
  TRANSFER_PENDING: { badge: '양도 요청 중', note: null },
  CANCEL_REQUESTED: { badge: '취소 접수됨', note: '입장 기록 마감 뒤 환급됩니다' },
  REFUNDED: { badge: '환급됨', note: null },
  FLAGGED: { badge: '확인 중', note: '현장에서 입장 기록을 확인하고 있습니다' },
  VOIDED: { badge: '무효', note: '입금이 확인되지 않아 티켓이 무효가 되었습니다' },
};

/** QR·등록 버튼 대체 글(데모가 `aria-label^="입장 QR"`로 찾는다) */
export const walletQrLabel = (ticketId: string): string => `입장 QR, 티켓 ${ticketId}, 15초마다 바뀝니다`;

/**
 * 저장된 스냅샷 하나 → 카드. ISSUED·ACTIVE만 QR 자리가 있고, 받은 표는 <받은 티켓>이다.
 * 회차 공개 요약의 공연 종료가 지난 유효 표는 <지난 공연>이고 QR 자리가 없다(종료 시각과 같으면 아직 지나지 않았다)
 */
export function walletCardOf(snapshot: WalletTicketSnapshot, nowMs: number): WalletCard {
  const base = {
    ticketId: snapshot.ticketId,
    eventId: snapshot.eventId ?? '',
    title: snapshot.title ?? null,
    placeName: snapshot.placeName ?? null,
    startsAt: snapshot.startsAt ?? snapshot.eventStartsAt ?? null,
    qrLabel: walletQrLabel(snapshot.ticketId),
    ...(snapshot.status === undefined ? {} : { status: snapshot.status }),
    received: snapshot.received === true,
    ...(typeof snapshot.receivedFromNickname === 'string' ? { receivedFromNickname: snapshot.receivedFromNickname } : {}),
    entryOpensAt: snapshot.entryOpensAt ?? null,
    ...(snapshot.pendingTransfer === undefined ? {} : { pendingOfferId: snapshot.pendingTransfer.offerId }),
  };
  const status = snapshot.status;
  if (status === 'ISSUED' || status === 'ACTIVE' || status === undefined) {
    const ended = snapshot.endsAt !== undefined && Date.parse(snapshot.endsAt) < nowMs;
    if (ended) return { ...base, badge: '지난 공연', note: null, showQr: false };
    return { ...base, badge: snapshot.received ? '받은 티켓' : '사용 가능', note: null, showQr: status !== undefined };
  }
  return { ...base, ...CLOSED[status], showQr: false };
}

/**
 * 저장된 표 수와 받기 결과 → 화면(d5 §5.13 상태 표). 갱신 뒤에도 401이면 저장된 표를 그리지 않고 로그인이다.
 * 저장된 표가 있으면 받는 중에도 그것으로 그리고, 받지 못했으면 저장된 표와 오프라인 배너다. 주소 없는 빌드(unavailable)는 저장된 표로 그린다
 */
export function walletScreenOf(i: { stored: number; sync: 'pending' | WalletSyncResult }): { screen: WalletScreen; offline: boolean } {
  const { stored, sync } = i;
  if (sync !== 'pending' && sync.kind === 'needs-login') return { screen: 'login', offline: false };
  if (stored > 0) return { screen: 'list', offline: sync !== 'pending' && sync.kind === 'failed' };
  if (sync === 'pending') return { screen: 'loading', offline: false };
  if (sync.kind === 'failed') return { screen: 'error', offline: false };
  return { screen: 'empty', offline: false };
}
