// D-T18 ①의 kind 부분(docs/devops.md D-T18 ①, docs/infra.md RB-31, ADR-0070 결정 1 '수동' 1~6, ADR-0303 결정 3, BUILD_ORDER BAS-080).
// example-svc 복제 2를 AWS 흉내 서버(moto)의 증거 버킷과 함께 띄우고, 한 파드에 peaket.io/diagnose=heap@<지금>을 단다.
// 그 파드는 준비 아님 → 다시 뜸(재시작 +1) → 다시 준비. moto에 보고서·힙 스냅샷 객체(<서비스>/<파드>/<요청 시각>/<파일>, 보고서에 환경 변수 없음),
// 다시 뜬 뒤 30초 동안 객체 수 그대로(되풀이 없음), 그동안 Service로 보낸 요청의 오류 0. 주석부터 올리기까지 걸린 시간은
// docs/review/measurements 폴더의 새 파일 BAT-075-diagnose.md에 한 줄 더한다(devops.md 944행 '운영 진단 경로').
// 자격 증명은 가짜 값이다(흉내 서버는 서명을 검사하지 않는다). 버킷은 AWS CLI v2로 만든다(aws-emulator.e2e.mjs와 같은 길).
// 실행(저장소 뿌리): node tools/local/cluster.mjs up && node tools/local/cluster.mjs image && node --test --test-timeout=900000 tools/local/e2e/diagnose.e2e.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE, KUBECONFIG, kubectl } from '../cluster.mjs';
import { ensureTool } from '../tools.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const NS = 'diagnose-e2e';
const SERVICE = 'example-svc';
const BUCKET = 'peaket-diag-e2e';
const PORT = 16_000 + Math.floor(Math.random() * 1_000);
const MEASUREMENTS = join(REPO, 'docs', 'review', 'measurements', 'BAT-075-diagnose.md');
const AWS_ENV = { ...process.env, AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_DEFAULT_REGION: 'ap-northeast-2', AWS_PAGER: '', AWS_EC2_METADATA_DISABLED: 'true' };
const aws = (args) => JSON.parse(execFileSync('aws', ['--endpoint-url', `http://127.0.0.1:${PORT}`, '--output', 'json', ...args], { encoding: 'utf8', env: AWS_ENV }) || '{}');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, cond, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cond().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`기다림 한도: ${what}`);
    await sleep(1_000);
  }
}

const pods = async () => JSON.parse(await kubectl(['-n', NS, 'get', 'pods', '-l', 'app.kubernetes.io/component=service', '-o', 'json'])).items.filter((p) => !p.metadata.deletionTimestamp);
const podOf = async (name) => (await pods()).find((p) => p.metadata.name === name);
const isReady = (p) => p?.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') ?? false;
const restartsOf = (p) => p?.status.containerStatuses?.[0]?.restartCount ?? 0;
const objects = (prefix) => (aws(['s3api', 'list-objects-v2', '--bucket', BUCKET, '--prefix', prefix]).Contents ?? []).map((o) => o.Key);

/** 다른 파드 안에서 Service 주소로 요청을 흘리고, 끝나면 { ok, errors }를 표준 출력에 낸다 */
function trafficFrom(pod, seconds) {
  const script = `const end=Date.now()+${seconds * 1000};let ok=0,errors=0;(async()=>{while(Date.now()<end){try{const r=await fetch('http://${SERVICE}.${NS}.svc:8080/v1/example/notes/00000000-0000-4000-8000-000000000000',{headers:{'x-user-id':'acc-1','x-session-id':'s-1','x-user-aud':'fan'}});if(r.status>=500)errors++;else ok++;}catch{errors++}await new Promise(r=>setTimeout(r,100))}process.stdout.write(JSON.stringify({ok,errors}))})()`;
  return kubectl(['-n', NS, 'exec', pod, '--', 'node', '-e', script]).then((out) => JSON.parse(out.trim().split('\n').at(-1)));
}

