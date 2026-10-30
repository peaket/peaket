// 공연 등록 위저드 목업(보드 SCR-021-m·t·d·xl의 예시 값 그대로). 공연·공연장·판매자 이름은 entities에서 읽고, 입력 칸의 값만 여기에 둔다.
// 새 공연 초안은 LUMEN 콘서트 2026 서울, 고치는 화면은 보드처럼 가을 야외 페스티벌(선착순·자동 배정·1인 한도 2매)이다.
// 회차 날짜 '11/7(토) [시각]'은 보드 자리 표시 그대로다(entities의 11/14와 다르다 — 보드 우선).

export const WIZARD_STEPS = ['기본 정보', '회차·가격·입장 정책', '좌석맵', '판매 정책', '판매자 정보·승인 요청'] as const;

export const GENRES = ['콘서트', '뮤지컬', '연극', '클래식', '페스티벌', '팬미팅', '기타'] as const;

export const draft = {
  title: 'LUMEN 콘서트 2026 서울',
  venueName: '피켓 아레나',
  artistName: 'LUMEN',
  genre: '콘서트',
  runtimeMin: 120,
  producer: '(주)스텔라엔터테인먼트',
  aliases: ['LUMEN CONCERT 2026 SEOUL'],
  aliasMax: 5,
  descriptionCounter: '남은 글자 1,918자',
  autosavedAt: { s1: '14:31:40 KST', s2: '14:32:05 KST', s5: '14:36:12 KST' },
};

export const media = {
  poster: { id: 'img-poster', fileName: 'lumen-poster.jpg', alt: 'LUMEN 콘서트 2026 서울 포스터. 남색 바탕에 빛나는 흰 원과 동심원 무늬' },
  detail: { id: 'img-detail-1', fileName: 'lumen-detail-01.jpg', progress: 64 },
  /** d5 §6.4 이미지 기준 위반 예 */
  rejected: { id: 'img-detail-2', fileName: 'lumen-teaser.gif', error: '움직이는 이미지는 올릴 수 없습니다' },
};

/** 공연예술통합전산망 10개 항목(공연법 시행규칙 §2) */
export const kopisRows: readonly { item: string; source: string; status: '입력됨' | '입력 필요' | '자동' | '비어 있음' }[] = [
  { item: '공연 명칭·종류', source: '1단계 공연명·장르', status: '입력됨' },
  { item: '기간·장소', source: '2단계 회차, 1단계 공연장', status: '입력 필요' },
  { item: '시간', source: '2단계 공연 시작, 러닝타임', status: '입력 필요' },
  { item: '예매·결제 금액', source: '판매 뒤 자동 집계', status: '자동' },
  { item: '관람자 수', source: '판매 뒤 자동 집계', status: '자동' },
  { item: '관람 가능 연령', source: '1단계 관람 연령', status: '입력 필요' },
  { item: '출연진·제작진·기획사·제작사', source: '1단계 아티스트, 기획사·제작사', status: '입력됨' },
  { item: '좌석 등급·요금', source: '2단계 가격 등급', status: '입력 필요' },
  { item: '입장권 판매처', source: 'PEAKET', status: '자동' },
  { item: '안내 사항', source: '1단계 안내 사항', status: '비어 있음' },
];

export interface DraftRound {
  no: number;
  title: string;
  start: string;
  entry: string;
  end: string;
  open: string;
  lobbyMin: number;
}

export const draftRounds: readonly DraftRound[] = [
  { no: 1, title: '10/25(일) 18:00 KST', start: '10/25(일) 18:00', entry: '10/25(일) 16:30', end: '10/25(일) 20:00', open: '10/14(수) 04:00', lobbyMin: 10 },
  { no: 2, title: '10/26(월) 17:00 KST', start: '10/26(월) 17:00', entry: '10/26(월) 15:30', end: '10/26(월) 19:00', open: '10/14(수) 19:45', lobbyMin: 10 },
];

export const tiers: readonly { id: string; name: string; price: string }[] = [
  { id: 'tier-r', name: 'R석', price: '154,000' },
  { id: 'tier-s', name: 'S석', price: '132,000' },
  { id: 'tier-a', name: 'A석', price: '110,000' },
];

