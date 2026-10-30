// SCR-010 상태 → 화면 표시(캔버스 보드 SCR-010-m·t·d의 renderVals()를 옮겼다). 세 보드의 분기는 같고 글자만 조금 다르다.
import type { WebShellHold } from '@peaket/ds/WebShell';
import type { SeatScene } from '@/entities/seat';
import type { Scr010State } from '@/shared/config/screens.booking';

/** 지도 확대 단계: overview(전체 배치) · mid(확대 중간) · seats(좌석이 보임) · loading(구역 외곽선만) */
export type MapLevel = 'overview' | 'mid' | 'seats' | 'loading';

export interface SeatsView {
  state: Scr010State;
  /** 자동 배정(AUTO) 화면 */
  auto: null | 'result' | 'assigning' | 'failed' | 'wish-error';
  /** 직접 고르기 화면(지도·목록) */
  pick: boolean;
  /** 구매 세션 끝 · 세션 무효 */
  gone: null | 'ended' | 'invalid';
  /** 위쪽 배너 */
  banner: null | 'degraded' | 'reconnecting' | 'sale-paused' | 'sale-ended' | 'hold-expired' | 'notice';
  map: MapLevel | null;
  list: boolean;
  scene: SeatScene;
  /** 좌석 정보 팝오버(확대 — 좌석) */
  popover: boolean;
  lost: boolean;
  recent: boolean;
  /** 범례: 구역(전체 배치) 또는 좌석 상태(확대) */
  legend: 'zone' | 'seat';
  /** 아래 요약: 고른 좌석 · 빈 요약 · 홀드한 좌석 */
  summary: null | 'pick' | 'empty' | 'hold';
  overLimit: boolean;
  /** 홀드 버튼이 막힌 이유(판매 일시정지·판매 종료) */
  holdBlocked: null | { text: string; danger: boolean };
  /** 1분 전 sr 알림 */
  oneMinute: boolean;
  /** 연장을 이미 했다 */
  extended: boolean;
  /** 무활동 경고 대화상자 */
  idle: boolean;
  /** 집중 머리의 홀드 타이머 */
  hold: WebShellHold | null;
}

const AUTO_STATES: Partial<Record<Scr010State, SeatsView['auto']>> = {
  '자동 배정 결과': 'result',
  '배정 중(자동 배정)': 'assigning',
  '배정 실패(자동 배정)': 'failed',
  '희망 조건 오류(자동 배정)': 'wish-error',
};

const BANNERS: Partial<Record<Scr010State, NonNullable<SeatsView['banner']>>> = {
  '실시간 반영 지연': 'degraded',
  '실시간 연결 복구 중': 'reconnecting',
  '판매 일시정지': 'sale-paused',
  '판매 종료': 'sale-ended',
  '홀드 만료': 'hold-expired',
  '운영 공지': 'notice',
};

export function seatsView(state: Scr010State): SeatsView {
  const auto = AUTO_STATES[state] ?? null;
  const gone = state === '구매 세션 끝' ? 'ended' : state === '세션 무효' ? 'invalid' : null;
  const oneMinute = state === '홀드 1분 전';
  const extended = state === '연장 뒤';
  const holdLike = oneMinute || extended;
  const lost = state === '경합 패배';
  const recent = state === '방금 놓은 좌석';
  const list = state === '목록으로 보기';
  const loading = state === '로딩';
  const holdExpired = state === '홀드 만료';
  const zoneLevel = state === '전체 배치' || state === '확대 중간' || state === '운영 공지';
  const seatLevel = !auto && !list && !zoneLevel && !loading && !gone;
  const salePaused = state === '판매 일시정지';
  const saleEnded = state === '판매 종료';

  let map: MapLevel | null = null;
  if (!auto && !list && !gone) map = seatLevel ? 'seats' : loading ? 'loading' : state === '확대 중간' ? 'mid' : 'overview';

  let summary: SeatsView['summary'] = null;
  if ((seatLevel || list) && !holdLike && !lost && !holdExpired && !recent) summary = 'pick';
  else if (zoneLevel || loading || lost || holdExpired || recent) summary = 'empty';
  else if (holdLike) summary = 'hold';

  let hold: WebShellHold | null = null;
  if (oneMinute) hold = { text: '0:58', ariaLabel: '홀드 남은 시간 58초', tone: 'warning' };
  else if (extended) hold = { text: '3:58', ariaLabel: '홀드 남은 시간 3분 58초' };
  else if (auto === 'result') hold = { text: '6:59', ariaLabel: '홀드 남은 시간 6분 59초' };

  return {
    state,
    auto,
    pick: !auto && !gone,
    gone,
    banner: BANNERS[state] ?? null,
    map,
    list,
    scene: lost ? 'lost' : holdExpired ? 'free' : recent ? 'recent' : 'pick',
    popover: state === '확대 — 좌석',
    lost,
    recent,
    legend: seatLevel || list ? 'seat' : 'zone',
    summary,
    overLimit: state === '한도 초과',
    holdBlocked: salePaused
      ? { text: '판매가 잠시 멈췄습니다. 고른 좌석은 홀드 시간 동안 유지됩니다', danger: true }
      : saleEnded
        ? { text: '판매 시간이 끝나 좌석을 새로 고를 수 없습니다', danger: false }
        : null,
    oneMinute,
    extended,
    idle: state === '무활동 경고',
    hold,
  };
}

/** 지도 확대·축소 버튼이 가는 상태(퍼블리싱 흉내: 전체 배치 ↔ 확대 중간 ↔ 확대 — 좌석) */
export function zoomTargets(level: MapLevel | null): { zoomIn: Scr010State; zoomOut: Scr010State; fit: Scr010State } {
  if (level === 'seats') return { zoomIn: '확대 — 좌석', zoomOut: '확대 중간', fit: '전체 배치' };
  if (level === 'mid') return { zoomIn: '확대 — 좌석', zoomOut: '전체 배치', fit: '전체 배치' };
  return { zoomIn: '확대 중간', zoomOut: '전체 배치', fit: '전체 배치' };
}
