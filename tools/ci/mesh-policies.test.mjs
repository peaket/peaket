// 메시 포트별 허용 정책 생성기의 명령줄 시험(BUILD_ORDER HOT-420, 묶음 BAT-061 계획 6의 MG-01~10, D-T36, ADR-0285 결정 1·2).
// 생성기를 모듈로 부르지 않고 바깥에서 돌린다: node tools/ci/mesh-policies.mjs --write|--check [--root <임시 폴더>].
// 임시 폴더에는 저장소의 원천·생성 파일(deploy/platform/mesh/*.yaml), 게이트웨이 맨 위 YAML(deploy/gateways/*.yaml), proto(docs/api/proto),
// 배포 단위 값(deploy/workloads)을 복사하고, 사례마다 한 곳을 바꾼다. 공개 인터페이스(계획 4.2의 7): 끝 코드 0(같음·씀), 1(다름·대조 오류,
// '막음: <파일>: <까닭>' 줄), 2(인자 오류). 원천에 없는 서비스·메서드·백엔드, 모르는 부르는 쪽, 빈 결과는 1로 막혀야 하고(fail closed),
// 막힐 때는 생성 파일을 쓰지 않는다. CI가 실제로 돌리는지(tools-check·ci-kind의 run 줄, changes.mjs의 범위)도 바깥에서 본다.
// 실행(저장소 뿌리): node --test tools/ci/mesh-policies.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments, stringify } from 'yaml';
import { commit, git, repo, tempDir } from './git-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'mesh-policies.mjs');
const CHANGES = join(HERE, 'changes.mjs');
const REPO = resolve(HERE, '..', '..');

const SOURCE = 'deploy/platform/mesh/port-allow.yaml';
const POLICIES = 'deploy/platform/mesh/policies.yaml';
const MESHLESS = 'deploy/platform/mesh/meshless-networkpolicies.yaml';

/** 생성기를 돌린다(끝 코드와 합친 출력) */
function cli(...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: REPO });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const run = (root, mode) => cli(mode, '--root', root);
/** '막음:' 줄 */
const blocked = (out) => out.split('\n').filter((l) => l.startsWith('막음:'));

/** 저장소 입력을 임시 폴더에 복사한다(게이트웨이는 맨 위 YAML만, 메시 폴더는 시험 폴더를 빼고) */
function fixture() {
  const root = tempDir('mesh-policies-');
  const copyTop = (from, keep) => {
    const src = join(REPO, from);
    mkdirSync(join(root, from), { recursive: true });
    for (const n of readdirSync(src)) if (statSync(join(src, n)).isFile() && keep(n)) cpSync(join(src, n), join(root, from, n));
  };
  copyTop('deploy/platform/mesh', (n) => n.endsWith('.yaml'));
  copyTop('deploy/gateways', (n) => /\.ya?ml$/.test(n));
  cpSync(join(REPO, 'docs/api/proto'), join(root, 'docs/api/proto'), { recursive: true });
  cpSync(join(REPO, 'deploy/workloads'), join(root, 'deploy/workloads'), { recursive: true });
  return root;
}
const readIn = (root, f) => readFileSync(join(root, f), 'utf8');
const writeIn = (root, f, text) => {
  mkdirSync(dirname(join(root, f)), { recursive: true });
  writeFileSync(join(root, f), text);
};
/** 원천을 읽어 바꾸고 쓴다(주석은 잃어도 된다) */
function editSource(root, fn) {
  const src = parse(readIn(root, SOURCE));
  fn(src);
  writeIn(root, SOURCE, stringify(src));
}
/** 생성 파일 둘의 바이트(막힐 때 쓰지 않았는지 본다) */
const generated = (root) => [POLICIES, MESHLESS].map((f) => (existsSync(join(root, f)) ? readIn(root, f) : null));
/** 생성 파일의 객체를 이름으로 */
const objectsIn = (root, f) =>
  parseAllDocuments(readIn(root, f))
    .map((d) => d.toJS())
    .filter((o) => o && typeof o === 'object');

