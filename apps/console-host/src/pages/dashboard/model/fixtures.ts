// 대시보드 위젯 목업(호스트가 원격 위젯에 넘기는 값, docs/frontend.md §4.5). 값은 보드 SCR-029-d 그대로다(d5 §7.2 '그림의 예시 숫자').
// 데이터 연결 단계에서 위젯이 ConsoleServices.data로 받는 값으로 바뀐다.
import type { AdmissionRateData, CdnEdgeData, EntryThroughputData, QueueFileData, QueueOrderData } from '@peaket/widget-queue';
import type { FunnelData, PaymentBudgetData, PgStatusData, SeatHoldData } from '@peaket/widget-purchase';

const TICKS_560 = [
  { x: 128.7, label: '20:00' },
  { x: 298, label: '20:02' },
  { x: 467.3, label: '20:04' },
];
const TICKS_260 = [
  { x: 65.3, label: '20:00' },
  { x: 177.3, label: '20:03' },
];

export const ENTRY: EntryThroughputData = {
  rps: {
    caption: '지금 4,900건 · 최고 18.1만 건(20:00:15)',
    aria: '대기열 진입 요청량. 오픈 직후 20:00:15에 초당 18만 1천 건으로 최고였고 설계 피크 20만 건 아래였습니다. 지금은 초당 4,900건입니다.',
    points: '44,45.5 86.3,45.3 128.7,44.9 135.7,15.5 149.8,13.1 171,22 213.3,32.5 255.7,38.5 298,41.6 340.3,43.5 382.7,44.4 425,44.8 467.3,45.1 484.3,45.1',
  },
  p99: {
    caption: '지금 93ms · 최고 171ms',
    status: '정상 · 기준 200ms',
    ok: true,
    aria: '대기열 진입 응답 p99. 오픈 직후 최고 171ms로 기준 200ms 아래였고 지금은 93ms입니다.',
    points: '44,31.9 86.3,31.6 128.7,31.3 135.7,21.7 149.8,18.6 171,22.3 213.3,26.6 255.7,28.7 298,29.8 340.3,30.5 382.7,30.8 425,31 467.3,31.1 484.3,31.1',
  },
  serving: {
    caption: '지금 0명(목표 초과로 멈춤) · 기대 5.6명(목표 1,000 ÷ 평균 체류 3분 [가정])',
    aria: '입장 처리량. 20:01부터 초당 27~28명이었고, 20:02:24에 동시 입장 목표를 1,000명으로 낮춘 뒤 예매 단계 인원이 목표를 넘어 지금은 초당 0명입니다. 목표 아래로 내려오면 기대치 초당 5.6명 안팎으로 다시 전진합니다.',
    points: '44,46 128.7,46 135.7,38 149.8,26 171,16 213.3,10.5 255.7,9.3 298,9 331.9,9.2 336.1,40 340.3,46 484.3,46',
    expectedLabel: '기대 5.6명/초',
    marker: { x: 331.9, label: '명령 1 · 1,000명' },
  },
  nowX: 484.3,
  nowLabel: '지금 20:04:12',
  ticks: TICKS_560,
};

export const QUEUE_FILE: QueueFileData = {
  p99: '1.3초',
  ok: true,
  status: '정상 · 기준 2초',
  meta: '파일 1초마다 갱신 · 엣지 캐시 1초',
  chart: {
    aria: '대기 상태 파일 신선도 p99. 셔플 결과 게시 때 1.7초까지 올랐다가 지금 1.3초로 기준 2초 아래입니다.',
    points: '28,30.6 65.3,30.6 74.7,20.1 84,23.6 102.7,27.1 140,28.9 177.3,27.1 222.1,27.1',
    nowX: 222.1,
    ticks: TICKS_260,
  },
  steps: [
    { label: '로비 셔플', value: '완료 20:00:01', state: 'ok' },
    { label: '셔플 결과 파일 게시', value: '완료 20:00:09', state: 'ok' },
    { label: '결과 조회 분산', value: '0~8초', state: 'muted' },
  ],
};

export const CDN: CdnEdgeData = {
  status: { text: '정상', ok: true },
  hitRate: '98.4%',
  statusQps: '4.1만',
  rows: [
    { label: '오리진 도달', value: '초당 640건 · 설계 1,000건 이하', num: true },
    { label: '엣지 5xx 비율', value: '0.01%', num: true },
    { label: '폴링 주기', value: '0.5·5·20초, 지터' },
  ],
  limits: [
    { label: '공연 페이지', pct: 12 },
    { label: '대기열 파일', pct: 41 },
    { label: '대기열 API', pct: 9 },
  ],
};

