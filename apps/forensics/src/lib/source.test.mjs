// 포렌식 리플레이 원천 모델 시험(OpenSpec add-fraud-investigation-screens tasks 2.2, design.md 결정 7·12).
// 앱에 시험 도구가 아직 없어 Node 내장 시험 실행기로 돌린다(`pnpm --filter @peaket/forensics test`). 타입 지우기로 .ts를 그대로 읽는다.
// 기준: docs/features/forensic-replay.md §2.1(구성·고정 문구)·§2.2(상태), docs/design/d5 §7.17(세 원천 그림·상태 표)·§3.9(휴대폰 범위),
// docs/design/d2 CMP-082 ReplaySourceBadge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DENY_BODY,
  DENY_STATE,
  DENY_TITLE,
  parseOpened,
  parseSource,
  REVIEW_PENDING_BODY,
  REVIEW_PENDING_STATE,
  SOURCES,
  sourceSearch,
  sourceSpec,
  statesFor,
} from './source.ts';

const NOTICE_INVESTIGATION = '후보 찾기용입니다. 조치는 사건 작업대에서 소명과 승인을 거쳐 합니다(POL-046).';
const NOTICE_BOT = '후보 찾기용입니다. 봇 판정은 표본 검토(SCR-067)와 정해진 규칙(POL-006)으로 합니다.';

test('?source=조사는 조사, ?source=연구는 연구 원천이다', () => {
  assert.equal(parseSource('?source=조사'), 'investigation');
  assert.equal(parseSource('?source=연구'), 'research');
  // 주소창에서 한글은 퍼센트 부호로 바뀌어 온다
  assert.equal(parseSource(`?source=${encodeURIComponent('조사')}`), 'investigation');
  assert.equal(parseSource(new URLSearchParams({ source: '연구', state: '재생' })), 'research');
});

test('source가 없거나 모르는 값이면 합성 원천이다(공개 데모의 처음 값)', () => {
  assert.equal(parseSource(''), 'synthetic');
  assert.equal(parseSource('?state=재생'), 'synthetic');
  assert.equal(parseSource('?source=합성'), 'synthetic');
  assert.equal(parseSource('?source=investigation'), 'synthetic');
  assert.equal(parseSource('?source='), 'synthetic');
});

test('원천은 셋이고 순서는 합성·조사·연구다', () => {
  assert.deepEqual([...SOURCES], ['synthetic', 'investigation', 'research']);
});

test('원천 배지 글자는 조사·연구·합성 데이터다(CMP-082)', () => {
  assert.equal(sourceSpec('investigation').badge, '조사');
  assert.equal(sourceSpec('research').badge, '연구');
  assert.equal(sourceSpec('synthetic').badge, '합성 데이터');
});

test('화면 제목(h1)에 원천을 넣는다', () => {
  assert.equal(sourceSpec('synthetic').title, '포렌식 리플레이 · 합성 데이터 데모');
  assert.equal(sourceSpec('investigation').title, '포렌식 리플레이 · 조사 원천');
  assert.equal(sourceSpec('research').title, '포렌식 리플레이 · 연구 원천');
});

test('후보 패널 고정 문구는 원천에 맞는다(forensic-replay §2.1)', () => {
  assert.equal(sourceSpec('investigation').notice, NOTICE_INVESTIGATION);
  assert.equal(sourceSpec('research').notice, NOTICE_BOT);
  assert.equal(sourceSpec('synthetic').notice, NOTICE_BOT);
});

test('머리 안내 글은 조사·연구에만 있다', () => {
  assert.equal(sourceSpec('investigation').headerNote, '조사용 기록 · 이 탭에만 있고 내려받지 않습니다');
  assert.equal(sourceSpec('research').headerNote, '가명 기록 · 30분 동안 쓰지 않으면 지워짐');
  assert.equal(sourceSpec('synthetic').headerNote, undefined);
});

