// F-02-3 승격 게이트 시험(정본: docs/devops.md §5.1·§5.3·§8.1·§8.2·§8.4, D-T2·D-T4·D-T5·D-T26, OPS-320).
// 실제 prod 값 파일·라벨·본문·git 이력을 임시 폴더에 만들어 게이트 판정만 본다.
// 실행: node --test tools/ci/freeze-gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseAllDocuments } from 'yaml';
import { commit, repo, tempDir } from './git-fixture.mjs';
import { gatePromotion } from './freeze-gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const E_LARGE = '0192f3a4-1111-7abc-8def-0123456789ab';
const E_SMALL = '0192f3a4-3333-7abc-8def-0123456789ab';
const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const DIGEST_C = `sha256:${'c'.repeat(64)}`;
const NOW = Date.parse('2026-11-24T10:00:00Z');
const OPEN = '2026-11-24T11:00:00.000Z';

/** 대형(또는 소형) 창 하나를 담은 달력. D-T1의 20:00 KST 회차 */
const windowOf = (scale, eventId = E_LARGE) => ({
  eventId,
  scale,
  scope: scale === 'small' ? 'hotpath' : 'all',
  opensAt: OPEN,
  startsAt: scale === 'small' ? '2026-11-24T10:10:00.000Z' : '2026-11-24T09:30:00.000Z',
  endsAt: '2026-11-24T12:00:00.000Z',
  abortAt: scale === 'small' ? '2026-11-24T10:45:00.000Z' : '2026-11-24T10:15:00.000Z',
});

function rootWithCalendar(windows, renderedAt = '2026-11-24T09:00:00.000Z') {
  const root = tempDir('f023-gate-');
  mkdirSync(join(root, 'deploy', 'calendar'), { recursive: true });
  writeFileSync(
    join(root, 'deploy', 'calendar', 'freeze.json'),
    JSON.stringify({ schemaVersion: 1, revision: 3, renderedAt, windows, deployableHoursNext7d: { all: 165.5, hotpath: 165.5 } }),
  );
  return root;
}

const gate = (root, o = {}) =>
  gatePromotion({ root, nowMs: NOW, env: 'prod', changedFiles: [], labels: [], body: '', ...o });

const valueFile = (digest, extra = '') => `image:\n  repository: ghcr.io/peaket/queue-svc\n  digest: ${digest}\n${extra}`;
const calendarJson = (windows, renderedAt = '2026-11-24T09:00:00.000Z') =>
  JSON.stringify({ schemaVersion: 1, revision: 3, renderedAt, windows, deployableHoursNext7d: { all: 165.5, hotpath: 165.5 } });

test('D-T2 ① 대형 창 안의 운영 승격 PR은 막고 코드 병합·태그·데모 승격은 막지 않는다', () => {
  const root = rootWithCalendar([windowOf('large')]);
  const blocked = gate(root, { changedFiles: ['deploy/envs/prod/queue-svc.yaml'] });
  assert.equal(blocked.decision, 'block');
  assert.ok(blocked.reasons.some((r) => r.includes('freeze-window') && r.includes(E_LARGE)), JSON.stringify(blocked));

  const code = gate(root, { changedFiles: ['services/queue-svc/src/main.ts', 'docs/devops.md'] });
  assert.equal(code.decision, 'skip');
  const demo = gate(root, { env: 'demo', changedFiles: ['deploy/envs/demo/queue-svc.yaml'] });
  assert.equal(demo.decision, 'skip');
  const staging = gate(root, { env: 'staging', changedFiles: ['deploy/envs/staging/queue-svc.yaml'] });
  assert.equal(staging.decision, 'skip');
});

test('D-T2 ② 소형 창 안에서 핫패스 값 파일은 막고 일반 값 파일은 통과시킨다', () => {
  const root = rootWithCalendar([windowOf('small', E_SMALL)]);
  const now = Date.parse('2026-11-24T10:20:00Z'); // 소형 창(10:10Z~12:00Z) 안
  const hot = gate(root, { nowMs: now, changedFiles: ['deploy/envs/prod/queue-svc.yaml'] });
  assert.equal(hot.decision, 'block');
  const hotGateway = gate(root, { nowMs: now, changedFiles: ['deploy/gateways/routes/fan.yaml'] });
  assert.equal(hotGateway.decision, 'block');
  const normal = gate(root, { nowMs: now, changedFiles: ['deploy/envs/prod/ticket-svc.yaml'] });
  assert.equal(normal.decision, 'allow');
});

