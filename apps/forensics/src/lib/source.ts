// 포렌식 리플레이의 데이터 원천(합성·조사·연구)과 원천마다 보일 자리·고정 문구·상태 목록(d5 §7.17, docs/features/forensic-replay.md §2.1·§2.2,
// OpenSpec add-fraud-investigation-screens design.md 결정 7). 정본은 '연 길이 원천을 정한다'(§4.2·§6.8)이고,
// 화면 퍼블리싱에서는 연 길 대신 ?source=조사|연구로 고른다(없으면 합성). 한 화면에는 원천 하나뿐이고 화면 안에서 바꾸지 못한다.
// Node 내장 시험 실행기가 이 파일을 그대로 읽는다(source.test.mjs). 그래서 실행 import를 두지 않고 지울 수 있는 타입 문법만 쓴다.
import type { ReplaySource, replaySourceLabel } from '@peaket/ds/ReplaySourceBadge';
import type { Layout } from './layout';

export type Source = ReplaySource;

export const SOURCES = ['synthetic', 'investigation', 'research'] as const satisfies readonly Source[];

/** 주소 값(?source=). 합성은 값을 두지 않는다 */
const PARAM: Record<Source, string | undefined> = { synthetic: undefined, investigation: '조사', research: '연구' };

export function sourceParam(source: Source): string | undefined {
  return PARAM[source];
}

/** ?source=조사 → 조사, ?source=연구 → 연구, 그 밖(없음·모르는 값)은 합성 */
export function parseSource(search: string | URLSearchParams): Source {
  const raw = (typeof search === 'string' ? new URLSearchParams(search) : search).get('source');
  if (raw === PARAM.investigation) return 'investigation';
  if (raw === PARAM.research) return 'research';
  return 'synthetic';
}

/** 원천 배지 글자. ds 부품(CMP-082)의 글자와 다르면 타입 검사가 막는다 */
const BADGE = { investigation: '조사', research: '연구', synthetic: '합성 데이터' } as const satisfies typeof replaySourceLabel;

const NOTICE_BOT = '후보 찾기용입니다. 봇 판정은 표본 검토(SCR-067)와 정해진 규칙(POL-006)으로 합니다.';
const NOTICE_INVESTIGATION = '후보 찾기용입니다. 조치는 사건 작업대에서 소명과 승인을 거쳐 합니다(POL-046).';

/** 조사·연구 원천의 목업 회차(관제 목업 LUMEN 1회차와 같다) */
const EVENT = 'LUMEN 콘서트 2026 서울 · 10/25(일) 18:00';
const COPY_OPERATING = '이 탭은 교차 출처 격리를 켜지 않아 복사 방식으로 동작합니다. 결과는 같고 반응이 조금 늦을 수 있습니다';

export type CandidateKind = 'scatter' | 'baseline' | 'distribution';

export interface SourceSpec {
  source: Source;
  /** 원천 배지 글자(CMP-082) */
  badge: string;
  /** 화면 제목(h1, 화면 낭독기용). 원천을 넣는다(CMP-082 접근성) */
  title: string;
  /** 후보 패널에 늘 두는 고정 문구(forensic-replay §2.1) */
  notice: string;
  /** 머리 안내 글(조사·연구) */
  headerNote?: string;
  /** 머리의 회차(조사·연구) */
  event?: string;
  /** 머리의 사건(조사) */
  caseLabel?: string;
  /** 머리의 시간창(조사·연구) */
  window?: string;
  /** 머리 끝 ( 관제 콘솔 › )이 가는 관제 경로(조사·연구) */
  consolePath?: string;
  /** 시나리오 ▾·시드·[다시 만들기]·[파일 불러오기]·[이 시나리오 내려받기]·공유 주소 복사(합성만, §6.8) */
  synthControls: boolean;
  /** 정밀도·재현율과 그 경고(정답이 있는 합성만) */
  precisionRecall: boolean;
  /** 교차 필터: 봇 등급(합성 정답)·네트워크 유형(합성만), 묶음(조사만) */
  filters: { botGrade: boolean; network: boolean; group: boolean };
  /** 후보 패널: 산점도(CMP-079) · 단계별 시간 대 정상 기준선(CMP-083) · 한 축 분포(CMP-079 한 축) */
  candidate: CandidateKind;
  /** 후보 패널 제목 */
  candidateTitle: string;
  /** 기기 묶음 목록(연구에는 기기 묶음이 없다, §6.3) */
  deviceGroups: boolean;
  /** 묶음 계정 좌석·게시물 대조 좌석 점등(조사, §4.2 member·post_seat) */
  seatMarks: boolean;
  /** 원천 만료 문구(조사·연구) */
  expired?: string;
  /** '후보 고름'에서 교차 필터에 적는 고른 영역 */
  pickedArea: string;
  /** 파일 거절 띠의 이유 한 줄 */
  rejectReason: string;
  /** 파일 거절 때 좌석맵 자리 안내 */
  rejectHint: string;
  /** 복사 방식 띠 */
  copyNote: string;
}