/** 막혀야 하는 사례: --write·--check 둘 다 1, 까닭 줄에 words가 모두 들고, --write가 생성 파일을 쓰지 않는다 */
function assertBlocked(root, words, what) {
  const before = generated(root);
  const w = run(root, '--write');
  assert.equal(w.status, 1, `${what}: --write가 ${w.status}로 끝났다(1이어야 한다): ${w.out}`);
  assert.deepEqual(generated(root), before, `${what}: 막혔는데 --write가 생성 파일을 바꿨다`);
  const c = run(root, '--check');
  assert.equal(c.status, 1, `${what}: --check가 ${c.status}로 끝났다(1이어야 한다): ${c.out}`);
  for (const out of [w.out, c.out]) {
    const lines = blocked(out);
    assert.ok(lines.length > 0, `${what}: '막음:' 줄이 없다: ${out}`);
    for (const word of words) assert.ok(lines.some((l) => l.includes(word)), `${what}: 까닭 줄에 ${word}가 없다: ${lines.join(' / ')}`);
  }
}

// ===================== MG-01 =====================

test('MG-01 저장소 대조: 저장소 뿌리에서 --check(그리고 --root 저장소)가 0으로 끝난다', () => {
  const a = cli('--check');
  assert.equal(a.status, 0, a.out);
  const b = cli('--check', '--root', REPO);
  assert.equal(b.status, 0, b.out);
  // 복사만 한 임시 폴더도 0이다(이 시험의 복사가 생성기 입력을 빠뜨리지 않았다)
  const root = fixture();
  const c = run(root, '--check');
  assert.equal(c.status, 0, `복사만 한 임시 폴더: ${c.out}`);
});

// ===================== MG-02 =====================

test('MG-02 손으로 고친 생성 파일을 막는다: policies.yaml에 주체 하나를 더한 판, meshless에서 규칙 하나를 지운 판, 생성 파일을 지운 판은 --check가 1이고 그 파일 이름을 보인다', () => {
  // policies.yaml: identity-svc 웨이포인트 정책의 AdminAuthzService 규칙에 web을 더한다(D-T36 ⑦ 틀린 판)
  {
    const root = fixture();
    const before = readIn(root, POLICIES);
    const docs = parseAllDocuments(before);
    const d = docs.find((x) => x.toJS()?.metadata?.name === 'identity-svc-waypoint-callers');
    assert.ok(d, 'identity-svc-waypoint-callers가 없다');
    const rules = d.toJS().spec.rules;
    const i = rules.findIndex((r) => r.to.some((t) => (t.operation?.paths ?? []).some((p) => p.startsWith('/peaket.identity.v1.AdminAuthzService/'))));
    assert.ok(i >= 0, 'AdminAuthzService 규칙이 없다');
    d.addIn(['spec', 'rules', i, 'from', 0, 'source', 'principals'], 'cluster.local/ns/web/sa/web');
    const edited = docs.map((x) => x.toString()).join('');
    assert.notEqual(edited, before);
    assert.equal(edited.split('\n')[0], before.split('\n')[0], '손본 파일의 첫 줄이 바뀌었다(시험 준비 잘못)');
    writeIn(root, POLICIES, edited);
    const c = run(root, '--check');
    assert.equal(c.status, 1, `주체를 더한 policies.yaml을 --check가 놓쳤다: ${c.out}`);
    assert.ok(blocked(c.out).some((l) => l.includes(POLICIES)), `바뀐 파일 이름이 없다: ${c.out}`);
    assert.ok(!blocked(c.out).some((l) => l.includes(MESHLESS)), `바뀌지 않은 파일까지 막음으로 보인다: ${c.out}`);
    // --write로 다시 만들면 손본 것이 사라지고 0이다
    assert.equal(run(root, '--write').status, 0);
    assert.equal(readIn(root, POLICIES), before, '--write가 원래 생성 결과로 되돌리지 않았다');
  }
  // meshless: trust-svc-ports에서 규칙 하나를 지운다
  {
    const root = fixture();
    const before = readIn(root, MESHLESS);
    const docs = parseAllDocuments(before);
    const d = docs.find((x) => x.toJS()?.metadata?.name === 'trust-svc-ports');
    assert.ok(d && d.toJS().spec.ingress.length > 1, 'trust-svc-ports 규칙이 없다');
    d.deleteIn(['spec', 'ingress', 0]);
    writeIn(root, MESHLESS, docs.map((x) => x.toString()).join(''));
    const c = run(root, '--check');
    assert.equal(c.status, 1, `규칙을 지운 meshless를 --check가 놓쳤다: ${c.out}`);
    assert.ok(blocked(c.out).some((l) => l.includes(MESHLESS)), `바뀐 파일 이름이 없다: ${c.out}`);
    assert.ok(!blocked(c.out).some((l) => l.includes(POLICIES)), `바뀌지 않은 파일까지 막음으로 보인다: ${c.out}`);
  }
  // 생성 파일이 없으면 1
  {
    const root = fixture();
    rmSync(join(root, MESHLESS));
    const c = run(root, '--check');
    assert.equal(c.status, 1, `지운 생성 파일을 놓쳤다: ${c.out}`);
    assert.ok(blocked(c.out).some((l) => l.includes(MESHLESS)), c.out);
  }
  // 줄 끝 공백 하나만 더해도 1(바이트 대조)
  {
    const root = fixture();
    writeIn(root, POLICIES, `${readIn(root, POLICIES)}\n`);
    assert.equal(run(root, '--check').status, 1, '빈 줄 하나를 더한 생성 파일을 놓쳤다');
  }
});

