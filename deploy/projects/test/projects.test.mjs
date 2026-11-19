// ArgoCD 배포 상태(deploy/projects)의 정적 시험(묶음 BAT-080 G2, ADR-0310).
// 정본: docs/devops.md §5.2 '배포 상태 구조'(399~440행) — AppProject는 가상 팀 아홉의 네임스페이스·자원 종류를 제한하고,
// ApplicationSet(Git 디렉터리 생성기)은 develop의 deploy/envs/<환경>/*를 읽어 Application을 만들며, 자동 동기화(prune·selfHeal)와
// HTTPRoute ignoreDifferences를 켠다. 환경 이름은 local·ci·staging·demo·prod다.
// 실행(저장소 뿌리): node --test "deploy/projects/test/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const PROJECTS = join(REPO, 'deploy', 'projects');
const REPO_URL = 'https://github.com/peaket/peaket';
const ENVS = ['local', 'ci', 'staging', 'demo', 'prod'];
/** docs/devops.md §5.2 네임스페이스 지도의 가상 팀 아홉 */
const TEAMS = ['queue', 'purchase', 'ticket', 'trust', 'core', 'frontend', 'data', 'observability', 'platform'];
/** 각 팀이 배포하는 네임스페이스(지도). platform은 애드온이 쓰는 차트 기본 네임스페이스도 맡는다 */
const NAMESPACES = {
  queue: ['queue', 'platform'],
  purchase: ['purchase', 'platform'],
  ticket: ['ticket', 'platform'],
  trust: ['trust', 'platform'],
  core: ['core', 'platform'],
  frontend: ['web', 'platform'],
  data: ['data', 'platform'],
  observability: ['observability', 'platform'],
  platform: ['platform', 'otel', 'ops-breakglass', 'envoy-gateway-system'],
};

function docs(file) {
  const full = join(PROJECTS, file);
  assert.ok(existsSync(full), `배포 상태 파일이 없다: deploy/projects/${file}`);
  return parseAllDocuments(readFileSync(full, 'utf8'))
    .map((d) => d.toJS())
    .filter(Boolean);
}
const byKind = (all, kind) => all.filter((o) => o.kind === kind);
const namesOf = (projects) => projects.map((p) => p.metadata.name).sort();

test('DP-01 AppProject가_가상팀아홉_peaket-<팀>이고_각destinations가_네임스페이스지도와같으며_sourceRepos는peaket하나_클러스터범위는필요한종류만이다', () => {
  const projects = byKind(docs('appprojects.yaml'), 'AppProject');
  assert.deepEqual(namesOf(projects), TEAMS.map((t) => `peaket-${t}`).sort());
  for (const p of projects) {
    const team = p.metadata.name.slice('peaket-'.length);
    assert.equal(p.metadata.namespace, 'argocd', `${team}: AppProject는 argocd 네임스페이스에 둔다`);
    // 저장소는 peaket 하나. '*'로 다른 저장소의 차트·매니페스트를 받지 않는다(ASVS v5.0.0-13.2.5)
    assert.deepEqual(p.spec.sourceRepos, [REPO_URL], `${team}: sourceRepos`);
    assert.equal(p.spec.sourceRepos.includes('*'), false, `${team}: sourceRepos에 *`);
    const destinations = (p.spec.destinations ?? []).map((d) => d.namespace).sort();
    assert.deepEqual(destinations, [...NAMESPACES[team]].sort(), `${team}: destinations`);
    for (const d of p.spec.destinations) {
      assert.equal(d.server, 'https://kubernetes.default.svc', `${team}: destinations.server`);
      assert.notEqual(d.namespace, '*', `${team}: 모든 네임스페이스 허용`);
      assert.equal(typeof d.namespace, 'string');
      assert.notEqual(d.namespace.trim(), '', `${team}: 빈 네임스페이스`);
    }
    // 클러스터 범위는 필요한 종류만. '*'를 두면 다른 팀 네임스페이스·클러스터 자원을 만들 수 있다
    const whitelist = p.spec.clusterResourceWhitelist ?? [];
    assert.equal(whitelist.some((w) => w.kind === '*' || w.group === '*'), false, `${team}: clusterResourceWhitelist에 *`);
    if (team === 'platform') {
      const kinds = whitelist.map((w) => `${w.group}/${w.kind}`).sort();
      assert.deepEqual(kinds, [
        '/Namespace',
        'apiextensions.k8s.io/CustomResourceDefinition',
        'rbac.authorization.k8s.io/ClusterRole',
        'rbac.authorization.k8s.io/ClusterRoleBinding',
        'scheduling.k8s.io/PriorityClass',
      ].sort());
    } else {
      assert.deepEqual(whitelist, [], `${team}: 서비스 팀은 클러스터 범위 자원을 만들지 않는다`);
    }
  }
});

