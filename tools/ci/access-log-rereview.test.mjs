// F-01-8 다시 보기 IR-08·13·17~20·22 재현 시험(2026-11-24).
// 설정 글·정본 계약·CLI 동작을 읽어 다시 보기 지적이 재발하면 실패한다.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { identityGaps } from './access-log-reconcile.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

test('IR-08③ IR-17 게이트웨이 관리 줄은 sub를 account_id로 남기고 is_admin=1이며 조사 줄은 eventId·accountId를 채운다', () => {
  const c = read('deploy/platform/observability/collector/access-log.yaml');
  assert.match(c, /set\(attributes\["account_id"\], attributes\["sub"\]\)/);
  assert.match(c, /set\(attributes\["is_admin"\], 1\) where IsMatch\(attributes\["path"\], "\^\/v1\/\(ops\|partner\)\//);
  assert.match(c, /set\(attributes\["eventId"\], attributes\["path"\]\)/);
  assert.match(c, /replace_pattern\(attributes\["eventId"\], "\^\/v1\/events\/\(\[\^\/\]\+\)\/\.\*\$", "\$\$1"\)/);
  assert.match(c, /set\(attributes\["accountId"\], attributes\["account_id"\]\)/);
  assert.match(c, /"eventId", "journeyId", "accountId"/);
  // sub를 지우기 전에 account_id로 옮긴다
  const norm = c.indexOf('set(attributes["account_id"], attributes["sub"])');
  const strip = c.indexOf('transform/strip-investigation');
  assert.ok(norm > 0 && norm < strip, 'account_id 보존이 strip보다 뒤다');
});

test('IR-13③ 로그인 성공·실패 줄이 같은 요청 ID를 쓰고 gRPC는 x-request-id 메타데이터를 읽는다', () => {
  const c = read('services/identity-svc/src/modules/session/application/create-session.ts');
  assert.match(c, /recordLegalAccess\(\{ event: 'LOGIN', result: 'SUCCESS'[^}]*requestId: i\.requestId \?\? r\.sessionId/);
  assert.match(c, /recordLegalAccess\(\{ event: 'LOGIN', result: 'FAILED'[^}]*requestId: i\.requestId/);
  const g = read('services/identity-svc/src/modules/session/inbound/session.grpc.ts');
  assert.match(g, /metadata|get\('x-request-id'\)/);
  // asyncapi의 InvestigationRequest.requestId는 x-request-id다. 같은 요청을 법정 줄과 조사 사본에서 맞춘다.
  const a = read('docs/api/asyncapi.yaml');
  assert.match(a, /requestId: \{ type: string, description: "x-request-id/);
  // seq 파일은 /tmp가 아니라 배포가 영속 볼륨으로 마운트하는 자리다
  const l = read('services/identity-svc/src/modules/session/legal-access-log.ts');
  assert.match(l, /\/var\/lib\/identity\/legal-access-seq/);
  const v = read('deploy/workloads/identity-svc/values.yaml');
  assert.match(v, /PEAKET_LEGAL_ACCESS_SEQ_FILE: \/var\/lib\/identity\/legal-access-seq/);
  assert.match(v, /persistentVolumeClaim/);
  assert.match(read('deploy/charts/peaket-service/templates/persistence.yaml'), /kind: PersistentVolumeClaim/);
});

test('IR-18 identity factors를 수집기에서 쉼표 글로 바꾸고 MV가 그 꼴로 나눈다', () => {
  const c = read('deploy/platform/observability/collector/access-log.yaml');
  assert.match(c, /Concat\(attributes\["factors"\], ","\)/);
  const d = read('data/clickhouse/access-log/001_access_log.sql');
  assert.match(d, /splitByChar\(',', LogAttributes\['factors'\]\)/);
});

test('IR-20 CronJob 시간대를 Asia/Seoul로 고정하고 경보 식도 KST로 비교한다', () => {
  const j = read('deploy/platform/observability/access-log/jobs.yaml');
  assert.match(j, /timeZone:\s*Asia\/Seoul/);
  const a = read('deploy/platform/observability/alerts/access-log.yaml');
  assert.match(a, /9\s*\*\s*3600/);
  assert.match(a, /hour\(vector\(time\(\)\) \+ 9 \* 3600\)\s*>=\s*6/);
});

test('IR-22 5분 대조가 gateway와 identity 파드별로 나뉘고 파드 하나의 빈 번호를 센다', () => {
  const src = read('tools/local/access-log-jobs.mjs');
  assert.match(src, /source='gateway'/);
  assert.match(src, /GROUP BY pod/);
  assert.deepEqual(identityGaps([{ pod: 'identity-a', seqs: [1, 2, 3] }, { pod: 'identity-b', seqs: [1, 3] }]), [
    { pod: 'identity-a', missing: [], duplicates: [] },
    { pod: 'identity-b', missing: [2], duplicates: [] },
  ]);
});

test('IR-19 --envoy 응답이 비면 확인 불가로 종료 1이다', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [] } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address()).port;
  const cli = join(ROOT, 'tools/local/access-log-jobs.mjs');
  const child = spawn(process.execPath, [cli, '--reconcile', '--envoy', `http://127.0.0.1:${port}`, '--rows', '100'], { cwd: ROOT });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const code = await new Promise((r) => child.on('close', r));
  server.close();
  assert.equal(code, 1, out);
  assert.match(out, /"verifiable":false/);
  assert.match(out, /"shortfall":null/);
});