test('머리의 회차·사건·시간창(d5 §7.17)', () => {
  const inv = sourceSpec('investigation');
  const res = sourceSpec('research');
  assert.equal(inv.event, 'LUMEN 콘서트 2026 서울 · 10/25(일) 18:00');
  assert.equal(res.event, 'LUMEN 콘서트 2026 서울 · 10/25(일) 18:00');
  assert.equal(inv.caseLabel, '사건 CASE-2610-0007');
  assert.equal(res.caseLabel, undefined);
  assert.equal(inv.window, '시간창 T−10:00 ~ T+20:00');
  assert.equal(res.window, '시간창 T+00:00 ~ T+30:00');
  assert.equal(sourceSpec('synthetic').event, undefined);
});

test('관제 콘솔 링크는 조사는 사건 작업대, 연구는 대시보드다. 합성에는 없다', () => {
  assert.equal(sourceSpec('investigation').consolePath, '/investigations/CASE-2610-0007');
  assert.equal(sourceSpec('research').consolePath, '/dashboard');
  assert.equal(sourceSpec('synthetic').consolePath, undefined);
});

test('시나리오·시드·다시 만들기·파일 불러오기·내려받기·공유 주소는 합성에만 있다', () => {
  assert.equal(sourceSpec('synthetic').synthControls, true);
  assert.equal(sourceSpec('investigation').synthControls, false);
  assert.equal(sourceSpec('research').synthControls, false);
});

test('정밀도·재현율과 그 경고는 정답이 있는 합성에만 있다', () => {
  assert.equal(sourceSpec('synthetic').precisionRecall, true);
  assert.equal(sourceSpec('investigation').precisionRecall, false);
  assert.equal(sourceSpec('research').precisionRecall, false);
});

test('교차 필터: 봇 등급·네트워크 유형은 합성만, 묶음은 조사만', () => {
  assert.deepEqual(sourceSpec('synthetic').filters, { botGrade: true, network: true, group: false });
  assert.deepEqual(sourceSpec('investigation').filters, { botGrade: false, network: false, group: true });
  assert.deepEqual(sourceSpec('research').filters, { botGrade: false, network: false, group: false });
});

test('후보 패널: 합성은 산점도, 조사는 단계별 기준선, 연구는 한 축 분포', () => {
  assert.equal(sourceSpec('synthetic').candidate, 'scatter');
  assert.equal(sourceSpec('investigation').candidate, 'baseline');
  assert.equal(sourceSpec('research').candidate, 'distribution');
});

test('기기 묶음 목록은 연구에 없다(§6.3)', () => {
  assert.equal(sourceSpec('synthetic').deviceGroups, true);
  assert.equal(sourceSpec('investigation').deviceGroups, true);
  assert.equal(sourceSpec('research').deviceGroups, false);
});

test('묶음 계정·게시물 대조 좌석 점등은 조사에만 있다', () => {
  assert.equal(sourceSpec('investigation').seatMarks, true);
  assert.equal(sourceSpec('research').seatMarks, false);
  assert.equal(sourceSpec('synthetic').seatMarks, false);
});

test('원천 만료 문구(d5 §7.17 상태 표)', () => {
  assert.equal(sourceSpec('investigation').expired, '이 회차의 조사용 기록은 보존 기간이 지났습니다. 증거 묶음만 볼 수 있습니다');
  assert.equal(sourceSpec('research').expired, '이 회차의 가명 기록은 보존 기간(90일)이 지났습니다');
  assert.equal(sourceSpec('synthetic').expired, undefined);
});

test('권한 없음(지정 없음) 문구', () => {
  assert.equal(DENY_STATE, '권한 없음(지정 없음)');
  assert.equal(DENY_TITLE, '이 화면을 볼 권한이 없습니다');
  assert.equal(DENY_BODY, '조사 원천은 부정 거래 조사관, 연구 원천은 가명정보 취급자 지정이 있어야 엽니다');
});

const SYNTHETIC_WIDE = [
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
];