test('D-T4 ② 산출물이 없거나 2시간 넘게 낡으면 운영 승격을 막고 30분~2시간은 경고만 한다', () => {
  const missing = tempDir('f023-missing-');
  const m = gate(missing, { changedFiles: ['deploy/envs/prod/queue-svc.yaml'] });
  assert.equal(m.decision, 'block');
  assert.ok(m.reasons.some((r) => r.includes('calendar-missing')), JSON.stringify(m));

  const old = rootWithCalendar([windowOf('large')], '2026-11-24T07:59:59.999Z'); // 2시간 + 1ms
  const stale = gate(old, { changedFiles: ['deploy/envs/prod/queue-svc.yaml'] });
  assert.equal(stale.decision, 'block');
  assert.ok(stale.reasons.some((r) => r.includes('calendar-stale')), JSON.stringify(stale));

  const warning = rootWithCalendar([windowOf('large')], '2026-11-24T09:29:59.999Z'); // 30분 + 1ms
  const w = gate(warning, { changedFiles: ['deploy/envs/prod/queue-svc.yaml'] });
  assert.equal(w.decision, 'block'); // 창 안이라 경고와 별개로 막힌다
  assert.ok(w.warnings.some((x) => x.includes('calendar-stale')), JSON.stringify(w));

  const between = rootWithCalendar([], '2026-11-24T09:29:59.999Z');
  const b = gate(between, { changedFiles: ['deploy/envs/prod/queue-svc.yaml'] });
  assert.equal(b.decision, 'allow');
  assert.ok(b.warnings.some((x) => x.includes('calendar-stale')), JSON.stringify(b));

  const boundary = rootWithCalendar([], '2026-11-24T08:00:00.000Z'); // 꼭 2시간
  assert.equal(gate(boundary, { changedFiles: ['deploy/envs/prod/queue-svc.yaml'] }).decision, 'allow');
});

test('D-T4 ③ 달력 장애 경보와 T-30 기록 규칙이 정본 값으로 있다', () => {
  const text = readFileSync(join(REPO, 'deploy', 'platform', 'observability', 'rules', 'freeze.yaml'), 'utf8');
  const docs = parseAllDocuments(text)
    .map((d) => d.toJS())
    .filter(Boolean);
  const rules = docs.flatMap((d) => d.spec?.groups ?? []).flatMap((g) => g.rules ?? []);
  const stale = rules.find((r) => r.alert === 'FreezeCalendarStale');
  assert.ok(stale, 'FreezeCalendarStale 경보가 없다');
  assert.match(String(stale.expr), /freeze_calendar_last_render_timestamp/);
  assert.match(String(stale.expr), />\s*1800/);
  assert.equal(stale.labels?.severity, 'sev2');
  assert.equal(stale.labels?.kind, 'cause');
  assert.match(String(stale.annotations?.runbook_url), /RB-28|rb-28/i);
  assert.equal(stale.annotations?.game_day, 'G-19');
  assert.ok(rules.some((r) => r.record === 'peaket:readiness:freeze_window' && String(r.expr).includes('freeze_window_active') && String(r.expr).includes('10m')));
  assert.ok(rules.some((r) => r.record === 'peaket:readiness:deployments' && String(r.expr).includes('freeze_rollouts_in_progress') && String(r.expr).includes('bool 0')));
});

/** prod 값 파일 하나를 git 이력에 A → B로 쌓고, 현재 작업 트리를 A로 되돌린다 */
function rollbackRepo(digest = DIGEST_A) {
  const root = repo('f023-rollback-');
  const rel = 'deploy/envs/prod/queue-svc.yaml';
  const file = (d) => `image:\n  repository: ghcr.io/peaket/queue-svc\n  digest: ${d}\n`;
  commit(root, { [rel]: file(DIGEST_A) }, 'A');
  commit(root, { [rel]: file(DIGEST_B) }, 'B');
  writeFileSync(join(root, rel), file(digest));
  mkdirSync(join(root, 'deploy', 'calendar'), { recursive: true });
  writeFileSync(join(root, 'deploy', 'calendar', 'freeze.json'), JSON.stringify({ schemaVersion: 1, revision: 2, renderedAt: '2026-11-24T09:00:00.000Z', windows: [windowOf('large')] }));
  return { root, rel };
}

