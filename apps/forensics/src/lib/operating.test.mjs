// F-04-16 운영 빌드의 원천 해석·배지·격리 상태 시험. 정본: docs/features/forensic-replay.md §2.1·§2.2·§4.2·§6.8,
// docs/design/d5 §7.17(CMP-082), docs/frontend.md §5.14.1(묶음 G·C+COEP)·§5.19, docs/security/asvs/forensic-replay.md.
// 앱에 시험 도구가 없어 Node 내장 시험 실행기로 돌린다(`pnpm --filter @peaket/forensics test`). 타입 지우기로 .ts를 그대로 읽는다.
// 운영 모듈이 아직 없으면 파일 단위가 아니라 시험마다 단언으로 실패하게 동적 import를 쓴다(architecture §8.6 4의 3·7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

const OPERATING_FILES = ['main.tsx', 'OperatingApp.tsx', 'OperatingHead.tsx', 'ReceivingMain.tsx', 'ProblemMain.tsx', 'ReadyMain.tsx'];

function readOperating(name) {
  const path = resolve(process.cwd(), 'src/operating', name);
  assert.ok(existsSync(path), `운영 화면 src/operating/${name}이 없다`);
  return readFileSync(path, 'utf8');
}

/** src/operating 아래의 .ts·.tsx 파일 전부. 한 파일만 보고 통과하는 일을 막는다(RV0416-01) */
function operatingSources() {
  const root = resolve(process.cwd(), 'src/operating');
  assert.ok(existsSync(root), '운영 화면 폴더(src/operating)가 없다');
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.(ts|tsx)$/.test(path)) out.push(path.replaceAll('\\', '/'));
    }
  };
  visit(root);
  assert.ok(out.length >= OPERATING_FILES.length, '운영 화면 파일이 계획 §4.4보다 적다');
  return out;
}