test('합성 원천 상태(데스크톱·태블릿): 공개 데모라 권한 없음이 없다', () => {
  assert.deepEqual([...statesFor('synthetic', 'desktop')], SYNTHETIC_WIDE);
  assert.deepEqual([...statesFor('synthetic', 'tablet')], SYNTHETIC_WIDE);
});

test('조사 원천 상태(데스크톱·태블릿): 그래픽 대체·만드는 중·시나리오 상태가 없다', () => {
  assert.deepEqual(
    [...statesFor('investigation', 'desktop')],
    ['재생', '후보 고름', '받는 중', '파일 거절', '사건 일부 버림', '복사 방식', '돌릴 수 없음', '일시정지', '원천 만료', DENY_STATE],
  );
  assert.deepEqual([...statesFor('investigation', 'tablet')], [...statesFor('investigation', 'desktop')]);
});

test('연구 원천 상태(데스크톱·태블릿): 한 축 분포가 있어 그래픽 대체가 있다', () => {
  assert.deepEqual(
    [...statesFor('research', 'desktop')],
    ['재생', '후보 고름', '받는 중', '파일 거절', '사건 일부 버림', '복사 방식', '그래픽 대체', '돌릴 수 없음', '일시정지', '원천 만료', REVIEW_PENDING_STATE, DENY_STATE],
  );
  assert.deepEqual([...statesFor('research', 'tablet')], [...statesFor('research', 'desktop')]);
});

test('휴대폰 상태: 교차 필터·후보 패널·파일 불러오기 자리가 없는 상태는 뺀다(d5 §3.9)', () => {
  assert.deepEqual(
    [...statesFor('synthetic', 'phone')],
    ['재생', '만드는 중', '돌릴 수 없음', '사건 일부 버림', '일시정지', '시나리오 고르기', '스포츠 플레이오프 오픈'],
  );
  const op = ['재생', '받는 중', '파일 거절', '사건 일부 버림', '돌릴 수 없음', '일시정지', '원천 만료', DENY_STATE];
  assert.deepEqual([...statesFor('investigation', 'phone')], op);
  assert.deepEqual([...statesFor('research', 'phone')], [...op.slice(0, -1), REVIEW_PENDING_STATE, DENY_STATE]);
});

test('어느 원천·배치든 첫 상태는 재생이고, 휴대폰 상태는 넓은 배치 상태 안에 든다', () => {
  for (const s of SOURCES) {
    const wide = statesFor(s, 'desktop');
    const phone = statesFor(s, 'phone');
    assert.equal(wide[0], '재생');
    assert.equal(phone[0], '재생');
    for (const p of phone) assert.ok(wide.includes(p), `${s} 휴대폰 상태 ${p}가 데스크톱에 없다`);
    assert.ok(!wide.includes('권한 없음(2단계)'), '예전 이름이 남았다');
    assert.equal(new Set(wide).size, wide.length, `${s} 상태 이름이 겹친다`);
  }
});

test('권한 없음은 조사·연구에만, 받는 중·원천 만료도 조사·연구에만 있다', () => {
  for (const layout of ['desktop', 'tablet', 'phone']) {
    assert.ok(!statesFor('synthetic', layout).includes(DENY_STATE));
    assert.ok(!statesFor('synthetic', layout).includes('받는 중'));
    assert.ok(!statesFor('synthetic', layout).includes('원천 만료'));
    for (const s of ['investigation', 'research']) {
      assert.ok(statesFor(s, layout).includes(DENY_STATE));
      assert.ok(statesFor(s, layout).includes('받는 중'));
      assert.ok(statesFor(s, layout).includes('원천 만료'));
      assert.ok(!statesFor(s, layout).includes('만드는 중'));
      assert.ok(!statesFor(s, layout).includes('시나리오 고르기'));
    }
  }
});

/** 기대 주소(URLSearchParams가 쓰는 부호 그대로) */
const q = (pairs) => `?${new URLSearchParams(pairs).toString()}`;