test('D-T5 ① 긴급 변경 라벨·인시던트·이전 다이제스트 되돌리기는 창 안에서 통과하고 감사 기록을 돌려준다', () => {
  const { root, rel } = rollbackRepo(DIGEST_A);
  const r = gate(root, { changedFiles: [rel], labels: ['emergency-change'], body: 'INC-123 되돌림' });
  assert.equal(r.decision, 'allow');
  assert.deepEqual(r.override, { label: 'emergency-change', incident: 'INC-123', shape: 'rollback' });
  assert.deepEqual(r.audit, { kind: 'security', event: 'freeze_override', label: 'emergency-change', incident: 'INC-123', shape: 'rollback' });
});

test('D-T5 ② 새 다이제스트·모양 밖 변경·라벨만 있음·인시던트만 있음은 거부된다', () => {
  const { root, rel } = rollbackRepo(DIGEST_C);
  const newDigest = gate(root, { changedFiles: [rel], labels: ['emergency-change'], body: 'INC-123' });
  assert.equal(newDigest.decision, 'block');
  assert.ok(newDigest.reasons.some((x) => x.includes('emergency')), JSON.stringify(newDigest));

  const labelOnly = gate(root, { changedFiles: [rel], labels: ['emergency-change'], body: '핫픽스' });
  assert.equal(labelOnly.decision, 'block');
  const incidentOnly = gate(root, { changedFiles: [rel], labels: [], body: 'INC-123' });
  assert.equal(incidentOnly.decision, 'block');
});

test('D-T5 ② 다른 가지에만 있는 다이제스트는 되돌리기로 보지 않는다', () => {
  const root = repo('f023-rollback-branch-');
  const rel = 'deploy/envs/prod/queue-svc.yaml';
  const file = (d) => `image:\n  repository: ghcr.io/peaket/queue-svc\n  digest: ${d}\n`;
  commit(root, { [rel]: file(DIGEST_A) }, 'A');
  commit(root, { [rel]: file(DIGEST_B) }, 'B');
  // 대상 가지(main)에 없는 새 다이제스트를 다른 가지에만 둔다
  execFileSync('git', ['checkout', '-q', '-b', 'evil'], { cwd: root });
  commit(root, { [rel]: file(DIGEST_C) }, 'C');
  execFileSync('git', ['checkout', '-q', 'main'], { cwd: root });
  writeFileSync(join(root, rel), file(DIGEST_C));
  mkdirSync(join(root, 'deploy', 'calendar'), { recursive: true });
  writeFileSync(join(root, 'deploy', 'calendar', 'freeze.json'), JSON.stringify({ schemaVersion: 1, revision: 2, renderedAt: '2026-11-24T09:00:00.000Z', windows: [windowOf('large')] }));
  const r = gate(root, { changedFiles: [rel], labels: ['emergency-change'], body: 'INC-124' });
  assert.equal(r.decision, 'block', JSON.stringify(r));
});

test('D-T5 ③ 플래그 끄기와 KEDA 오토스케일 정지는 통과하고 그 밖의 인프라 변경은 거부된다', () => {
  const root = rootWithCalendar([windowOf('large')]);
  const flagRel = 'deploy/envs/prod/flags/search.yaml';
  mkdirSync(join(root, 'deploy', 'envs', 'prod', 'flags'), { recursive: true });
  writeFileSync(join(root, flagRel), 'enabled: false\n');
  const flag = gate(root, { changedFiles: [flagRel], labels: ['emergency-change'], body: 'INC-7' });
  assert.equal(flag.decision, 'allow');
  assert.equal(flag.override?.shape, 'flag-off');

  const keduRel = 'deploy/envs/prod/queue-svc.yaml';
  mkdirSync(join(root, 'deploy', 'envs', 'prod'), { recursive: true });
  writeFileSync(join(root, keduRel), 'service:\n  annotations:\n    autoscaling.keda.sh/paused-replicas: "0"\n');
  const keda = gate(root, { changedFiles: [keduRel], labels: ['emergency-change'], body: 'INC-8' });
  assert.equal(keda.decision, 'allow');
  assert.equal(keda.override?.shape, 'autoscale-pause');

  const infra = gate(root, { changedFiles: ['infra/stacks/prod/eks/main.tf'], labels: ['emergency-change'], body: 'INC-9' });
  assert.equal(infra.decision, 'block');
});