export const SEAT_HOLD: SeatHoldData = {
  p99: '41ms',
  level: 'burning',
  status: '경고: 에러 버짓 3.2× 속도로 소진 중',
  meta: '기준 p99 50ms · 가용성 99.95% · 경합 패배(409)는 오류로 세지 않음',
  burn: {
    now: '3.2×',
    aria: '좌석 홀드 에러 버짓 소진 배수(5분 창). 20:03 무렵 SEV2 기준 3배를 넘어 지금 3.2배이고 SEV1 기준 10배 아래입니다. SEV2 경보는 20:03:41에 울렸습니다.',
    points: '68.4,50 84,48.5 102.7,47.4 121.3,46.7 140,44.9 158.7,41.9 177.3,39.4 196,37.9 214.7,37.5 222.1,38.3',
    alertX: 202.8,
    alertY: 37.7,
    nowX: 222.1,
    ticks: TICKS_260,
  },
};

export const PAY_BUDGET: PaymentBudgetData = {
  successRate: '99.97%',
  ok: true,
  status: '정상 · 기준 99.95%',
  meta: '확정 p99 2.1초 · 기준 3초',
  journeys: [
    { name: '결제 확정', label: '결제 확정 12건 중 3건 사용', remain: '남음 9건', pct: 25, strong: true },
    { name: '좌석 홀드', label: '좌석 홀드 75건 중 16건 사용', remain: '남음 59건', pct: 21, strong: true, burning: true },
    { name: '대기열 진입', label: '대기열 진입 2,000건 중 186건 사용', remain: '남음 1,814건', pct: 9 },
    { name: '공연 상세', label: '공연 상세 1,000건 중 41건 사용', remain: '남음 959건', pct: 4 },
  ],
};

export const FUNNEL: FunnelData = {
  steps: [
    { label: '입장', text: '4,960', width: 300 },
    { label: '첫 홀드 성공', text: '1,402 · 28.3%', width: 84.8 },
    { label: '결제 접수', text: '818 · 58.3%', width: 49.5 },
    { label: '승인', text: '793 · 96.9%', width: 48 },
    { label: '발권', text: '790 · 99.6%', width: 47.8 },
  ],
  aria: '퍼널. 입장 4,960, 첫 홀드 성공 1,402(앞 단계 대비 28.3%), 결제 접수 818(58.3%), 승인 793(96.9%), 발권 790(99.6%).',
  conversion: { headline: '입장 → 구매 전환율 16.0%', detail: '승인 793 ÷ 입장 4,960 · 마감(R1)에서 확정합니다' },
};

const ADMISSION_BASE = { rate: '92%', coming: '24명', soon: '30명', soonP99: '3.8초' };

export const ADMISSION: AdmissionRateData = {
  ...ADMISSION_BASE,
  vacancy: { value: '118자리', meta: '동시 입장 목표 1,500명 − 예매 단계 인원 1,382명' },
  formula: '자동 제어가 보는 값과 같습니다(잠정 아님). serving 증가 = (빈자리 118 − 곧 입장 대기 30 − 오는 중 24) ÷ 입장 비율 0.92 ≈ 70',
};

/** 버짓 50%·100% 소진: 목표가 1,000명으로 내려가 빈자리가 0이다 */
export const ADMISSION_BUDGET: AdmissionRateData = {
  ...ADMISSION_BASE,
  vacancy: { value: '0자리', meta: '동시 입장 목표 1,000명 − 예매 단계 인원 1,382명 · 목표 아래로 내려올 때까지 새 입장을 멈춥니다' },
  formula: '자동 제어가 보는 값과 같습니다(잠정 아님). 빈자리가 0이라 serving 번호를 올리지 않습니다. 예매 단계 인원이 1,000명 아래로 내려오면 다시 올립니다',
};

export const PG: PgStatusData = {
  primary: { name: '토스페이먼츠(기본)', approval: '99.6%', callP99: '1.2초', confirmP99: '2.3초', limitUse: '64%', overLimit: '0건', state: { text: '기본' } },
  fallback: { name: '포트원(대체)', status: '대기 · 전환 후보 없음' },
};

/** 자동 조치 걸림: 결제 신규 진입 정지(자동, ADR-0078) */
export const PG_AUTO: PgStatusData = { ...PG, primary: { ...PG.primary, state: { text: '신규 진입 정지(자동)', warning: true } } };

export const ORDER: QueueOrderData = { beforeTurn: '0건', failedAfterTurn: '3명', etaError: '1.1배' };

/** 숨겼다가 돌아옴: 위젯마다 마지막 값과 'n초 전'(5초 넘음 → warning) */
export const BACK_FRESHNESS = { text: '52초 전', stale: true } as const;