const SPECS: Record<Source, SourceSpec> = {
  synthetic: {
    source: 'synthetic',
    badge: BADGE.synthetic,
    title: '포렌식 리플레이 · 합성 데이터 데모',
    notice: NOTICE_BOT,
    synthControls: true,
    precisionRecall: true,
    filters: { botGrade: true, network: true, group: false },
    candidate: 'scatter',
    candidateTitle: '봇 후보',
    deviceGroups: true,
    seatMarks: false,
    pickedArea: '산점도 영역(100ms 안, 엔트로피 0.24 아래)',
    rejectReason: '앞뒤 매직 ARROW1이 없습니다. 아무것도 그리지 않았습니다',
    rejectHint: '프리셋을 고르거나 다른 파일을 불러오세요',
    copyNote: '이 공개 위치는 교차 출처 격리를 켜지 않아 복사 방식으로 동작합니다. 결과는 같고 반응이 조금 늦을 수 있습니다',
  },
  investigation: {
    source: 'investigation',
    badge: BADGE.investigation,
    title: '포렌식 리플레이 · 조사 원천',
    notice: NOTICE_INVESTIGATION,
    headerNote: '조사용 기록 · 이 탭에만 있고 내려받지 않습니다',
    event: EVENT,
    caseLabel: '사건 CASE-2610-0007',
    window: '시간창 T−10:00 ~ T+20:00',
    consolePath: '/investigations/CASE-2610-0007',
    synthControls: false,
    precisionRecall: false,
    filters: { botGrade: false, network: false, group: true },
    candidate: 'baseline',
    candidateTitle: '후보 · 단계별 시간 대 정상 기준선',
    deviceGroups: true,
    seatMarks: true,
    expired: '이 회차의 조사용 기록은 보존 기간이 지났습니다. 증거 묶음만 볼 수 있습니다',
    pickedArea: '기준선 칸(묶음 계정 #3 · 입장 확정 → 첫 홀드)',
    rejectReason: '받은 파일의 원천이 이 탭을 연 길(사건 작업대 · 조사 원천)과 다릅니다. 아무것도 그리지 않았습니다',
    rejectHint: '사건 작업대에서 리플레이를 다시 열어 주세요',
    copyNote: COPY_OPERATING,
  },
  research: {
    source: 'research',
    badge: BADGE.research,
    title: '포렌식 리플레이 · 연구 원천',
    notice: NOTICE_BOT,
    headerNote: '가명 기록 · 30분 동안 쓰지 않으면 지워짐',
    event: EVENT,
    window: '시간창 T+00:00 ~ T+30:00',
    consolePath: '/dashboard',
    synthControls: false,
    precisionRecall: false,
    filters: { botGrade: false, network: false, group: false },
    candidate: 'distribution',
    candidateTitle: "후보 · '입장 확정 → 첫 홀드' 분포",
    deviceGroups: false,
    seatMarks: false,
    expired: '이 회차의 가명 기록은 보존 기간(90일)이 지났습니다',
    pickedArea: '분포 구간(10ms~100ms)',
    rejectReason: '받은 파일의 원천이 이 탭을 연 길(연구 메뉴 · 연구 원천)과 다릅니다. 아무것도 그리지 않았습니다',
    rejectHint: '연구 메뉴에서 리플레이를 다시 열어 주세요',
    copyNote: COPY_OPERATING,
  },
};