test('DP-02 ApplicationSet이_환경마다_peaket-<환경>이고_develop만읽으며_자동동기화prune·selfHeal과_HTTPRouteignoreDifferences를켠다', () => {
  const sets = byKind(docs('applicationsets.yaml'), 'ApplicationSet');
  assert.deepEqual(namesOf(sets), ENVS.map((e) => `peaket-${e}`).sort());
  for (const s of sets) {
    const env = s.metadata.name.slice('peaket-'.length);
    assert.ok(ENVS.includes(env), `모르는 환경 ${env}`);
    assert.equal(s.metadata.namespace, 'argocd', `${env}: ApplicationSet은 argocd 네임스페이스에 둔다`);
    const gens = s.spec.generators ?? [];
    assert.equal(gens.length, 1, `${env}: 생성기 하나`);
    const git = gens[0].git;
    assert.ok(git, `${env}: Git 생성기`);
    assert.equal(git.repoURL, REPO_URL, `${env}: repoURL`);
    // main은 출시 뒤의 사본이다. develop만 읽는다(docs/devops.md §5.2 401행)
    assert.equal(git.revision, 'develop', `${env}: revision`);
    assert.notEqual(git.revision, 'main', `${env}: main을 읽는다`);
    assert.ok(Array.isArray(git.directories) && git.directories.length > 0, `${env}: directories`);
    for (const d of git.directories) {
      assert.ok(typeof d.path === 'string' && d.path.startsWith('deploy/envs/'), `${env}: 경로 ${d.path}`);
      const parts = d.path.split('/');
      assert.ok(parts[2] === '*' || parts[2] === env, `${env}: 경로가 다른 환경을 읽는다: ${d.path}`);
    }
    // flags/는 릴리스 플래그 정의라 Application으로 만들지 않는다
    assert.ok(
      git.directories.some((d) => d.exclude === true && d.path === `deploy/envs/${env}/flags`),
      `${env}: flags/ 제외가 없다`,
    );
    const t = s.spec.template.spec;
    assert.ok(TEAMS.map((x) => `peaket-${x}`).includes(t.project), `${env}: project ${t.project}`);
    assert.equal(t.source.repoURL, REPO_URL, `${env}: source.repoURL`);
    assert.equal(t.source.targetRevision, 'develop', `${env}: source.targetRevision`);
    assert.equal(t.source.path, 'deploy/charts/peaket-service', `${env}: 차트 경로`);
    assert.deepEqual(t.source.helm.valueFiles, ['{{ .path.path }}'], `${env}: valueFiles`);
    assert.equal(t.destination.server, 'https://kubernetes.default.svc', `${env}: destination.server`);
    assert.notEqual(t.destination.namespace, '*', `${env}: destination.namespace *`);
    assert.equal(t.syncPolicy.automated.prune, true, `${env}: prune`);
    assert.equal(t.syncPolicy.automated.selfHeal, true, `${env}: selfHeal`);
    const ignored = t.ignoreDifferences ?? [];
    assert.ok(
      ignored.some((i) => i.group === 'gateway.networking.k8s.io' && i.kind === 'HTTPRoute'),
      `${env}: HTTPRoute ignoreDifferences`,
    );
  }
});

/** Git 디렉터리 생성기가 보는 것: 저장소에 실제로 있는 '폴더'만. '*'는 한 마디(segment) 전체를 뜻한다 */
function walkDirectories(parts, acc, out) {
  if (parts.length === 0) {
    out.push(acc);
    return;
  }
  const [head, ...rest] = parts;
  if (head.includes('*')) {
    assert.equal(head, '*', `이 시험은 마디 전체 별표만 다룬다: ${parts.join('/')}`);
    const base = join(REPO, ...acc);
    if (!existsSync(base) || !statSync(base).isDirectory()) return;
    for (const d of readdirSync(base, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      walkDirectories(rest, [...acc, d.name], out);
    }
    return;
  }
  const next = [...acc, head];
  const full = join(REPO, ...next);
  if (existsSync(full) && statSync(full).isDirectory()) walkDirectories(rest, next, out);
}
/** 생성기 설정에서 실제로 만들어지는 Application 이름(path.basenameNormalized: 소문자·'-') */
function generatedApps(s) {
  const include = new Set();
  const exclude = new Set();
  for (const d of s.spec.generators[0].git.directories) {
    if (!d.path.includes('*') && !d.exclude) continue;
    if (!d.path.includes('*') && d.exclude) {
      exclude.add(d.path.split('/').at(-1).toLowerCase().replaceAll('_', '-'));
      continue;
    }
    const found = [];
    walkDirectories(d.path.split('/'), [], found);
    for (const p of found) {
      const name = p.at(-1).toLowerCase().replaceAll('_', '-');
      if (d.exclude === true) exclude.add(name);
      else include.add(name);
    }
  }
  for (const name of exclude) include.delete(name);
  return include;
}

test('DP-03 ApplicationSet이_deploy/envs/local의값파일모두를찾는다(디렉터리생성기와파일구조의불일치를드러낸다)', () => {
  const sets = byKind(docs('applicationsets.yaml'), 'ApplicationSet');
  for (const env of ENVS) {
    const dir = join(REPO, 'deploy', 'envs', env);
    if (!existsSync(dir)) continue; // 아직 값이 없는 환경(demo·prod는 첫 승격 PR이 만든다)
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.yaml'))
      .map((d) => d.name)
      .sort();
    const s = sets.find((x) => x.metadata.name === `peaket-${env}`);
    assert.ok(s, `${env}: ApplicationSet peaket-${env}이 없다`);
    const apps = generatedApps(s);
    const expected = files.map((f) => f.slice(0, -'.yaml'.length).toLowerCase().replaceAll('_', '-'));
    // 값 파일 6개(v0-gateway·v0-monolith·v1-bundle·v1-payment-relay·v1-purchase-relay·v1-realtime-gw)마다
    // Application 하나가 있어야 한다. 없으면 ApplicationSet이 그 서비스를 배포하지 않는다
    assert.deepEqual(
      [...apps].sort(),
      expected.sort(),
      `${env}: Git 디렉터리 생성기는 폴더만 찾는다. deploy/envs/${env}/*.yaml 값 파일은 생성되지 않는다` +
        '(파일 생성기로 바꾸거나 환경 값을 디렉터리로 재구성해야 한다, BAT-080 시험 이의)',
    );
    // flags/는 값 파일이 아니므로 Application으로 만들지 않는다
    for (const name of apps) assert.notEqual(name, 'flags', `${env}: flags/를 Application으로 만들었다`);
  }
});
