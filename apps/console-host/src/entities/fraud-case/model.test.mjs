// 부정 거래 조사 목업의 계산과 고정 값 시험(OpenSpec add-fraud-investigation-screens tasks 2.1, design.md 결정 4·12).
// 앱에 시험 도구가 아직 없어 Node 내장 시험 실행기로 돌린다(`pnpm --filter @peaket/console-host test`). 타입 지우기로 .ts를 그대로 읽는다.
// 기준: docs/features/forensic-replay.md §6.7.5(소명 기한)·POL-046 ⑤(취소 마감 = 공연 시작 − 26시간)·control-tower §9.2(12·2시간 단계),
// docs/security/authz-matrix.md §4.3 5(IP는 가린 값만), d5 §7.18·§7.19.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appealDueLeavesCancel,
  cancelDeadlineAt,
  cancelDeadlineNotice,
  defaultAppealDue,
  formatKst,
  isMaskedIpLabel,
  purchaseVsLimit,
  remainingHoursText,
  REASON_LABEL,
  SIGNAL_LABEL,
  LINK_KIND_LABEL,
} from './model.ts';
import { CASES, CLUSTERS, EVENT, EXTERNAL_POSTS, graphFor, REVEALED_IP, NOW } from './fixtures.ts';

const SHOW = '2026-10-25T18:00:00+09:00';
const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const OPENAPI = readFileSync(join(ROOT, 'docs/api/openapi.yaml'), 'utf8');

/** openapi.yaml에서 `이름: { type: string, enum: [..] }`의 열거값을 읽는다 */
function openapiEnum(name) {
  const m = OPENAPI.match(new RegExp(String.raw`\b${name}: \{ type: string, enum: \[([^\]]+)\]`));
  assert.ok(m, `openapi에 ${name} 열거값이 없다`);
  return m[1].split(',').map((x) => x.trim()).sort();
}

/** 원문 IP 꼴 찾기: IPv4(가린 꼴 x.y.z.0/24가 아니면 원문, /24가 붙어도 끝이 0이 아니면 원문)와 IPv6(::/48 꼴이 아니면 원문) */
function rawIps(text) {
  const out = [];
  for (const m of text.matchAll(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/\d{1,2})?/g)) {
    if (!(m[5] === '/24' && m[4] === '0')) out.push(m[0]);
  }
  for (const m of text.matchAll(/\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}(?:\/\d{1,3})?/gi)) {
    const v = m[0];
    const colons = (v.match(/:/g) ?? []).length;
    if (!v.includes('::') && colons < 4) continue; // 시각(20:04:12) 같은 글
    if (!/^[0-9a-f]{1,4}(:[0-9a-f]{1,4}){0,2}::\/48$/i.test(v)) out.push(v);
  }
  return out;
}

/** 화면 코드 파일(시험 파일 빼고)의 글 */
function screenSources() {
  const dirs = ['apps/console-host/src/pages/investigations', 'apps/console-host/src/pages/investigation-case', 'apps/console-host/src/pages/cs-approvals', 'apps/console-host/src/entities/fraud-case'];
  const files = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(f)) files.push(p);
    }
  };
  for (const d of dirs) walk(join(ROOT, d));
  return files.map((f) => ({ f, text: readFileSync(f, 'utf8') }));
}

test('취소 마감은 공연 시작 26시간 전이다(POL-046 ⑤)', () => {
  assert.equal(formatKst(cancelDeadlineAt(SHOW)), '10/24(토) 16:00');
});

test('소명 기한 기본값은 요청 + 3일과 취소 마감 − 6시간 가운데 이른 쪽이다', () => {
  const deadline = cancelDeadlineAt(SHOW);
  assert.equal(formatKst(defaultAppealDue('2026-10-19T14:20:00+09:00', deadline)), '10/22(목) 14:20');
});

test('소명 기한 기본값은 요청 + 24시간보다 짧지 않다', () => {
  const deadline = cancelDeadlineAt(SHOW);
  // 요청 10/23 12:00 → min(10/26 12:00, 10/24 10:00) = 10/24 10:00 < 요청 + 24시간 10/24 12:00 → 10/24 12:00
  assert.equal(formatKst(defaultAppealDue('2026-10-23T12:00:00+09:00', deadline)), '10/24(토) 12:00');
});

