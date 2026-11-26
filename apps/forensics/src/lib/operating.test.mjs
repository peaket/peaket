// F-04-16 운영 빌드의 원천 해석·배지·격리 상태 시험. 정본: docs/features/forensic-replay.md §2.1·§2.2·§4.2·§6.8,
// docs/design/d5 §7.17(CMP-082), docs/frontend.md §5.14.1(묶음 G·C+COEP), docs/security/asvs/forensic-replay.md.
// 앱에 시험 도구가 없어 Node 내장 시험 실행기로 돌린다(`pnpm --filter @peaket/forensics test`). 타입 지우기로 .ts를 그대로 읽는다.
// 운영 모듈이 아직 없으면 파일 단위가 아니라 시험마다 단언으로 실패하게 동적 import를 쓴다(architecture §8.6 4의 3·7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const CASE_ID = '11111111-1111-7111-8111-111111111111';
const EXPORT_ID = '22222222-2222-7222-8222-222222222222';

async function load() {
  try {
    return await import('./operating.ts');
  } catch {
    return null;
  }
}

const operating = await load();

function need(name) {
  assert.ok(operating, '운영 원천 모델(src/lib/operating.ts)이 없다');
  assert.equal(typeof operating[name], 'function', `${name}이 없다`);
  return operating[name];
}

/** 상대 import를 따라가며 이 묶음에 실제로 들어가는 .ts·.tsx 파일을 모은다(CSS·바깥 패키지는 뺀다) */
function walk(entry) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"](\.[^'"]+)['"]/g)) {
      const base = resolve(dirname(file), m[1]);
      const hit = [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, resolve(base, 'index.ts'), resolve(base, 'index.tsx')].find(
        (p) => existsSync(p) && !p.endsWith('.css'),
      );
      if (hit) visit(hit);
    }
  };
  visit(resolve(process.cwd(), entry));
  return [...seen].map((p) => p.replaceAll('\\', '/'));
}

test('FX-T17 ① 운영 빌드는 ?source=를 읽지 않고 연 길(?case=·?export=)로만 원천을 정한다', () => {
  const resolveOpen = need('resolveOpen');
  const inv = resolveOpen(`?event=evt-lumen-2026-r1&case=${CASE_ID}`);
  assert.equal(inv.ok, true);
  assert.equal(inv.target.source, 'INVESTIGATION');
  assert.equal(inv.target.sourceLabel, 'investigation');
  assert.equal(inv.target.caseId, CASE_ID);
  assert.equal(inv.target.exportId, null);

  // 주소에 ?source=가 붙어도 운영 빌드는 연 길을 바꾸지 않는다(정본 §6.8 '연 길이 원천을 정한다')
  const forced = resolveOpen(`?event=evt-lumen-2026-r1&case=${CASE_ID}&source=${encodeURIComponent('연구')}`);
  assert.equal(forced.ok, true);
  assert.equal(forced.target.source, 'INVESTIGATION');

  const research = resolveOpen(`?event=evt-lumen-2026-r1&export=${EXPORT_ID}&source=${encodeURIComponent('조사')}`);
  assert.equal(research.ok, true);
  assert.equal(research.target.source, 'RESEARCH');
  assert.equal(research.target.sourceLabel, 'research');
  assert.equal(research.target.exportId, EXPORT_ID);
  assert.equal(research.target.caseId, null);
});

test('FX-T17 ① 사건 작업대 탭은 연구 원천을, 연구 메뉴 탭은 조사 원천을 열 수 없다', () => {
  const resolveOpen = need('resolveOpen');
  const both = resolveOpen(`?event=evt-lumen-2026-r1&case=${CASE_ID}&export=${EXPORT_ID}`);
  assert.equal(both.ok, false);
  assert.equal(both.code, 'both-branches');
  assert.match(both.message, /한 화면/);

  const none = resolveOpen('?event=evt-lumen-2026-r1');
  assert.equal(none.ok, false);
  assert.equal(none.code, 'open-path');
  assert.match(none.message, /사건 작업대|연구 메뉴/);

  const noEvent = resolveOpen(`?case=${CASE_ID}`);
  assert.equal(noEvent.ok, false);
  assert.equal(noEvent.code, 'event-id');

  const badCase = resolveOpen('?event=evt-lumen-2026-r1&case=CASE-2610-0007');
  assert.equal(badCase.ok, false);
  assert.equal(badCase.code, 'case-id', '운영 사건 ID는 계약의 uuid 꼴이다');

  const badExport = resolveOpen('?event=evt-lumen-2026-r1&export=apl-1');
  assert.equal(badExport.ok, false);
  assert.equal(badExport.code, 'export-id');
});