test('D-T26 ① 대형 창 안에서도 main 병합·태그는 되고 운영 승격만 창이 끝난 뒤 통과한다', () => {
  // 달력은 10분마다 갱신된다. 창이 끝난 시각에도 달력은 최신이라고 본다
  const root = rootWithCalendar([windowOf('large')], '2026-11-24T11:55:00.000Z');
  assert.equal(gate(root, { changedFiles: ['deploy/envs/prod/queue-svc.yaml'] }).decision, 'block');
  assert.equal(gate(root, { nowMs: Date.parse('2026-11-24T12:00:00Z'), changedFiles: ['deploy/envs/prod/queue-svc.yaml'] }).decision, 'allow');
  // main 병합·태그는 코드·문서 파일만 바뀐 PR이라 게이트가 보지 않는다
  assert.equal(gate(root, { changedFiles: ['services/purchase-svc/src/main.ts', 'docs/PROGRESS.md'] }).decision, 'skip');
});

test('D-T26 ② 창 밖·데모 승격·코드 파일만 바뀐 PR은 건너뛴다', () => {
  const root = rootWithCalendar([windowOf('large')], '2026-11-24T12:55:00.000Z');
  assert.equal(gate(root, { nowMs: Date.parse('2026-11-24T13:00:00Z'), changedFiles: ['deploy/envs/prod/queue-svc.yaml'] }).decision, 'allow');
  assert.equal(gate(root, { env: 'demo', changedFiles: ['deploy/envs/demo/queue-svc.yaml'] }).decision, 'skip');
  assert.equal(gate(root, { env: 'local', changedFiles: ['deploy/envs/local/queue-svc.yaml'] }).decision, 'skip');
  assert.equal(gate(root, { changedFiles: ['deploy/calendar/freeze.json'] }).decision, 'skip');
});

test('F023-GATE 여러 창 겹침·깨진 JSON·모르는 환경·플래그는 보수적으로 판정한다', () => {
  const root = rootWithCalendar([windowOf('large'), windowOf('small', E_SMALL)]);
  const both = gate(root, { nowMs: Date.parse('2026-11-24T10:20:00Z'), changedFiles: ['deploy/envs/prod/queue-svc.yaml'] });
  assert.equal(both.decision, 'block');
  assert.ok(both.reasons.some((r) => r.includes(E_LARGE)), JSON.stringify(both));
  assert.ok(both.reasons.some((r) => r.includes(E_SMALL)), JSON.stringify(both));

  const broken = rootWithCalendar([]);
  writeFileSync(join(broken, 'deploy', 'calendar', 'freeze.json'), '{');
  const b = gate(broken, { changedFiles: ['deploy/envs/prod/queue-svc.yaml'] });
  assert.equal(b.decision, 'block');
  assert.ok(b.reasons.some((x) => x.includes('calendar-unreadable')), JSON.stringify(b));

  // 큰 창에서 플래그 파일은 막는다(모든 운영 변경)
  mkdirSync(join(root, 'deploy', 'envs', 'prod', 'flags'), { recursive: true });
  writeFileSync(join(root, 'deploy/envs/prod/flags/search.yaml'), 'enabled: false\n');
  assert.equal(gate(root, { changedFiles: ['deploy/envs/prod/flags/search.yaml'] }).decision, 'block');
});

// ===================== 구현 리뷰 IR-01~IR-04 재현 =====================