// ===================== MG-03 =====================

const extraRoute = (name, backend) =>
  stringify({
    apiVersion: 'gateway.networking.k8s.io/v1',
    kind: 'HTTPRoute',
    metadata: { name, namespace: 'envoy-gateway-system' },
    spec: {
      parentRefs: [{ name: 'gw-fan', sectionName: 'api' }],
      rules: [{ matches: [{ path: { type: 'PathPrefix', value: `/v1/${name}` } }], backendRefs: [{ group: '', kind: 'Service', ...backend }] }],
    },
  });

test('MG-03 원천에 없는 백엔드: 라우트가 원천에 없는 Service(core/new-svc:8080)·원천과 포트가 다른 백엔드·네임스페이스가 다른 백엔드로 가면 --write·--check 둘 다 1이고 그 이름을 보이며 생성 파일을 쓰지 않는다', () => {
  {
    const root = fixture();
    writeIn(root, 'deploy/gateways/zz-mesh-test.yaml', extraRoute('zz-mesh-new', { name: 'new-svc', namespace: 'core', port: 8080 }));
    assertBlocked(root, ['new-svc'], '원천에 없는 Service');
  }
  {
    const root = fixture();
    writeIn(root, 'deploy/gateways/zz-mesh-test.yaml', extraRoute('zz-mesh-port', { name: 'core-svc', namespace: 'core', port: 9090 }));
    assertBlocked(root, ['core-svc', '9090'], '포트가 다른 백엔드');
  }
  {
    const root = fixture();
    writeIn(root, 'deploy/gateways/zz-mesh-test.yaml', extraRoute('zz-mesh-ns', { name: 'identity-svc', namespace: 'purchase', port: 8080 }));
    assertBlocked(root, ['identity-svc'], '네임스페이스가 다른 백엔드');
  }
  // 하위 폴더(routes/)의 YAML은 읽지 않는다: 같은 라우트를 routes/에 두면 막히지 않는다
  {
    const root = fixture();
    writeIn(root, 'deploy/gateways/routes/zz-mesh-test.yaml', extraRoute('zz-mesh-new', { name: 'new-svc', namespace: 'core', port: 8080 }));
    assert.equal(run(root, '--check').status, 0, '하위 폴더의 라우트를 읽었다');
  }
});

// ===================== MG-04 =====================

