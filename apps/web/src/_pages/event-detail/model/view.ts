// SCR-002 공연 상세: 상태별로 무엇을 보일지(캔버스 보드 SCR-002의 renderVals를 옮겼다). 보드는 E-1 LUMEN 틀로 그렸고,
// 같은 틀을 다른 공연에도 쓴다(정렬 방식·로비 시각 등은 공연 목업 값). 상태 고르기는 데이터 연결 단계에서 걷어 낸다.
import type { Performance } from '@/entities/performance';
import type { Production, SortMode } from '@/entities/production';
import type { Scr002State } from '@/shared/config/screens.discovery';

/** 하단(휴대폰·태블릿)·오른쪽 패널(데스크톱) 예매 버튼의 모양(d5 §5.2 상태 표 ⑦) */
export type CtaKind =
  | 'lobby'
  | 'notYet'
  | 'closed'
  | 'presaleOut'
  | 'queue'
  | 'verify'
  | 'soldOut'
  | 'fifo'
  | 'busy'
  | 'limit'
  | 'guest'
  | 'ended'
  | 'load';

export type RoundsMode = 'pre' | 'onsale' | 'soldout' | 'ended';
export type TiersMode = 'pre' | 'onsale' | 'soldout' | 'ended' | 'error' | 'loading';
export type DetailModal = 'dup' | 'rejoin' | 'guide' | 'refund' | 'seller' | 'revNo' | 'revGuest';

export interface DetailView {
  /** 본문을 그린다(판매 승인 전·판매 중지면 안내만) */
  body: boolean;
  unpublished: boolean;
  suspended: boolean;
  guest: boolean;
  loading: boolean;
  /** 히어로·공연 정보·상세정보(바로가기 탭이 위에 붙은 모습은 이것들을 접은 채로 그린다) */
  showHero: boolean;
  stuck: boolean;
  sortMode: SortMode;
  /** 선착순 공연의 사전 사람 확인 카드 */
  humanCheck: boolean;
  hasLobby: boolean;
  rounds: RoundsMode;
  tiers: TiersMode;
  verified: boolean;
  needVerify: boolean;
  presaleIn: boolean;
  hasReviews: boolean;
  hasDetail: boolean;
  imageFailed: boolean;
  detailOpen: boolean;
  cta: CtaKind;
  modal: DetailModal | null;
}

/** 공연마다 상태를 고르지 않았을 때의 기본(E-1은 보드 기본 '로비 열림', 다른 공연은 판매 상태에서 고른다) */
export function defaultDetailState(p: Production): Scr002State {
  if (p.id === 'prd-lumen') return '로비 열림';
  if (p.status === 'sold_out') return '매진';
  if (p.status === 'ended') return '판매 종료';
  if (p.status === 'on_sale') return '오픈 뒤 진입';
  return p.sortMode === 'FIFO' ? '선착순 공연(사전 사람 확인)' : '로비 열림';
}

const LOBBY_LIKE: readonly Scr002State[] = [
  '로비 열림',
  '다른 기기에서 대기 중',
  '다시 참가 확인',
  '선예매 대상',
  '예매 안내사항 모달',
  '취소·환불 안내사항 모달',
  '판매자 정보 모달',
  '상세정보 펼침',
  '후기 없음',
  '바로가기 탭 붙음',
  '후기 쓰기 자격 없음',
  '후기 쓰기(비로그인)',
  '상세 이미지 실패',
  '상세정보 없음',
];

const MODAL_OF: Partial<Record<Scr002State, DetailModal>> = {
  '다른 기기에서 대기 중': 'dup',
  '다시 참가 확인': 'rejoin',
  '예매 안내사항 모달': 'guide',
  '취소·환불 안내사항 모달': 'refund',
  '판매자 정보 모달': 'seller',
  '후기 쓰기 자격 없음': 'revNo',
  '후기 쓰기(비로그인)': 'revGuest',
};

export function detailView(st: Scr002State, p: Production): DetailView {
  const onSale = st === '오픈 뒤 진입';
  const soldOut = st === '매진';
  const ended = st === '판매 종료';
  const busy = st === '진입 혼잡';
  const seatErr = st === '잔여석 조회 실패';
  const loading = st === '로딩';
  const fifoState = st === '선착순 공연(사전 사람 확인)';
  const guest = st === '비로그인';
  const stuck = st === '바로가기 탭 붙음';
  const onSaleLike = onSale || busy || seatErr || loading;
  const sortMode: SortMode = fifoState ? 'FIFO' : p.sortMode;

  let cta: CtaKind = 'lobby';
  if (loading) cta = 'load';
  else if (LOBBY_LIKE.includes(st)) cta = 'lobby';
  else if (st === '오픈 전(로비 닫힘)') cta = 'closed';
  else if (st === '로비 열림, 이 기기의 버튼은 아직') cta = 'notYet';
  else if (st === '선예매 대상 아님') cta = 'presaleOut';
  else if (onSale || seatErr) cta = 'queue';
  else if (st === '본인확인 필요') cta = 'verify';
  else if (soldOut) cta = 'soldOut';
  else if (fifoState) cta = 'fifo';
  else if (busy) cta = 'busy';
  else if (st === '예매 제한 중') cta = 'limit';
  else if (guest) cta = 'guest';
  else if (ended) cta = 'ended';

  return {
    body: st !== '판매 승인 전·반려' && st !== '판매 중지',
    unpublished: st === '판매 승인 전·반려',
    suspended: st === '판매 중지',
    guest,
    loading,
    showHero: !stuck,
    stuck,
    sortMode,
    humanCheck: fifoState,
    hasLobby: sortMode !== 'FIFO' && Boolean(p.lobbyText),
    rounds: onSaleLike ? 'onsale' : soldOut ? 'soldout' : ended ? 'ended' : 'pre',
    tiers: loading ? 'loading' : seatErr ? 'error' : onSale || busy ? 'onsale' : soldOut ? 'soldout' : ended ? 'ended' : 'pre',
    verified: st !== '본인확인 필요' && !guest && !loading,
    needVerify: st === '본인확인 필요',
    presaleIn: st === '선예매 대상',
    hasReviews: st !== '후기 없음',
    hasDetail: st !== '상세정보 없음',
    imageFailed: st === '상세 이미지 실패',
    detailOpen: st === '상세정보 펼침',
    cta,
    modal: MODAL_OF[st] ?? null,
  };
}

/** 회차 칩 배지(보드: 지금 회차는 상태 배지, 다른 회차는 오픈 전이면 '오픈 예정', 아니면 '판매 중') */
export function roundStatus(mode: RoundsMode, current: boolean): { text: string; tone: 'primary' | 'success' | 'danger' | 'neutral' } {
  if (mode === 'pre') return { text: '오픈 예정', tone: 'primary' };
  if (mode === 'onsale' || !current) return { text: '판매 중', tone: 'success' };
  if (mode === 'soldout') return { text: '매진', tone: 'danger' };
  return { text: '판매 종료', tone: 'neutral' };
}

/** 'HH:MM'(오픈 일시 글의 시각) */
export function timeOf(text: string): string {
  return text.split(' ').pop() ?? text;
}

export interface CtaContext {
  kind: CtaKind;
  title: string;
  perf: Performance;
  production: Production;
  queueHref: string;
  loginHref: string;
  otherRoundHref: string;
  appealHref: string;
}
