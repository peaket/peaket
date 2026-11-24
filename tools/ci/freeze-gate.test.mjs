// F-02-3 승격 게이트 시험(정본: docs/devops.md §5.1·§5.3·§8.1·§8.2·§8.4, D-T2·D-T4·D-T5·D-T26, OPS-320).
// 실제 prod 값 파일·라벨·본문·git 이력을 임시 폴더에 만들어 게이트 판정만 본다.
// 실행: node --test tools/ci/freeze-gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  const hot = gate(root, { changedFiles: ['deploy/envs/prod/queue-svc.yaml'] });
  assert.equal(hot.decision, 'block');
  const hotGateway = gate(root, { changedFiles: ['deploy/gateways/routes/fan.yaml'] });
  assert.equal(hotGateway.decision, 'block');
  const normal = gate(root, { changedFiles: ['deploy/envs/prod/ticket-svc.yaml'] });
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
  writeFileSync(join(keduRel), 'service:\n  annotations:\n    autoscaling.keda.sh/paused-replicas: "0"\n');
  const keda = gate(root, { changedFiles: [keduRel], labels: ['emergency-change'], body: 'INC-8' });
  assert.equal(keda.decision, 'allow');
  assert.equal(keda.override?.shape, 'autoscale-pause');

  const infra = gate(root, { changedFiles: ['infra/stacks/prod/eks/main.tf'], labels: ['emergency-change'], body: 'INC-9' });
  assert.equal(infra.decision, 'block');
});

test('D-T26 ① 대형 창 안에서도 main 병합·태그는 되고 운영 승격만 창이 끝난 뒤 통과한다', () => {
  const root = rootWithCalendar([windowOf('large')]);
  assert.equal(gate(root, { changedFiles: ['deploy/envs/prod/queue-svc.yaml'] }).decision, 'block');
  assert.equal(gate(root, { nowMs: Date.parse('2026-11-24T12:00:00Z'), changedFiles: ['deploy/envs/prod/queue-svc.yaml'] }).decision, 'allow');
  // main 병합·태그는 코드·문서 파일만 바뀐 PR이라 게이트가 보지 않는다
  assert.equal(gate(root, { changedFiles: ['services/purchase-svc/src/main.ts', 'docs/PROGRESS.md'] }).decision, 'skip');
});

test('D-T26 ② 창 밖·데모 승격·코드 파일만 바뀐 PR은 건너뛴다', () => {
  const root = rootWithCalendar([windowOf('large')]);
  assert.equal(gate(root, { nowMs: Date.parse('2026-11-24T13:00:00Z'), changedFiles: ['deploy/envs/prod/queue-svc.yaml'] }).decision, 'allow');
  assert.equal(gate(root, { env: 'demo', changedFiles: ['deploy/envs/demo/queue-svc.yaml'] }).decision, 'skip');
  assert.equal(gate(root, { env: 'local', changedFiles: ['deploy/envs/local/queue-svc.yaml'] }).decision, 'skip');
  assert.equal(gate(root, { changedFiles: ['deploy/calendar/freeze.json'] }).decision, 'skip');
});

test('F023-GATE 여러 창 겹침·깨진 JSON·모르는 환경·플래그는 보수적으로 판정한다', () => {
  const root = rootWithCalendar([windowOf('large'), windowOf('small', E_SMALL)]);
  const both = gate(root, { changedFiles: ['deploy/envs/prod/queue-svc.yaml'] });
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