test('MG-04 모르는 부르는 쪽: 원천 워크로드의 부르는 쪽에 callers에 없는 이름을 적으면(REST·업무 gRPC·제어 각각) 1이고 그 이름을 보인다', () => {
  for (const [what, fn] of [
    ['REST', (s) => s.workloads['core-svc'].ports.rest.callers.push('mystery-svc')],
    ['업무 gRPC', (s) => s.workloads['identity-svc'].ports.grpc.services['peaket.identity.v1.SessionService'].push('mystery-svc')],
    ['메서드', (s) => s.workloads['ticket-svc'].ports.grpc.services['peaket.ticket.v1.TicketService'].methods.ListTickets.push('mystery-svc')],
    ['제어', (s) => s.workloads['admission-ctrl'].ports.control.callers.push('mystery-svc')],
  ]) {
    const root = fixture();
    editSource(root, fn);
    assertBlocked(root, ['mystery-svc'], `${what} 부르는 쪽`);
  }
});

// ===================== MG-05 =====================

test('MG-05 proto와 원천의 차이: proto에 원천에 없는 서비스·메서드를 더한 판, 원천에 proto에 없는 서비스·메서드를 적은 판, 메서드로 나눈 서비스에서 proto 메서드 하나가 빠진 판은 모두 1이고 그 이름을 보인다', () => {
  // proto에 새 서비스(원천에 없음)
  {
    const root = fixture();
    const f = 'docs/api/proto/peaket/trust/v1/trust.proto';
    writeIn(root, f, `${readIn(root, f)}\nservice ZzMeshTestService {\n  rpc ZzPing(ZzPingRequest) returns (ZzPingResponse);\n}\n`);
    assertBlocked(root, ['ZzMeshTestService'], 'proto에만 있는 서비스');
  }
  // 메서드로 나눈 서비스(TicketService)의 proto에 새 메서드(원천에 부르는 쪽 없음)
  {
    const root = fixture();
    const f = 'docs/api/proto/peaket/ticket/v1/ticket.proto';
    const text = readIn(root, f);
    assert.ok(text.includes('service TicketService {'), 'ticket.proto에 TicketService가 없다');
    writeIn(root, f, text.replace('service TicketService {', 'service TicketService {\n  rpc ZzNewMethod(ListTicketsRequest) returns (ListTicketsResponse);'));
    assertBlocked(root, ['ZzNewMethod'], 'proto에만 있는 메서드');
  }
  // 원천에 proto에 없는 서비스
  {
    const root = fixture();
    editSource(root, (s) => {
      s.workloads['trust-svc'].ports.grpc.services['peaket.trust.v1.GhostService'] = ['ops-svc'];
    });
    assertBlocked(root, ['GhostService'], '원천에만 있는 서비스');
  }
  // 원천에 proto에 없는 메서드
  {
    const root = fixture();
    editSource(root, (s) => {
      s.workloads['payment-svc'].ports.grpc.services['peaket.payment.v1.PaymentService'].methods.GhostMethod = ['ops-svc'];
    });
    assertBlocked(root, ['GhostMethod'], '원천에만 있는 메서드');
  }
  // 메서드로 나눈 서비스에서 proto 메서드 하나가 빠짐
  {
    const root = fixture();
    editSource(root, (s) => {
      delete s.workloads['ticket-svc'].ports.grpc.services['peaket.ticket.v1.TicketService'].methods.ListTickets;
    });
    assertBlocked(root, ['ListTickets'], '빠진 메서드');
  }
  // 받는 쪽이 패키지와 다른 워크로드(identity 서비스를 core-svc에 적음)
  {
    const root = fixture();
    editSource(root, (s) => {
      const g = s.workloads['identity-svc'].ports.grpc.services;
      s.workloads['core-svc'].ports.grpc.services['peaket.identity.v1.MemberCodeService'] = g['peaket.identity.v1.MemberCodeService'];
      delete g['peaket.identity.v1.MemberCodeService'];
    });
    assertBlocked(root, ['MemberCodeService'], '패키지와 다른 받는 쪽');
  }
});

// ===================== MG-06 =====================