/** 4단계 대기열 정렬 방식(ADR-0118: 회차 정렬 설정 두 값) */
export const queueModes = [
  {
    value: 'HYBRID',
    label: '하이브리드',
    desc: '기본값: 하이브리드(오픈 전 무작위 + 오픈 후 도착 순)',
    flags: '로비 셔플 켬 · 오픈 직후 묶음 켬',
    preview: '오픈 전에 들어온 분은 오픈 시각에 무작위로 순번을 받습니다. 일찍 들어와도 유리하지 않습니다. 오픈 후에 오신 분은 그 뒤에 도착 순으로 섭니다.',
  },
  {
    value: 'PREQUEUE_SHUFFLE',
    label: '사전 셔플',
    desc: '오픈 전 로비에 들어온 분만 오픈 시각에 무작위로 순번을 받고, 오픈 뒤에 온 분은 그 뒤에 도착 순으로 섭니다(동시 도착 묶음 없음). 팬클럽 선예매처럼 대기실 참가를 미리 모을 때 씁니다',
    flags: '로비 셔플 켬 · 오픈 직후 묶음 끔',
    preview: '오픈 전에 들어온 분은 오픈 시각에 무작위로 순번을 받습니다. 오픈 후에 오신 분은 그 뒤에 도착 순으로 섭니다.',
  },
  {
    value: 'FIFO',
    label: '선착순',
    desc: '로비 없이 도착 순으로 순번을 받습니다. 오픈 직후 동시에 도착한 분들은 묶어서 무작위로 정합니다. 고르면 매크로 취약 경고가 함께 보입니다',
    flags: '로비 셔플 끔 · 오픈 직후 묶음 켬',
    preview: '오픈 직후 2초 안에 도착한 분들은 같은 시각에 온 것으로 보고 무작위로 순서를 정합니다. 그 뒤에 오신 분은 도착 순으로 섭니다. 순서를 정하는 동안에는 순번이 보이지 않습니다',
  },
] as const;

export type QueueModeValue = (typeof queueModes)[number]['value'];

/** POL-004 선착순 경고(추천 적용 2026-10-28, 기술 검토 낮음-146) */
export const FIFO_WARNING =
  '선착순은 빠른 매크로에 취약합니다. 오픈 직후 동시 도착 구간 묶음이 적용되며, 추첨(하이브리드)을 권장합니다. 오픈 직후 약 20초 안에 순번이 정해지고, 그 뒤 차례대로 입장합니다';

export const WHEELCHAIR_REASONS = [
  '공연장이 완화된 기준을 승인받았습니다(장애인등편의법 §15)',
  '공연장이 휠체어석 설치 권장 시설입니다(체육관·운동장·야외 공연장 등)',
  '무대 설치 등으로 이 공연에서 쓸 수 없는 휠체어석이 있습니다',
  '기타(직접 입력, 500자 이하)',
] as const;

/** 고치는 화면(가을 야외 페스티벌) */
export const edit = {
  changed: '1인 한도 2매 → 4매',
  requestedAt: '10/14(수) 14:40 KST',
  limitPublished: 2,
  limitRequested: 4,
  round: { title: '1회차 · 11/7(토) [시각] KST', open: '[오픈 시각] KST · 오픈함', lobby: '없음(선착순 공연)', start: '11/7(토) [시각]' },
  suspendReason: '판매자 신원 확인 필요',
};

/** 휴대폰 읽기 전용 요약(보드 SCR-021-m, LUMEN 콘서트 2026 서울) */
export const summary = {
  approvedAt: '10/8(목)',
  scale: '대형',
  rejectReason: '통신판매업 신고번호 누락',
  rejectedAt: '10/12(월) 11:05 KST',
  reRequestedAt: '10/15(목) 10:20 KST',
  rounds: [
    { when: '10/25(일) 18:00 KST', meta: '입장 시작 16:30 · 종료 예정 20:00 · 재입장 불허' },
    { when: '10/26(월) 17:00 KST', meta: '입장 시작 15:30 · 종료 예정 19:00 · 재입장 불허' },
  ],
  openAt: '10/14(수) 20:00 KST',
  lobby: '오픈 10분 전(19:50)',
  seatmap: [
    ['공연장', '피켓 아레나 · 1층'],
    ['총 좌석', '2,400석 · 구역 6'],
    ['등급별', 'R 600 · S 900 · A 900'],
    ['휠체어석', '20석(A석에 포함)'],
    ['입장 게이트 구역', '동문·서문'],
  ] as const,
  policyRules: '2개 · 팬클럽 선예매, 일반 예매',
};