test('D-T18 ①_kind_heap주석을단파드는_준비를내리고·보고서와스냅샷을moto에올리고·다시뜨며_되풀이없고_다른파드로간요청오류는0이다', { timeout: 900_000 }, async (t) => {
  const helm = await ensureTool('helm');
  const k = await ensureTool('kubectl');
  // ---- 증거 버킷(moto) ----
  const pf = spawn(k, ['--kubeconfig', KUBECONFIG, '-n', 'peaket-local', 'port-forward', 'svc/aws', `${PORT}:5000`], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => pf.kill());
  await new Promise((res, rej) => {
    pf.stdout.on('data', (d) => String(d).includes('Forwarding from') && res());
    pf.on('exit', (c) => rej(new Error(`port-forward 끝남 ${c}`)));
  });
  try {
    aws(['s3api', 'create-bucket', '--bucket', BUCKET, '--create-bucket-configuration', 'LocationConstraint=ap-northeast-2']);
  } catch (e) {
    if (!/BucketAlready/.test(String(e.stderr ?? e.message))) throw e;
  }

  // ---- 서비스 2복제(DB는 뼈대 마이그레이션을 건 example) ----
  execFileSync(helm, ['--kubeconfig', KUBECONFIG, 'uninstall', 'diag', '-n', NS, '--wait', '--ignore-not-found'], { stdio: 'inherit' });
  const psql = (sqlText, db = 'peaket') => kubectl(['-n', 'peaket-local', 'exec', '-i', 'deploy/postgres', '--', 'psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-qtA', '-f', '-'], { input: sqlText });
  await psql('drop database if exists diag_example with (force); create database diag_example;');
  await psql(
    ['0000_example_note.sql', '0001_idempotency_record.sql', '0002_outbox.sql', '0003_held_event_and_stat_snapshot.sql'].map((f) => readFileSync(join(REPO, 'packages', 'platform', 'template', 'migrations', f), 'utf8')).join('\n'),
    'diag_example',
  );
  const [repo, tag] = IMAGE.split(':');
  execFileSync(
    helm,
    [
      '--kubeconfig', KUBECONFIG, 'upgrade', '--install', 'diag', join(REPO, 'deploy', 'charts', 'peaket-service'),
      '-n', NS, '--create-namespace', '--wait', '--timeout', '300s',
      '--set', `name=${SERVICE}`, '--set', `image.repository=${repo}`, '--set', `image.tag=${tag}`, '--set', 'image.pullPolicy=Never',
      '--set', 'env.PEAKET_ENV=local', '--set', 'service.replicas=2',
      '--set', 'service.env.PEAKET_DATABASE_URL=postgres://postgres:peaket-local@postgres.peaket-local.svc:5432/diag_example',
      '--set', `diagnose.bucket=${BUCKET}`, '--set', 'diagnose.s3Endpoint=http://aws.peaket-local.svc:5000',
      '--set', 'service.env.AWS_ACCESS_KEY_ID=test', '--set', 'service.env.AWS_SECRET_ACCESS_KEY=test', '--set', 'service.env.AWS_REGION=ap-northeast-2',
    ],
    { stdio: 'inherit' },
  );
  const [target, other] = (await pods()).map((p) => p.metadata.name).sort();
  assert.ok(target && other, '파드 둘');
  const restarts0 = restartsOf(await podOf(target));
  const at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const prefix = `${SERVICE}/${target}/${at}/`;

  // ---- 주석을 단다(다른 파드에서 Service로 요청을 흘리면서) ----
  const traffic = trafficFrom(other, 150);
  const annotatedAt = Date.now();
  await kubectl(['-n', NS, 'annotate', 'pod', target, `peaket.io/diagnose=heap@${at}`, '--overwrite']);
  await until('준비 아님', async () => !isReady(await podOf(target)), 120_000);
  const uploaded = await until('증거 객체 둘', async () => {
    const keys = objects(prefix);
    return keys.some((key) => /\/report[^/]*\.json$/.test(key)) && keys.some((key) => /\.heapsnapshot$/.test(key)) ? keys : undefined;
  }, 180_000);
  const uploadMs = Date.now() - annotatedAt;
  await until('다시 뜸', async () => restartsOf(await podOf(target)) === restarts0 + 1, 180_000);
  await until('다시 준비', async () => isReady(await podOf(target)), 180_000);

  // 객체 이름은 <서비스>/<파드>/<요청 시각>/<파일>뿐이다
  for (const key of uploaded) assert.match(key, new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[A-Za-z0-9._-]+$`));
  // 보고서에 환경 변수 칸이 없다
  const dir = mkdtempSync(join(tmpdir(), 'peaket-diag-e2e-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const reportKey = uploaded.find((key) => /\/report[^/]*\.json$/.test(key));
  execFileSync('aws', ['--endpoint-url', `http://127.0.0.1:${PORT}`, 's3api', 'get-object', '--bucket', BUCKET, '--key', reportKey, join(dir, 'report.json')], { env: AWS_ENV, stdio: 'ignore' });
  const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  assert.ok(report.header, '진단 보고서');
  assert.equal('environmentVariables' in report, false);
  assert.equal(JSON.stringify(report).includes('AWS_SECRET_ACCESS_KEY'), false);

  // 다시 뜬 뒤 30초 동안 같은 수집을 되풀이하지 않는다(주석은 남아 있다)
  const count = objects(`${SERVICE}/`).length;
  await sleep(30_000);
  assert.equal(objects(`${SERVICE}/`).length, count);
  assert.equal(restartsOf(await podOf(target)), restarts0 + 1);
  assert.ok(isReady(await podOf(target)));

  const { ok, errors } = await traffic;
  assert.ok(ok > 0, '요청이 흘렀다');
  assert.equal(errors, 0, `Service로 보낸 요청 오류 ${errors}`);

  mkdirSync(dirname(MEASUREMENTS), { recursive: true });
  if (!existsSync(MEASUREMENTS)) {
    appendFileSync(
      MEASUREMENTS,
      '# BAT-075 진단 수집 주석부터 올리기까지(D-T18 ①)\n\n- **무엇**: tools/local/e2e/diagnose.e2e.mjs가 로컬 kind에서 잰 값이다. 검토 기록이고 규범이 아니다(정본은 docs/devops.md D-T18 ①·§15 \'운영 진단 경로\'). 운영 kubelet의 값은 클라우드 환경이 생긴 뒤 다시 잰다.\n\n| 날짜 | 요청 | 주석부터 객체 둘이 보이기까지(ms) | 객체 | 요청(성공·오류) |\n| --- | --- | --- | --- | --- |\n',
    );
  }
  appendFileSync(MEASUREMENTS, `| ${new Date().toISOString().slice(0, 10)} | heap | ${uploadMs} | ${uploaded.length} | ${ok}·${errors} |\n`);
  execFileSync(helm, ['--kubeconfig', KUBECONFIG, 'uninstall', 'diag', '-n', NS, '--wait', '--ignore-not-found'], { stdio: 'inherit' });
});
