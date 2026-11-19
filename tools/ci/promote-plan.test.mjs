// 승격 PR 계획(tools/ci/promote-plan.mjs)의 단위 시험(묶음 BAT-080 G7, ADR-0310).
// 정본: docs/devops.md §5.3 '승격 흐름' — 같은 다이제스트만 쓰고 다시 빌드하지 않는다. 데모는 검사 통과 뒤 자동 병합,
// 운영은 사람이 병합하며, 동결 창·조치 기한·Pact·arm64 스모크가 필수 조건이다. 가지 이름은 promote/<환경>-<태그>다.
// 실행(저장소 뿌리): node --test tools/ci/promote-plan.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  applyPlan,
  checkPlan,
  main,
  parseCandidates,
  promotionBody,
  promotionPlan,
  readDigest,
  setDigest,
} from './promote-plan.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const roots = [];
process.on('exit', () => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});
/** 새 임시 뿌리(deploy/envs/<환경>을 그 아래 만든다) */
function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'promote-plan-'));
  roots.push(dir);
  return dir;
}
const sha = (c) => `sha256:${c.repeat(64)}`;
/** 값 파일 하나를 만든다. text가 없으면 만들지 않는다 */
function valueFile(root, env, service, text) {
  if (text === undefined) return;
  const file = join(root, 'deploy', 'envs', env, `${service}.yaml`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}
const OLD = 'image:\n  repository: ghcr.io/peaket/purchase-svc\n  digest: ' + sha('a') + '\n';
const COMMENTED = '# 환경 값(docs/devops.md §5.3)\nname: purchase-svc\n\n' + OLD + '\nenv:\n  PEAKET_ENV: demo\n';

test('PR-01 후보다이제스트로_바뀐배포단위만image.digest를바꾸고_같은다이제스트는그대로_다시빌드하지않는다', () => {
  const root = tempRoot();
  valueFile(root, 'demo', 'purchase-svc', COMMENTED);
  valueFile(root, 'demo', 'ticket-svc', 'name: ticket-svc\nimage:\n  repository: ghcr.io/peaket/ticket-svc\n  digest: ' + sha('c') + '\n');
  const candidates = parseCandidates(
    JSON.stringify([
      { service: 'purchase-svc', digest: sha('b') },
      { service: 'queue-svc', repository: 'ghcr.io/peaket/queue-svc', digest: sha('d') },
      { service: 'ticket-svc', digest: sha('c') },
    ]),
  );
  const plan = promotionPlan({ env: 'demo', tag: 'v1.2.3', candidates, root });
  assert.deepEqual(
    plan.entries.map((e) => [e.service, e.action]),
    [
      ['purchase-svc', 'update'],
      ['queue-svc', 'create'],
      ['ticket-svc', 'unchanged'],
    ],
  );
  assert.deepEqual(plan.changes.map((e) => e.service), ['purchase-svc', 'queue-svc']);
  assert.deepEqual(plan.unchanged.map((e) => e.service), ['ticket-svc']);

  const written = applyPlan(plan, root);
  assert.deepEqual(written.map((w) => [w.service, w.action]), [
    ['purchase-svc', 'update'],
    ['queue-svc', 'create'],
  ]);
  const purchase = readFileSync(join(root, 'deploy', 'envs', 'demo', 'purchase-svc.yaml'), 'utf8');
  assert.equal(readDigest(purchase), sha('b'), '바뀐 배포 단위의 digest');
  assert.match(purchase, /^# 환경 값/m, '주석을 지웠다');
  assert.match(purchase, /repository: ghcr\.io\/peaket\/purchase-svc/, '저장소 이름을 지웠다');
  const created = readFileSync(join(root, 'deploy', 'envs', 'demo', 'queue-svc.yaml'), 'utf8');
  assert.equal(readDigest(created), sha('d'));
  assert.match(created, /^name: queue-svc$/m);
  assert.match(created, /PEAKET_ENV: demo/);
  // 다시 빌드하지 않는다: 새 파일에 태그가 없고 후보의 다이제스트만 쓴다
  assert.doesNotMatch(created, /^\s*tag:/m);
  assert.doesNotMatch(created, /:v1\.2\.3/);
  // 바뀌지 않은 배포 단위는 손대지 않는다
  assert.equal(readFileSync(join(root, 'deploy', 'envs', 'demo', 'ticket-svc.yaml'), 'utf8'), 'name: ticket-svc\nimage:\n  repository: ghcr.io/peaket/ticket-svc\n  digest: ' + sha('c') + '\n');
  // 태그·주소에 태그가 붙은 저장소는 받지 않는다(같은 다이제스트만 쓴다)
  assert.throws(() => parseCandidates(JSON.stringify([{ service: 'purchase-svc', digest: 'v1.2.3' }])), /sha256/);
  assert.throws(() => parseCandidates(JSON.stringify([{ service: 'purchase-svc', repository: 'ghcr.io/peaket/purchase-svc:v1.2.3', digest: sha('b') }])), /태그/);
  // 값 파일 digest 줄만 바꾸고 다른 칸은 그대로다
  const edited = setDigest(COMMENTED, sha('e'));
  assert.match(edited, /^# 환경 값/m);
  assert.match(edited, /PEAKET_ENV: demo/);
  assert.equal((edited.match(/digest:/g) ?? []).length, 1);
});

test('PR-02 --check는_다른다이제스트·없는파일을어긋남으로_같은다이제스트는통과로본다', () => {
  const root = tempRoot();
  valueFile(root, 'prod', 'purchase-svc', OLD);
  valueFile(root, 'prod', 'ticket-svc', 'image:\n  digest: ' + sha('c') + '\n');
  const cand = (list) => {
    const file = join(root, 'candidates.json');
    writeFileSync(file, JSON.stringify(list));
    return file;
  };
  // 같은 다이제스트 → 통과
  const same = promotionPlan({ env: 'prod', tag: 'v2.0.0', candidates: parseCandidates(JSON.stringify([{ service: 'purchase-svc', digest: sha('a') }])), root });
  assert.deepEqual(checkPlan(same, root), { ok: true, mismatches: [] });
  assert.equal(main(['--env', 'prod', '--tag', 'v2.0.0', '--candidates', cand([{ service: 'purchase-svc', digest: sha('a') }]), '--check', '--root', root]), 0);
  // 다른 다이제스트 → 어긋남(무엇이 다른지 남긴다)
  const diff = promotionPlan({ env: 'prod', tag: 'v2.0.0', candidates: parseCandidates(JSON.stringify([{ service: 'purchase-svc', digest: sha('b') }])), root });
  const r = checkPlan(diff, root);
  assert.equal(r.ok, false);
  assert.deepEqual(r.mismatches, [{ service: 'purchase-svc', file: 'deploy/envs/prod/purchase-svc.yaml', expected: sha('b'), actual: sha('a'), reason: '다른 다이제스트' }]);
  assert.equal(main(['--env', 'prod', '--tag', 'v2.0.0', '--candidates', cand([{ service: 'purchase-svc', digest: sha('b') }]), '--check', '--root', root]), 1);
  // 파일이 없으면 '파일 없음'으로 어긋남
  const missing = promotionPlan({ env: 'prod', tag: 'v2.0.0', candidates: parseCandidates(JSON.stringify([{ service: 'queue-svc', digest: sha('d') }])), root });
  assert.deepEqual(checkPlan(missing, root).mismatches, [{ service: 'queue-svc', file: 'deploy/envs/prod/queue-svc.yaml', expected: sha('d'), actual: null, reason: '파일 없음' }]);
  assert.equal(main(['--env', 'prod', '--tag', 'v2.0.0', '--candidates', cand([{ service: 'queue-svc', digest: sha('d') }]), '--check', '--root', root]), 1);
});

test('PR-03 승격본문: 데모는자동병합_운영은사람병합이고_동결창·조치기한·Pact·arm64스모크가필수조건이며_비밀은남기지않는다', () => {
  const root = tempRoot();
  valueFile(root, 'demo', 'purchase-svc', OLD);
  const candidates = parseCandidates(
    JSON.stringify([
      { service: 'purchase-svc', digest: sha('b'), changes: '결제 확인 재시도 수정', sbom: 'purchase-svc SBOM: 취약점 0' },
      { service: 'ticket-svc', digest: sha('c'), secret: 'secret-value-1234' },
    ]),
  );
  const demo = promotionBody(promotionPlan({ env: 'demo', tag: 'v1.2.3', candidates, root }));
  assert.match(demo, /^# 승격: demo v1\.2\.3$/m);
  assert.match(demo, /deploy\/envs\/demo\/purchase-svc\.yaml/);
  assert.match(demo, new RegExp(sha('a')));
  assert.match(demo, new RegExp(sha('b')));
  assert.match(demo, /결제 확인 재시도 수정/);
  assert.match(demo, /purchase-svc SBOM: 취약점 0/);
  assert.match(demo, /자동 병합/);
  for (const want of ['동결 창', '조치 기한', 'Pact', 'arm64']) assert.ok(demo.includes(want), `필수 조건 ${want}`);
  // 후보 목록에 실수로 들어온 비밀 같은 칸은 본문에 옮기지 않는다
  assert.doesNotMatch(demo, /secret-value-1234/);

  const prod = promotionBody(promotionPlan({ env: 'prod', tag: 'v1.2.3', candidates, root }));
  assert.match(prod, /사람이 병합/);
  assert.doesNotMatch(prod, /자동 병합한다/);
  // staging·local·ci는 승격 PR을 만들지 않는다
  const staging = promotionBody(promotionPlan({ env: 'staging', tag: 'v1.2.3', candidates: [], root }));
  assert.match(staging, /승격 PR을 만들지 않는다/);
});

test('PR-04 promote.yml: 체크아웃자격증명을남기지않고_contents·pull-requests쓰기권한_promote/<환경>-<태그>가지_데모만자동병합_다시빌드없음', () => {
  const wf = parseYaml(readFileSync(join(REPO, '.github', 'workflows', 'promote.yml'), 'utf8'));
  assert.ok(wf.on?.workflow_call, 'workflow_call');
  assert.ok(wf.on?.workflow_dispatch, 'workflow_dispatch');
  // 사람이 부를 때 고르는 환경은 demo·prod뿐이다(운영 승격은 출시 태그 뒤)
  assert.deepEqual(wf.on.workflow_dispatch.inputs.env.options, ['demo', 'prod']);
  const job = wf.jobs.promote;
  assert.equal(job.permissions.contents, 'write');
  assert.equal(job.permissions['pull-requests'], 'write');
  // 워크플로 기본 권한은 최소로 두고 잡에서만 올린다
  assert.equal(wf.permissions?.contents, 'read');
  const checkout = job.steps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@'));
  assert.ok(checkout, 'checkout 단계');
  assert.equal(checkout.with?.['persist-credentials'], false, 'persist-credentials');
  assert.equal(checkout.with?.ref, undefined, '체크아웃 가지를 고정하지 않는다(develop 기준)');
  const runs = job.steps.map((s) => s.run).filter(Boolean).join('\n');
  // 가지 이름 promote/<환경>-<태그>
  assert.match(runs, /branch="promote\/\$\{ENV_NAME\}-\$\{TAG\}"/);
  // 로그·본문에 비밀을 남기지 않는다(토큰은 gh가 환경 변수로만 받는다)
  assert.doesNotMatch(runs, /\$\{\{\s*secrets\./, 'run 단계에 비밀을 직접 넣었다');
  assert.doesNotMatch(runs, /echo[^\n]*GH_TOKEN/, '토큰을 로그에 찍는다');
  // 같은 다이제스트만: 다시 빌드하거나 이미지를 밀지 않는다
  assert.doesNotMatch(runs, /docker build|docker push|build-image\.yml|ghcr\.io[^\n]*push/);
  // 데모만 자동 병합, 운영은 사람이 병합한다
  assert.match(runs, /if \[ "\$ENV_NAME" = demo \]/);
  assert.match(runs, /gh pr merge[^\n]*--auto/);
  // 승격 계획은 promote-plan.mjs가 만든다(워크플로가 값 파일을 손으로 고치지 않는다)
  assert.match(runs, /node tools\/ci\/promote-plan\.mjs --env "\$ENV_NAME" --tag "\$TAG"/);
  assert.equal(existsSync(join(REPO, 'tools', 'ci', 'promote-plan.mjs')), true);
});