test('IR-01 ① 승격 PR이 달력을 빈 창으로 바꿔도 기준 가지의 창으로 막는다', () => {
  const root = repo('f023-ir01-');
  const calRel = 'deploy/calendar/freeze.json';
  const prodRel = 'deploy/envs/prod/queue-svc.yaml';
  const base = commit(root, {
    [calRel]: calendarJson([windowOf('large')]),
    [prodRel]: valueFile(DIGEST_B),
  }, 'base');
  // PR 작업 트리: 달력을 지우고 운영 값을 바꾼다
  writeFileSync(join(root, calRel), calendarJson([]));
  writeFileSync(join(root, prodRel), valueFile(DIGEST_A));
  const g = gatePromotion({
    root,
    baseRef: base,
    nowMs: NOW,
    env: 'prod',
    changedFiles: [prodRel, calRel],
    labels: [],
    body: '',
  });
  assert.equal(g.decision, 'block', JSON.stringify(g));
  assert.ok(g.reasons.some((r) => r.includes('freeze-window-active')), JSON.stringify(g));
  assert.ok(g.notes.includes('calendar-changed-in-pr'), JSON.stringify(g));

  // 달력만 바꾼 PR은 skip이되 별도 검토 표시를 남긴다
  const only = gatePromotion({ root, baseRef: base, nowMs: NOW, env: 'prod', changedFiles: [calRel] });
  assert.equal(only.decision, 'skip');
  assert.ok(only.notes.includes('calendar-changed-in-pr'), JSON.stringify(only));
});

test('IR-02 ① 다이제스트가 그대로여도 replicaCount가 바뀌면 긴급 되돌리기가 아니다', () => {
  const root = repo('f023-ir02-a-');
  const rel = 'deploy/envs/prod/queue-svc.yaml';
  commit(root, { [rel]: valueFile(DIGEST_A) }, 'A');
  const base = commit(root, { [rel]: valueFile(DIGEST_B), 'deploy/calendar/freeze.json': calendarJson([windowOf('large')]) }, 'B');
  writeFileSync(join(root, 'deploy/calendar/freeze.json'), calendarJson([windowOf('large')]));
  writeFileSync(join(root, rel), valueFile(DIGEST_A, 'replicaCount: 50\n'));
  const g = gatePromotion({ root, baseRef: base, nowMs: NOW, env: 'prod', changedFiles: [rel], labels: ['emergency-change'], body: 'INC-101' });
  assert.equal(g.decision, 'block', JSON.stringify(g));
});

test('IR-02 ② 새 다이제스트에 KEDA 정지 주석을 더해도 통과하지 않는다', () => {
  const root = repo('f023-ir02-b-');
  const rel = 'deploy/envs/prod/queue-svc.yaml';
  commit(root, { [rel]: valueFile(DIGEST_A) }, 'A');
  const base = commit(root, { [rel]: valueFile(DIGEST_B), 'deploy/calendar/freeze.json': calendarJson([windowOf('large')]) }, 'B');
  writeFileSync(join(root, 'deploy/calendar/freeze.json'), calendarJson([windowOf('large')]));
  writeFileSync(join(root, rel), valueFile(DIGEST_C, 'service:\n  annotations:\n    autoscaling.keda.sh/paused-replicas: "0"\n'));
  const g = gatePromotion({ root, baseRef: base, nowMs: NOW, env: 'prod', changedFiles: [rel], labels: ['emergency-change'], body: 'INC-102' });
  assert.equal(g.decision, 'block', JSON.stringify(g));
});

test('IR-02 ③ 같은 저장소의 이전 다이제스트만 바꾸면 되돌리기로 통과한다', () => {
  const root = repo('f023-ir02-c-');
  const rel = 'deploy/envs/prod/queue-svc.yaml';
  commit(root, { [rel]: valueFile(DIGEST_A) }, 'A');
  const base = commit(root, { [rel]: valueFile(DIGEST_B), 'deploy/calendar/freeze.json': calendarJson([windowOf('large')]) }, 'B');
  writeFileSync(join(root, 'deploy/calendar/freeze.json'), calendarJson([windowOf('large')]));
  writeFileSync(join(root, rel), valueFile(DIGEST_A));
  const g = gatePromotion({ root, baseRef: base, nowMs: NOW, env: 'prod', changedFiles: [rel], labels: ['emergency-change'], body: 'INC-103' });
  assert.equal(g.decision, 'allow', JSON.stringify(g));
  assert.equal(g.override?.shape, 'rollback');
});