test('기한이 취소 마감 − 6시간보다 늦으면 표 취소를 고를 수 없다고 알린다', () => {
  const deadline = cancelDeadlineAt(SHOW);
  assert.equal(appealDueLeavesCancel('2026-10-22T14:20:00+09:00', deadline), true);
  assert.equal(appealDueLeavesCancel('2026-10-24T10:00:00+09:00', deadline), true);
  assert.equal(appealDueLeavesCancel('2026-10-24T12:00:00+09:00', deadline), false);
});

test('취소 마감까지 남은 시간: 12시간 넘음 · 12시간 이하 warning · 2시간 이하 danger · 지남', () => {
  const deadline = cancelDeadlineAt(SHOW);
  assert.deepEqual(cancelDeadlineNotice('2026-10-19T14:20:00+09:00', deadline), { tone: 'ok', text: '취소 마감까지 5일 1시간 남았습니다', short: '5일 1시간 남음' });
  assert.deepEqual(cancelDeadlineNotice('2026-10-24T04:00:00+09:00', deadline), { tone: 'warning', text: '취소 마감까지 12시간 남았습니다', short: '12시간 남음' });
  assert.deepEqual(cancelDeadlineNotice('2026-10-24T14:00:00+09:00', deadline), { tone: 'danger', text: '취소 마감까지 2시간 남았습니다', short: '2시간 남음' });
  assert.deepEqual(cancelDeadlineNotice('2026-10-24T16:30:00+09:00', deadline), { tone: 'passed', text: '취소 마감이 지났습니다', short: '지남' });
});

test('취소 마감 단계는 화면에 보이는 시간 값으로 정한다(경계 안쪽 값)', () => {
  const deadline = cancelDeadlineAt(SHOW);
  // 12시간 30분 남음 → 보이는 값 '12시간'이라 warning
  assert.deepEqual(cancelDeadlineNotice('2026-10-24T03:30:00+09:00', deadline), { tone: 'warning', text: '취소 마감까지 12시간 남았습니다', short: '12시간 남음' });
  // 13시간 남음 → ok
  assert.equal(cancelDeadlineNotice('2026-10-24T03:00:00+09:00', deadline).tone, 'ok');
  // 2시간 30분 남음 → 보이는 값 '2시간'이라 danger
  assert.deepEqual(cancelDeadlineNotice('2026-10-24T13:30:00+09:00', deadline), { tone: 'danger', text: '취소 마감까지 2시간 남았습니다', short: '2시간 남음' });
  // 3시간 남음 → warning
  assert.equal(cancelDeadlineNotice('2026-10-24T13:00:00+09:00', deadline).tone, 'warning');
  // 30분 남음 → danger, '1시간 미만'
  assert.deepEqual(cancelDeadlineNotice('2026-10-24T15:30:00+09:00', deadline), { tone: 'danger', text: '취소 마감까지 1시간 미만 남았습니다', short: '1시간 미만 남음' });
});

test('소명 기한까지 남은 시간은 시간 단위 글이다', () => {
  assert.equal(remainingHoursText('2026-10-19T14:20:00+09:00', '2026-10-22T14:20:00+09:00'), '남은 시간 72시간');
  assert.equal(remainingHoursText('2026-10-19T14:20:00+09:00', '2026-10-21T16:00:00+09:00'), '남은 시간 49시간');
  assert.equal(remainingHoursText('2026-10-22T15:00:00+09:00', '2026-10-22T14:20:00+09:00'), '기한 지남');
});

test("구매 수 대 한도는 '구매 27 / 한도 4'다(forensic-replay §6.7.3)", () => {
  assert.equal(purchaseVsLimit(27, 4), '구매 27 / 한도 4');
});

test('이름표가 openapi.yaml의 열거값과 같다(계약에서 읽어 비교)', () => {
  assert.deepEqual(Object.keys(REASON_LABEL).sort(), openapiEnum('FraudReasonCategory'));
  assert.deepEqual(Object.keys(SIGNAL_LABEL).sort(), openapiEnum('FraudSignal'));
  assert.deepEqual(Object.keys(LINK_KIND_LABEL).sort(), openapiEnum('FraudLinkKind'));
  assert.equal(REASON_LABEL.LIMIT_EVASION, '1인 매수 제한 회피');
  assert.equal(REASON_LABEL.MACRO_BOT, '자동화 프로그램(매크로·봇)');
});

test('목업 사건 상태와 점수 범주는 openapi 열거값 안이다', () => {
  const statuses = openapiEnum('FraudCaseStatus');
  for (const c of CASES) assert.ok(statuses.includes(c.status), c.caseId);
  const bands = openapiEnum('scoreBand');
  for (const cl of CLUSTERS) assert.ok(bands.includes(cl.scoreBand), cl.clusterId);
});