/** 상대 import(정적·동적)를 따라가며 이 묶음에 실제로 들어가는 .ts·.tsx 파일을 모은다(CSS·바깥 패키지는 뺀다) */
function walk(entry) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    const specs = [
      ...src.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"](\.[^'"]+)['"]/g),
      ...src.matchAll(/(?:import|require)\(\s*['"](\.[^'"]+)['"]\s*\)/g),
    ];
    for (const m of specs) {
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
  const isolationLabel = need('isolationLabel');

  const opened = resolveOpen(`?event=evt-lumen-2026-r1&case=${CASE_ID}`);
  assert.equal(opened.ok, true);
  assert.equal(badge(opened.target), '조사');
  assert.equal(spec(opened.target).badge, '조사');
  assert.equal(spec(opened.target).caseLabel, `사건 ${CASE_ID}`);
  assert.equal(consolePathFor(opened.target), `/investigations/${CASE_ID}`);

  // 격리 여부는 상태 띠에만 쓰고 재생 가능 여부를 바꾸지 않는다(정본 §3.3, d5 §7.17)
  assert.equal(isolationLabel(true), '공유 메모리 켜짐');
  assert.equal(isolationLabel(false), '복사 방식');

  const head = readOperating('OperatingHead.tsx');
  assert.match(head, /ReplaySourceBadge/, '머리가 CMP-082 ReplaySourceBadge를 쓰지 않는다');
  assert.match(head, /crossOriginIsolated/, '상태 띠가 격리 여부를 읽지 않는다');
  assert.match(head, /isolationLabel\(/, '상태 띠가 공유 메모리/복사 방식을 가르지 않는다');
  assert.match(head, /<h1/, '화면 제목(h1)이 없다');
  assert.match(head, /aria-live|role=["']status["']/, '상태 띠에 알림 역할이 없다');
  assert.match(readOperating('ReceivingMain.tsx'), /role=["']status["']|aria-live/, '받는 중 상태에 알림 역할이 없다');
  assert.match(readOperating('ProblemMain.tsx'), /role=["']alert["']|aria-live/, '오류 상태에 알림 역할이 없다');
  assert.match(readOperating('ReadyMain.tsx'), /role=["']status["']|aria-live/, '재생 상태에 알림 역할이 없다');
});

test('A-T23 ② 연구 탭은 내보내기 ID와 회차가 있어야 열리고 배지가 연구다', () => {
  const resolveOpen = need('resolveOpen');
  const badge = need('operatingBadge');
  const spec = need('operatingSpec');
  const consolePathFor = need('consolePathFor');

  const opened = resolveOpen(`?event=evt-lumen-2026-r1&export=${EXPORT_ID}`);
  assert.equal(opened.ok, true);
  assert.equal(badge(opened.target), '연구');
  assert.equal(spec(opened.target).badge, '연구');
  assert.match(spec(opened.target).event ?? '', /evt-lumen-2026-r1/);
  assert.equal(spec(opened.target).window, '시간창 T+00:00 ~ T+30:00');
  assert.equal(spec(opened.target).caseLabel, undefined, '연구 원천에는 사건 라벨이 없다');
  assert.equal(consolePathFor(opened.target), '/dashboard');
});

test('A-T24 ⑤ 조사 원천 화면 모델은 계정 ID·사건 ID·계정끼리 견주는 행동 값을 표시 값으로 만들지 않는다', () => {
  const resolveOpen = need('resolveOpen');
  const rowView = need('replayRowView');
  const opened = resolveOpen(`?event=evt-lumen-2026-r1&case=${CASE_ID}`);
  assert.equal(opened.ok, true);

  const rich = {
    t_ms: 1_234,
    kind: 2,
    seat: 42,
    section: 3,
    session: 99,
    result: 1,
    retry: 1,
    latency_ms: 40,
    first_hold_ms: 900,
    entropy: 1.4,
    net_type: 3,
    asn: 64_500,
    device_group: 4,
    bot_tier: 2,
    member: 1,
    post_seat: 1,
  };
  const view = rowView(rich, opened.target);
  assert.deepEqual(view, { sessionNo: 99, kind: 2, seat: 42, section: 3, result: 1, member: true, postSeat: true, atMs: 1_234 });

  const plain = rowView({ ...rich, entropy: 2.2, net_type: 4, asn: 1, device_group: 9, bot_tier: 3, member: 0, post_seat: 0 }, opened.target);
  assert.deepEqual(plain, { sessionNo: 99, kind: 2, seat: 42, section: 3, result: 1, member: false, postSeat: false, atMs: 1_234 });
  const text = JSON.stringify([view, plain]);
  assert.doesNotMatch(text, /account/i);
  assert.doesNotMatch(text, /caseId/i);
  assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  // 계정끼리 행동 값을 견주는 값(엔트로피·유사도·순위)과 기기·망 값은 표시 모델에 없다(ADR-0173 결정 5)
  assert.doesNotMatch(text, /entropy|similar|rank|device_group|net_type|asn|bot_tier/i);
});

test('FX-T17 ① 운영 묶음에는 합성 시나리오·시드·정답·파일 불러오기 코드가 들어가지 않는다', () => {
  const entry = 'src/operating/main.tsx';
  assert.ok(existsSync(entry), '운영 진입점(src/operating/main.tsx)이 없다');
  const graph = walk(entry);
  assert.ok(graph.length > 1, '운영 진입점이 아무것도 가져오지 않는다');
  const forbidden = [
    '/lib/source.ts',
    '/lib/source-specs/synthetic.ts',
    '/forensics/scenario.ts',
    '/forensics/prng.ts',
    '/forensics/cdf.ts',
    '/forensics/inv-cdf-table.ts',
    '/screen/',
  ];
  for (const file of graph) {
    for (const part of forbidden) assert.ok(!file.endsWith(part) && !file.includes(part), `${file}가 운영 묶음에 들어간다`);
  }

  // 운영 화면 파일 어디에도 합성 데이터의 배지·시나리오·파일 불러오기 문구가 없어야 한다
  for (const file of operatingSources()) {
    const src = readFileSync(file, 'utf8');
    for (const word of ['합성 데이터', '파일 불러오기', '시나리오 고르기', '이 시나리오 내려받기', '공유 주소']) {
      assert.ok(!src.includes(word), `${file}에 '${word}'가 남는다`);
    }
  }

  // 운영 화면은 받기 순서를 실제로 잇고, api-client의 fetch 경로만 쓴다(RV0416-03)
  const app = readOperating('OperatingApp.tsx');
  assert.match(app, /from\s+['"]@peaket\/api-client['"]/, 'api-client를 가져오지 않는다');
  assert.match(app, /createApiClient\(/, 'api-client를 만들지 않는다');
  assert.match(app, /\.request\(/, 'api-client request를 부르지 않는다');
  const calls = ['replayOperation', 'replayHeadersIssue', 'arrayBuffer', 'replayEnvelopeOf', 'replayFileIssue', 'replayFileValidation'];
  const order = calls.map((x) => app.indexOf(`${x}(`));
  for (let i = 0; i < order.length; i += 1) assert.ok(order[i] >= 0, `OperatingApp이 ${calls[i]}을 부르지 않는다`);
  for (let i = 1; i < order.length; i += 1) assert.ok(order[i - 1] < order[i], '받기·검증 호출 순서가 계획 §4.4와 다르다');
  assert.match(app, /arrayBuffer\(/, '응답 본문을 바이트로 읽지 않는다');

  const demo = walk('src/main.tsx');
  assert.ok(demo.some((f) => f.endsWith('/App.tsx')), '시험·시연 진입점이 App.tsx를 가져오지 않는다');
  assert.ok(demo.some((f) => f.endsWith('/lib/source.ts')), '시험·시연 진입점이 source.ts를 가져오지 않는다');
  assert.ok(demo.some((f) => f.endsWith('/lib/source-specs/synthetic.ts')), '시험·시연 진입점이 합성 spec을 가져오지 않는다');
  for (const file of demo) {
    const src = readFileSync(file, 'utf8');
    assert.ok(!src.includes('@peaket/api-client'), `${file}이 시험·시연 묶음에서 api-client를 가져온다`);
    assert.ok(!file.includes('/operating/'), `${file}이 시험·시연 묶음에 운영 모듈을 넣는다`);
  }
});
