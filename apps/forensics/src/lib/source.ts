// 포렌식 리플레이의 데이터 원천(합성·조사·연구)과 원천마다 보일 자리·고정 문구·상태 목록(d5 §7.17, docs/features/forensic-replay.md §2.1·§2.2,
// OpenSpec add-fraud-investigation-screens design.md 결정 7). 정본은 '연 길이 원천을 정한다'(§4.2·§6.8)이고,
// 화면 퍼블리싱에서는 연 길 대신 ?source=조사|연구로 고른다(없으면 합성). 한 화면에는 원천 하나뿐이고 화면 안에서 바꾸지 못한다.
// Node 내장 시험 실행기가 이 파일을 그대로 읽는다(source.test.mjs). 그래서 실행 import를 두지 않고 지울 수 있는 타입 문법만 쓴다.
// 원천별 문구는 source-specs/로 나눴다. 운영 빌드는 operating.ts가 조사·연구 spec만 가져와 합성 spec을 묶지 않는다(F-04-16).
import type { Layout } from './layout';
import { EVENT_LABEL, type Source, type SourceSpec } from './source-spec.ts';
import { syntheticSpec } from './source-specs/synthetic.ts';
import { investigationSpec } from './source-specs/investigation.ts';
import { researchSpec } from './source-specs/research.ts';

export type { Source, SourceSpec, CandidateKind } from './source-spec.ts';

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

const SPECS: Record<Source, SourceSpec> = { synthetic: syntheticSpec, investigation: investigationSpec, research: researchSpec };

/** 연 길이 넘긴 사건·회차(?case=·?event=). 꼴에 맞지 않는 값은 버린다(관제 링크 경로를 바꾸지 못하게) */
export interface Opened {
  caseId: string | null;
  eventId: string | null;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

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