test('MG-06 공개키 묶음 게이트웨이: 라우트 없이 SecurityPolicy remoteJWKS만 워크로드를 가리키는 게이트웨이는(Gateway에 붙음·HTTPRoute에 붙음) --write 뒤 그 워크로드 REST 규칙에 들어간다', () => {
  const root = fixture();
  const gwPrincipal = (name) => {
    const src = parse(readIn(root, SOURCE));
    return src.callers[name].principal;
  };
  const restPrincipals = (w) => {
    const p = objectsIn(root, POLICIES).find((o) => o.kind === 'AuthorizationPolicy' && o.metadata?.name === `${w}-ports`);
    const port = String(8080);
    return p.spec.rules.filter((r) => r.to.some((t) => (t.operation?.ports ?? []).includes(port))).flatMap((r) => r.from.flatMap((f) => f.source.principals));
  };
  const restPeers = (w) => {
    const np = objectsIn(root, MESHLESS).find((o) => o.kind === 'NetworkPolicy' && o.metadata?.name === `${w}-ports`);
    return np.spec.ingress.filter((r) => r.ports.some((p) => p.port === 8080)).flatMap((r) => r.from.map((x) => x.podSelector?.matchLabels?.['gateway.envoyproxy.io/owning-gateway-name']));
  };
  // 바꾸기 전: gw-queue는 purchase-svc로, gw-scanner는 payment-svc로 경로를 보내지 않는다
  assert.ok(!restPrincipals('purchase-svc').includes(gwPrincipal('gw-queue')), '준비: gw-queue가 이미 purchase-svc REST에 있다');
  assert.ok(!restPrincipals('payment-svc').includes(gwPrincipal('gw-scanner')), '준비: gw-scanner가 이미 payment-svc REST에 있다');
  const policy = (name, targetRef, host) =>
    stringify({
      apiVersion: 'gateway.envoyproxy.io/v1alpha1',
      kind: 'SecurityPolicy',
      metadata: { name, namespace: 'envoy-gateway-system' },
      spec: {
        targetRefs: [targetRef],
        jwt: { providers: [{ name: 'zz-test', issuer: 'https://zz.example', remoteJWKS: { uri: `http://${host}:8080/internal/jwks/zz.json` } }] },
      },
    });
  writeIn(
    root,
    'deploy/gateways/zz-mesh-jwks.yaml',
    [policy('zz-jwks-gateway', { group: 'gateway.networking.k8s.io', kind: 'Gateway', name: 'gw-queue' }, 'purchase-svc.purchase.svc.cluster.local'), policy('zz-jwks-route', { group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: 'gw-scanner-api' }, 'payment-svc.purchase.svc.cluster.local')].join('---\n'),
  );
  const w = run(root, '--write');
  assert.equal(w.status, 0, w.out);
  assert.ok(restPrincipals('purchase-svc').includes(gwPrincipal('gw-queue')), 'Gateway에 붙은 remoteJWKS 게이트웨이(gw-queue)가 purchase-svc REST 규칙에 없다');
  assert.ok(restPeers('purchase-svc').includes('gw-queue'), 'meshless purchase-svc REST에 gw-queue 칸이 없다');
  assert.ok(restPrincipals('payment-svc').includes(gwPrincipal('gw-scanner')), 'HTTPRoute에 붙은 remoteJWKS 게이트웨이(gw-scanner)가 payment-svc REST 규칙에 없다');
  assert.ok(restPeers('payment-svc').includes('gw-scanner'), 'meshless payment-svc REST에 gw-scanner 칸이 없다');
  // 다른 포트·다른 워크로드에는 번지지 않는다
  assert.ok(!restPrincipals('ticket-svc').includes(gwPrincipal('gw-queue')), 'gw-queue가 ticket-svc REST에도 들어갔다');
  assert.equal(run(root, '--check').status, 0);
});

// ===================== MG-07 =====================

test('MG-07 같은 결과: --write를 두 번 하면 두 번째 뒤 바이트가 같고 저장소 생성 파일과도 같으며 --check가 0이다', () => {
  const root = fixture();
  rmSync(join(root, POLICIES));
  rmSync(join(root, MESHLESS));
  assert.equal(run(root, '--write').status, 0);
  const first = generated(root);
  assert.ok(first.every((t) => t && t.length > 1000), '--write가 생성 파일을 쓰지 않았다');
  assert.equal(run(root, '--write').status, 0);
  assert.deepEqual(generated(root), first, '두 번 쓴 생성 파일이 다르다');
  assert.deepEqual(first, [POLICIES, MESHLESS].map((f) => readFileSync(join(REPO, f), 'utf8')), '임시 폴더의 생성 결과가 저장소 생성 파일과 다르다');
  assert.equal(run(root, '--check').status, 0);
});