test('원천 바꾸기 주소는 source와 theme을 남기고 state는 그 원천에 있을 때만 남긴다', () => {
  // 합성으로 갈 때는 source를 지운다(없으면 합성)
  assert.equal(sourceSearch('?source=조사&theme=light&state=재생', 'synthetic'), q([['theme', 'light'], ['state', '재생']]));
  assert.equal(sourceSearch('', 'investigation'), q([['source', '조사']]));
  // 원천 만료는 합성에 없으므로 state를 지운다
  assert.equal(sourceSearch('?source=연구&state=원천 만료', 'synthetic'), '');
  assert.equal(sourceSearch('?source=연구&state=원천 만료', 'investigation'), q([['source', '조사'], ['state', '원천 만료']]));
  // 그래픽 대체는 조사에 없다
  assert.equal(sourceSearch('?state=그래픽 대체', 'investigation'), q([['source', '조사']]));
});

test('조사 원천은 주소의 사건·회차(?case=·?event=)를 머리·받는 중 글·관제 링크에 쓴다', () => {
  const s = sourceSpec('investigation', parseOpened('?source=조사&event=evt-lumen-2026-r1&case=CASE-2610-0005'));
  assert.equal(s.caseLabel, '사건 CASE-2610-0005');
  assert.equal(s.consolePath, '/investigations/CASE-2610-0005');
  assert.equal(s.event, 'LUMEN 콘서트 2026 서울 · 10/25(일) 18:00');
  // 모르는 회차는 회차 ID를 그대로 적는다
  assert.equal(sourceSpec('investigation', parseOpened('?source=조사&event=evt-aurora-r2&case=CASE-2610-0009')).event, '회차 evt-aurora-r2');
});

test('사건·회차 값이 꼴에 맞지 않으면 쓰지 않는다(관제 링크 경로를 바꾸지 못한다)', () => {
  const o = parseOpened('?source=조사&case=../accounts?x=1&event=a b');
  assert.equal(o.caseId, null);
  assert.equal(o.eventId, null);
  // 넘긴 사건이 없으면 목업 기본 사건
  assert.equal(sourceSpec('investigation', o).caseLabel, '사건 CASE-2610-0007');
});

test('연구 원천은 사건을 보이지 않고 관제 링크는 대시보드다', () => {
  const s = sourceSpec('research', parseOpened('?source=연구&case=CASE-2610-0005'));
  assert.equal(s.caseLabel, undefined);
  assert.equal(s.consolePath, '/dashboard');
});

// ── 사후 포렌식 자체 법률 검토 반영(OpenSpec apply-legal-review-to-screens tasks 3.7, ADR-0173) ──

test('ADR0173_8 연구 원천의 가명처리 적정성 검토 전 403은 그 문구를 보이는 상태다(d5 §9.2, 연구에만)', () => {
  assert.equal(REVIEW_PENDING_STATE, '오류 · pseudonymization-review-pending');
  assert.equal(REVIEW_PENDING_BODY, '가명처리 적정성 검토 결과서가 승인되기 전이라 내보낼 수 없습니다. 개인정보 보호책임자에게 검토를 요청해 주세요');
  for (const layout of ['desktop', 'tablet', 'phone']) {
    assert.ok(statesFor('research', layout).includes(REVIEW_PENDING_STATE), layout);
    assert.ok(!statesFor('investigation', layout).includes(REVIEW_PENDING_STATE), layout);
    assert.ok(!statesFor('synthetic', layout).includes(REVIEW_PENDING_STATE), layout);
  }
});

test('ADR0173_5 조사 원천 후보 패널은 단계 시각이고, 묶음 계정의 행동 값을 나란히 견주는 보기가 없다', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  assert.equal(sourceSpec('investigation').candidate, 'baseline');
  const dir = fileURLToPath(new URL('../screen/', import.meta.url));
  const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f));
  assert.ok(files.length > 0);
  const forbidden = /행동 값 (표|비교)|행동 비교|유사도|비슷한 순|겹친 그래프|similarity/i;
  for (const f of files) assert.doesNotMatch(readFileSync(join(dir, f), 'utf8'), forbidden, f);
});