test('목업 사건의 취소 마감은 회차의 공연 시작에서 계산한 값과 같다', () => {
  for (const c of CASES) assert.equal(Date.parse(c.cancelDeadlineAt), Date.parse(cancelDeadlineAt(EVENT.startsAt)), c.caseId);
});

test('목업 묶음은 점수 원값·가중치를 갖지 않는다(범주만, POL-046 ⑦)', () => {
  for (const cl of CLUSTERS) {
    assert.ok(['HIGH', 'MEDIUM', 'LOW'].includes(cl.scoreBand), cl.clusterId);
    for (const k of Object.keys(cl)) assert.ok(!/score(?!Band)|weight/i.test(k), `${cl.clusterId}.${k}`);
  }
});

test('연결 그래프 목업의 IP 점은 가린 값(IPv4 /24, IPv6 /48)만 갖는다 [ASVS v5.0.0-14.2.6]', () => {
  for (const c of CASES) {
    const g = graphFor(c.caseId);
    for (const n of g.nodes.filter((x) => x.kind === 'IP')) assert.ok(isMaskedIpLabel(n.label), `${c.caseId} ${n.label}`);
  }
});

test('연결 그래프 점 ID는 사건 안에서 겹치지 않는 불투명한 값이고 표시값에서 나오지 않는다', () => {
  for (const c of CASES) {
    const g = graphFor(c.caseId);
    const ids = g.nodes.map((n) => n.nodeId);
    assert.equal(new Set(ids).size, ids.length, `${c.caseId} 점 ID 겹침`);
    for (const n of g.nodes) {
      assert.match(n.nodeId, /^n-[0-9a-f]{8}\d*$/, n.nodeId);
      // 표시값(계정 ID·가명·IP·ASN)의 글자 덩어리(4자 이상)가 점 ID에 들어가지 않는다
      for (const tok of n.label.split(/[^0-9a-z]+/i).filter((t) => t.length >= 4)) assert.ok(!n.nodeId.includes(tok), `${n.nodeId} ⊃ ${tok}`);
    }
    for (const e of g.edges) assert.ok(ids.includes(e.from) && ids.includes(e.to), `${c.caseId} 선의 끝이 없는 점`);
  }
});

test('원문 IP는 원문 열림 목업 하나뿐이고 문서용 대역이다 [ASVS v5.0.0-14.2.6]', () => {
  assert.match(REVEALED_IP.ip, /^203\.0\.113\.\d{1,3}$/);
  // 목업 값(그래프·게시물·사건)에는 원문 IP가 없다
  const text = JSON.stringify({ CASES, CLUSTERS, EXTERNAL_POSTS, graphs: CASES.map((c) => graphFor(c.caseId)) });
  assert.deepEqual(rawIps(text), []);
  // 화면 코드 파일에도 원문 IP 글이 없다(원문 열림 목업의 한 줄만 예외)
  for (const { f, text: src } of screenSources()) {
    const hits = rawIps(src).filter((ip) => !(f.endsWith('fixtures.ts') && ip === REVEALED_IP.ip));
    assert.deepEqual(hits, [], f);
  }
});

test('원문 IP 찾기는 /24가 붙은 원문과 IPv6 원문도 잡는다', () => {
  assert.deepEqual(rawIps('203.0.113.47/24'), ['203.0.113.47/24']);
  assert.deepEqual(rawIps('203.0.113.0/24 198.51.100.0/24'), []);
  assert.deepEqual(rawIps('2001:db8:4a1::7'), ['2001:db8:4a1::7']);
  assert.deepEqual(rawIps('2001:db8:4a1::/48 · 20:04:12 KST'), []);
});

test('기준 시각과 기본 사건의 남은 시간 글이 d5 그림과 같다', () => {
  assert.equal(formatKst(NOW), '10/19(월) 14:20');
  const c = CASES.find((x) => x.caseId === 'CASE-2610-0007');
  assert.ok(c);
  assert.equal(cancelDeadlineNotice(NOW, c.cancelDeadlineAt).text, '취소 마감까지 5일 1시간 남았습니다');
});

test('IP 가린 값 판정', () => {
  assert.equal(isMaskedIpLabel('203.0.113.0/24'), true);
  assert.equal(isMaskedIpLabel('2001:db8:4a1::/48'), true);
  assert.equal(isMaskedIpLabel('203.0.113.47'), false);
  assert.equal(isMaskedIpLabel('203.0.113.0/16'), false);
});