// ===================== MG-08 =====================

test('MG-08 빈 결과는 통과가 아니다: 게이트웨이 YAML이 없는 임시 폴더, 원천 워크로드가 빈 판, proto가 없는 판, 원천 파일이 없는 판은 모두 --write·--check 1이다', () => {
  {
    const root = fixture();
    rmSync(join(root, 'deploy/gateways'), { recursive: true });
    assertBlocked(root, [], '게이트웨이 YAML 없음');
  }
  {
    const root = fixture();
    for (const n of readdirSync(join(root, 'deploy/gateways'))) if (/\.ya?ml$/.test(n)) writeIn(root, `deploy/gateways/${n}`, '# 비움\n');
    assertBlocked(root, [], '게이트웨이 YAML이 모두 빔');
  }
  {
    const root = fixture();
    editSource(root, (s) => {
      s.workloads = {};
    });
    assertBlocked(root, [], '원천 워크로드 빔');
  }
  {
    const root = fixture();
    rmSync(join(root, 'docs/api/proto'), { recursive: true });
    assertBlocked(root, [], 'proto 없음');
  }
  {
    const root = fixture();
    rmSync(join(root, SOURCE));
    assertBlocked(root, [SOURCE], '원천 파일 없음');
  }
});

// ===================== MG-09 =====================

test('MG-09 인자: 인자 없음·--write --check·--bogus·--root 뒤 폴더 없음은 모두 2이고 쓰는 법을 보인다', () => {
  for (const args of [[], ['--write', '--check'], ['--check', '--write'], ['--bogus'], ['--check', '--bogus'], ['--check', '--root']]) {
    const r = cli(...args);
    assert.equal(r.status, 2, `${JSON.stringify(args)}: ${r.status} ${r.out}`);
    assert.ok(r.out.includes('mesh-policies.mjs'), `${JSON.stringify(args)}: 쓰는 법이 없다: ${r.out}`);
  }
});

// ===================== MG-10 =====================