test('FX-T21 ① 사건 작업대에서 연 탭은 사건·회차와 조사 배지를 쓰고 관제 콘솔 경로가 사건 작업대다', () => {
  const resolveOpen = need('resolveOpen');
  const badge = need('operatingBadge');
  const spec = need('operatingSpec');
  const consolePathFor = need('consolePathFor');

  const opened = resolveOpen(`?event=evt-lumen-2026-r1&case=${CASE_ID}`);
  assert.equal(opened.ok, true);
  assert.equal(badge(opened.target), '조사');
  assert.equal(spec(opened.target).badge, '조사');
  assert.equal(spec(opened.target).caseLabel, `사건 ${CASE_ID}`);
  assert.equal(consolePathFor(opened.target), `/investigations/${CASE_ID}`);
});

test('A-T23 ② 연구 탭은 내보내기 ID와 회차가 있어야 열리고 배지가 연구다', () => {
  const resolveOpen = need('resolveOpen');
  const badge = need('operatingBadge');
  const consolePathFor = need('consolePathFor');

  const opened = resolveOpen(`?event=evt-lumen-2026-r1&export=${EXPORT_ID}`);
  assert.equal(opened.ok, true);
  assert.equal(badge(opened.target), '연구');
  assert.equal(consolePathFor(opened.target), '/dashboard');
});

test('A-T24 ⑤ 조사 원천 화면 모델은 계정 ID·사건 ID·계정끼리 견주는 행동 값을 표시 값으로 만들지 않는다', () => {
  const resolveOpen = need('resolveOpen');
  const rowView = need('replayRowView');
  const opened = resolveOpen(`?event=evt-lumen-2026-r1&case=${CASE_ID}`);
  assert.equal(opened.ok, true);

  const view = rowView(
    { t_ms: 1_000, kind: 2, seat: 5, section: 0, session: 7, result: 1, retry: 0, latency_ms: 40, first_hold_ms: 900, entropy: Number.NaN, net_type: 0, asn: 0, device_group: 0, bot_tier: 0, member: 1, post_seat: 0 },
    opened.target,
  );
  assert.deepEqual(Object.keys(view).sort(), ['atMs', 'kind', 'member', 'postSeat', 'result', 'seat', 'section', 'sessionNo']);
  const text = JSON.stringify(view);
  assert.doesNotMatch(text, /account/i);
  assert.doesNotMatch(text, /caseId/i);
  assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  // 계정끼리 행동 값을 견주는 값(entropy·유사도·순위)은 표시 모델에 없다(ADR-0173 결정 5)
  assert.doesNotMatch(text, /entropy|similar|rank/i);
});

test('FX-T17 ① 운영 묶음에는 합성 시나리오·시드·정답·파일 불러오기 코드가 들어가지 않는다', () => {
  const entry = 'src/operating/main.tsx';
  assert.ok(existsSync(entry), '운영 진입점(src/operating/main.tsx)이 없다');
  const graph = walk(entry);
  assert.ok(graph.length > 1, '운영 진입점이 아무것도 가져오지 않는다');
  const forbidden = ['/forensics/scenario.ts', '/forensics/prng.ts', '/forensics/cdf.ts', '/forensics/inv-cdf-table.ts', '/screen/'];
  for (const file of graph) {
    for (const part of forbidden) assert.ok(!file.endsWith(part) && !file.includes(part), `${file}가 운영 묶음에 들어간다`);
  }

  const demo = walk('src/main.tsx');
  assert.ok(demo.some((f) => f.endsWith('/App.tsx')), '시험·시연 진입점이 App.tsx를 가져오지 않는다');
  for (const file of demo) {
    const src = readFileSync(file, 'utf8');
    assert.ok(!src.includes('@peaket/api-client'), `${file}이 시험·시연 묶음에서 api-client를 가져온다`);
    assert.ok(!file.includes('/operating/'), `${file}이 시험·시연 묶음에 운영 모듈을 넣는다`);
  }
});