/** 연 길이 넘긴 사건·회차(?case=·?event=). 꼴에 맞지 않는 값은 버린다(관제 링크 경로를 바꾸지 못하게) */
export interface Opened {
  caseId: string | null;
  eventId: string | null;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/** 목업 회차 이름(관제 목업과 같다). 모르는 회차는 ID를 그대로 적는다 */
const EVENT_LABEL: Record<string, string> = { 'evt-lumen-2026-r1': EVENT };

export function parseOpened(search: string | URLSearchParams): Opened {
  const p = typeof search === 'string' ? new URLSearchParams(search) : search;
  const pick = (k: string) => {
    const v = p.get(k);
    return v !== null && ID.test(v) ? v : null;
  };
  return { caseId: pick('case'), eventId: pick('event') };
}

/** 원천의 보일 자리. 조사·연구는 연 길이 넘긴 사건·회차를 머리·받는 중 글·관제 링크에 쓴다(없으면 목업 기본 사건) */
export function sourceSpec(source: Source, opened: Opened = { caseId: null, eventId: null }): SourceSpec {
  const base = SPECS[source];
  if (source === 'synthetic') return base;
  const event = opened.eventId ? (EVENT_LABEL[opened.eventId] ?? `회차 ${opened.eventId}`) : base.event;
  if (source === 'research') return { ...base, event };
  const caseId = opened.caseId ?? 'CASE-2610-0007';
  return { ...base, event, caseLabel: `사건 ${caseId}`, consolePath: `/investigations/${caseId}` };
}

// ── 상태(d5 §7.17 상태 표, forensic-replay §2.2) ──

export const DEFAULT_STATE = '재생';
/** 지정이 없을 때(서버 403 investigator-required·pseudonym-handler-required). 예전 이름은 '권한 없음(2단계)' */
export const DENY_STATE = '권한 없음(지정 없음)';
export const DENY_TITLE = '이 화면을 볼 권한이 없습니다';
export const DENY_BODY = '조사 원천은 부정 거래 조사관, 연구 원천은 가명정보 취급자 지정이 있어야 엽니다';
/**
 * 연구 내보내기 403 pseudonymization-review-pending(연구 원천만, d5 §9.2, ADR-0173 결정 8). 가명처리 적정성 검토 결과서가 승인되기 전이라
 * 받을 기록이 없다. 상태 이름은 오류 응답 꼴(OpenSpec apply-legal-review-to-screens design.md 결정 3)
 */
export const REVIEW_PENDING_STATE = '오류 · pseudonymization-review-pending';
export const REVIEW_PENDING_BODY = '가명처리 적정성 검토 결과서가 승인되기 전이라 내보낼 수 없습니다. 개인정보 보호책임자에게 검토를 요청해 주세요';

/** 합성은 공개 데모라 권한 없음이 없다. 만드는 중·시나리오 상태는 합성에만 있다 */
const WIDE: Record<Source, readonly string[]> = {
  synthetic: [
    '재생',
    '후보 고름',
    '만드는 중',
    '파일 거절',
    '복사 방식',
    '그래픽 대체',
    '돌릴 수 없음',
    '사건 일부 버림',
    '일시정지',
    '시나리오 고르기',
    '스포츠 플레이오프 오픈',
    '사람 흉내 봇 · 후보 고름',
  ],
  // 조사는 산점도 대신 기준선 그림(CMP-083)이라 그래픽 대체가 없다
  investigation: ['재생', '후보 고름', '받는 중', '파일 거절', '사건 일부 버림', '복사 방식', '돌릴 수 없음', '일시정지', '원천 만료', DENY_STATE],
  research: ['재생', '후보 고름', '받는 중', '파일 거절', '사건 일부 버림', '복사 방식', '그래픽 대체', '돌릴 수 없음', '일시정지', '원천 만료', REVIEW_PENDING_STATE, DENY_STATE],
};

/**
 * 휴대폰 보드(SCR-069-m)에 자리가 없는 상태. 교차 필터·후보 패널은 '태블릿이나 데스크톱에서 봅니다' 카드이고(d5 §3.9),
 * 상태 띠의 복사 방식도 보드에 없다. 합성의 파일 거절은 파일 불러오기가 휴대폰 머리에 없어서 빠지고,
 * 조사·연구의 파일 거절은 받은 파일이 연 길과 다를 때라 휴대폰에도 있다.
 */
const NOT_ON_PHONE: Record<Source, readonly string[]> = {
  synthetic: ['후보 고름', '파일 거절', '복사 방식', '그래픽 대체', '사람 흉내 봇 · 후보 고름'],
  investigation: ['후보 고름', '복사 방식'],
  research: ['후보 고름', '복사 방식', '그래픽 대체'],
};

const PHONE: Record<Source, readonly string[]> = {
  synthetic: WIDE.synthetic.filter((s) => !NOT_ON_PHONE.synthetic.includes(s)),
  investigation: WIDE.investigation.filter((s) => !NOT_ON_PHONE.investigation.includes(s)),
  research: WIDE.research.filter((s) => !NOT_ON_PHONE.research.includes(s)),
};

/** 이 원천·배치의 상태 고르기 목록. 첫 값이 기본 상태다 */
export function statesFor(source: Source, layout: Layout): readonly string[] {
  return layout === 'phone' ? PHONE[source] : WIDE[source];
}

/**
 * 다른 원천으로 가는 검색 문자열(개발용 원천 링크). theme 같은 다른 값은 남기고,
 * state는 그 원천에 있는 상태일 때만 남긴다(없으면 기본 상태로 연다).
 */
export function sourceSearch(search: string, target: Source): string {
  const params = new URLSearchParams(search);
  const p = PARAM[target];
  if (p === undefined) params.delete('source');
  else params.set('source', p);
  const st = params.get('state');
  if (st !== null && !WIDE[target].includes(st)) params.delete('state');
  const q = params.toString();
  return q ? `?${q}` : '';
}