/** 워크플로의 run 줄(주석 줄을 뺀다)과 그 단계의 if */
function runLines(file) {
  const wf = parse(readFileSync(join(REPO, '.github/workflows', file), 'utf8'));
  const out = [];
  for (const [job, j] of Object.entries(wf.jobs ?? {}))
    (j.steps ?? []).forEach((s, i) => {
      if (typeof s.run !== 'string') return;
      for (const line of s.run.split('\n')) {
        const t = line.trim();
        if (t && !t.startsWith('#')) out.push({ job, step: i, if: s.if, line: t });
      }
    });
  return out;
}
/** changes.mjs가 그 파일 하나를 바꾼 가지에서 고르는 범위 */
function scopesFor(file) {
  const dir = repo('mesh-changes-');
  const base = commit(dir, { 'README.md': '처음\n' }, 'base');
  git(dir, 'switch', '-q', '-c', 'feature/x');
  commit(dir, { [file]: '바꿈\n' });
  const env = { ...process.env };
  delete env.GITHUB_OUTPUT;
  const r = spawnSync(process.execPath, [CHANGES, '--base', base], { cwd: dir, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  return Object.keys(out.scopes).filter((k) => out.scopes[k]);
}

test('MG-10 CI가 돌린다(tools-check): mesh-policies.mjs --check와 deploy/platform/mesh/test 정적 시험이 실패 때만 도는 단계가 아닌 run 줄(주석 아님)로 있다', () => {
  const tools = runLines('tools-check.yml').filter((l) => !l.if);
  const missing = [];
  if (!tools.some((l) => /^node tools\/ci\/mesh-policies\.mjs --check$/.test(l.line))) missing.push('node tools/ci/mesh-policies.mjs --check');
  if (!tools.some((l) => /^node --test\b.*deploy\/platform\/mesh\/test\//.test(l.line))) missing.push('node --test "deploy/platform/mesh/test/*.test.mjs"');
  if (!tools.some((l) => /^node --test\b.*tools\/ci\/\*\.test\.mjs/.test(l.line))) missing.push('node --test "tools/ci/*.test.mjs"(이 파일)');
  assert.deepEqual(missing, [], `tools-check에 없는 run 줄: ${missing.join(' / ')}`);
});

test('MG-10 CI가 돌린다(ci-kind): 게이트웨이 무대·시험 뒤에 cluster.mjs mesh-netpol과 mesh-netpol.e2e.mjs run 줄이 차례로 있다', () => {
  const kind = runLines('ci-kind.yml');
  const at = (re) => kind.findIndex((l) => !l.if && re.test(l.line));
  const stage = at(/^node tools\/local\/cluster\.mjs mesh-netpol$/);
  const e2e = at(/^node --test\b.*tools\/local\/e2e\/mesh-netpol\.e2e\.mjs/);
  const gateways = at(/^node tools\/local\/cluster\.mjs gateways$/);
  const gwE2e = Math.max(...kind.map((l, i) => (!l.if && /tools\/local\/e2e\/gateway[\w-]*\.e2e\.mjs/.test(l.line) ? i : -1)));
  assert.ok(stage >= 0, 'ci-kind에 cluster.mjs mesh-netpol run 줄이 없다(실패 때만 도는 단계 밖)');
  assert.ok(e2e >= 0, 'ci-kind에 mesh-netpol.e2e.mjs run 줄이 없다');
  assert.ok(gateways >= 0 && gwE2e >= 0, 'ci-kind에 게이트웨이 무대·시험 줄이 없다');
  assert.ok(gateways < stage && gwE2e < stage && stage < e2e, `차례: 게이트웨이(${gateways}) → 게이트웨이 시험(${gwE2e}) → mesh-netpol(${stage}) → 시험(${e2e})`);
});

test('MG-10 CI가 돌린다(changes.mjs): 메시 폴더는 tools·kind, proto·배포 단위 값·생성기·이 시험은 tools, kind 무대·시험은 kind 범위를 고른다(명령줄로 확인)', () => {
  const missing = [];
  for (const [file, want] of [
    ['deploy/platform/mesh/x.yaml', ['tools', 'kind']],
    ['deploy/platform/mesh/test/mesh-policies.test.mjs', ['tools', 'kind']],
    ['docs/api/proto/peaket/x.proto', ['tools']],
    ['deploy/workloads/ops-svc/values.yaml', ['tools']],
    ['tools/ci/mesh-policies.mjs', ['tools']],
    ['tools/ci/mesh-policies.test.mjs', ['tools']],
    ['tools/local/mesh-netpol-objects.mjs', ['kind']],
    ['tools/local/e2e/mesh-netpol.e2e.mjs', ['kind']],
    ['.github/workflows/ci-kind.yml', ['kind']],
  ]) {
    const got = scopesFor(file);
    for (const s of want) if (!got.includes(s)) missing.push(`${file} → ${s}(고른 범위 ${got.join(', ') || '없음'})`);
  }
  assert.deepEqual(missing, [], `changes.mjs가 고르지 않는 범위:\n${missing.join('\n')}`);
});

test('MG-10 RV-01 CI가 돌린다(changes.mjs, deploy 전체): 정적 시험(MS-11·12·13·20)이 deploy/ 전체를 훑으므로 운영 오버레이 자리(deploy/envs/)·공용 차트 템플릿·로컬 매니페스트만 바꾼 PR도 tools를 고른다', () => {
  const missing = [];
  for (const file of ['deploy/envs/x/y.yaml', 'deploy/charts/peaket-service/templates/x.yaml', 'deploy/local/x.yaml']) {
    const got = scopesFor(file);
    if (!got.includes('tools')) missing.push(`${file} → tools(고른 범위 ${got.join(', ') || '없음'})`);
  }
  assert.deepEqual(missing, [], `changes.mjs가 tools를 고르지 않는 deploy/ 파일:\n${missing.join('\n')}`);
});