test('IR-02 ④ 이미지 저장소가 바뀌면 이전 다이제스트라도 되돌리기로 보지 않는다', () => {
  const root = repo('f023-ir02-d-');
  const rel = 'deploy/envs/prod/queue-svc.yaml';
  const other = (digest) => `image:\n  repository: ghcr.io/evil/queue-svc\n  digest: ${digest}\n`;
  commit(root, { [rel]: other(DIGEST_A) }, 'A');
  const base = commit(root, { [rel]: valueFile(DIGEST_B), 'deploy/calendar/freeze.json': calendarJson([windowOf('large')]) }, 'B');
  writeFileSync(join(root, 'deploy/calendar/freeze.json'), calendarJson([windowOf('large')]));
  writeFileSync(join(root, rel), other(DIGEST_A));
  const g = gatePromotion({ root, baseRef: base, nowMs: NOW, env: 'prod', changedFiles: [rel], labels: ['emergency-change'], body: 'INC-104' });
  assert.equal(g.decision, 'block', JSON.stringify(g));
});

test('IR-02 ⑤ 게이트웨이 이미지 되돌리기도 같은 저장소·이전 다이제스트 규칙으로 통과한다', () => {
  const root = repo('f023-ir02-e-');
  const rel = 'deploy/gateways/proxy.yaml';
  const image = (digest) => `image:\n  repository: ghcr.io/peaket/gw-fan\n  digest: ${digest}\n`;
  commit(root, { [rel]: image(DIGEST_A) }, 'A');
  const base = commit(root, { [rel]: image(DIGEST_B), 'deploy/calendar/freeze.json': calendarJson([windowOf('large')]) }, 'B');
  writeFileSync(join(root, 'deploy/calendar/freeze.json'), calendarJson([windowOf('large')]));
  writeFileSync(join(root, rel), image(DIGEST_A));
  const g = gatePromotion({ root, baseRef: base, nowMs: NOW, env: 'prod', changedFiles: [rel], labels: ['emergency-change'], body: 'INC-105' });
  assert.equal(g.decision, 'allow', JSON.stringify(g));
  assert.equal(g.override?.shape, 'rollback');
});

test('IR-02 ⑥ 플래그 값과 다른 값이 함께 바뀌면 끄기로 보지 않는다', () => {
  const root = repo('f023-ir02-f-');
  const rel = 'deploy/envs/prod/flags/search.yaml';
  commit(root, { [rel]: 'enabled: true\nreplicaCount: 5\n' }, 'on');
  const base = commit(root, { [rel]: 'enabled: true\nreplicaCount: 5\n', 'deploy/calendar/freeze.json': calendarJson([windowOf('large')]) }, 'base');
  writeFileSync(join(root, 'deploy/calendar/freeze.json'), calendarJson([windowOf('large')]));
  writeFileSync(join(root, rel), 'enabled: false\nreplicaCount: 6\n');
  const g = gatePromotion({ root, baseRef: base, nowMs: NOW, env: 'prod', changedFiles: [rel], labels: ['emergency-change'], body: 'INC-106' });
  assert.equal(g.decision, 'block', JSON.stringify(g));
});

test('IR-03 ① 전체 이력 복제는 두 판 전 다이제스트 되돌리기를 통과시킨다', () => {
  const origin = repo('f023-ir03-origin-');
  const rel = 'deploy/envs/prod/queue-svc.yaml';
  commit(origin, { [rel]: valueFile(DIGEST_A), 'deploy/calendar/freeze.json': calendarJson([windowOf('large')]) }, 'A');
  commit(origin, { [rel]: valueFile(DIGEST_B) }, 'B');
  commit(origin, { [rel]: valueFile(DIGEST_C) }, 'C');
  const full = join(tempDir('f023-ir03-full-'), 'repo');
  execFileSync('git', ['clone', '--quiet', pathToFileURL(origin).href, full]);
  writeFileSync(join(full, rel), valueFile(DIGEST_A));
  const g = gatePromotion({ root: full, baseRef: 'HEAD', nowMs: NOW, env: 'prod', changedFiles: [rel], labels: ['emergency-change'], body: 'INC-201' });
  assert.equal(g.decision, 'allow', JSON.stringify(g));
  assert.equal(g.override?.shape, 'rollback');
});

test('IR-03 ② 깊이 1 복제는 두 판 전 다이제스트를 볼 수 없어 막는다(그래서 CI가 전체 이력을 받아야 한다)', () => {
  const origin = repo('f023-ir03-origin2-');
  const rel = 'deploy/envs/prod/queue-svc.yaml';
  commit(origin, { [rel]: valueFile(DIGEST_A), 'deploy/calendar/freeze.json': calendarJson([windowOf('large')]) }, 'A');
  commit(origin, { [rel]: valueFile(DIGEST_B) }, 'B');
  commit(origin, { [rel]: valueFile(DIGEST_C) }, 'C');
  const shallow = join(tempDir('f023-ir03-shallow-'), 'repo');
  execFileSync('git', ['clone', '--quiet', '--depth=1', pathToFileURL(origin).href, shallow]);
  writeFileSync(join(shallow, rel), valueFile(DIGEST_A));
  const g = gatePromotion({ root: shallow, baseRef: 'HEAD', nowMs: NOW, env: 'prod', changedFiles: [rel], labels: ['emergency-change'], body: 'INC-202' });
  assert.equal(g.decision, 'block', JSON.stringify(g));
});

test('IR-03 ③ gitops-check 워크플로가 되돌리기에 필요한 전체 이력을 받는다', () => {
  const text = readFileSync(join(REPO, '.github', 'workflows', 'gitops-check.yml'), 'utf8');
  assert.match(text, /fetch-depth:\s*0/, 'actions/checkout에 fetch-depth: 0이 없다');
  assert.doesNotMatch(text, /--depth=1/, '기준 가지 fetch가 깊이 1로 이력을 자른다');
});

test('IR-04 ① T-30 동결 기록 규칙이 scope 0과 hotpath 1을 합쳐 1로 본다', () => {
  const text = readFileSync(join(REPO, 'deploy', 'platform', 'observability', 'rules', 'freeze.yaml'), 'utf8');
  const docs = parseAllDocuments(text).map((d) => d.toJS()).filter(Boolean);
  const rules = docs.flatMap((d) => d.spec?.groups ?? []).flatMap((g) => g.rules ?? []);
  const record = rules.find((r) => r.record === 'peaket:readiness:freeze_window');
  assert.ok(record, 'peaket:readiness:freeze_window 기록 규칙이 없다');
  const expr = String(record.expr);
  assert.match(expr, /max\(max_over_time\(freeze_window_active\[10m\]\)\)/, expr);
  assert.match(expr, /or\s+vector\(0\)/, expr);
  assert.doesNotMatch(expr, /\{scope=/, 'scope별 or는 0을 빈 벡터로 보지 않아 소형 창을 놓친다');
});

test('IR-02 ⑦ 인프라 이미지 되돌리기도 같은 저장소·이전 다이제스트 규칙으로 통과한다', () => {
  const root = repo('f023-ir02-g-');
  const rel = 'infra/stacks/prod/edge/images.yaml';
  const image = (digest) => `image:\n  repository: ghcr.io/peaket/edge\n  digest: ${digest}\n`;
  commit(root, { [rel]: image(DIGEST_A) }, 'A');
  const base = commit(root, { [rel]: image(DIGEST_B), 'deploy/calendar/freeze.json': calendarJson([windowOf('large')]) }, 'B');
  writeFileSync(join(root, 'deploy/calendar/freeze.json'), calendarJson([windowOf('large')]));
  writeFileSync(join(root, rel), image(DIGEST_A));
  const g = gatePromotion({ root, baseRef: base, nowMs: NOW, env: 'prod', changedFiles: [rel], labels: ['emergency-change'], body: 'INC-107' });
  assert.equal(g.decision, 'allow', JSON.stringify(g));
  assert.equal(g.override?.shape, 'rollback');
});
