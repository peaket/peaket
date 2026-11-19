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

test('DP-02 ApplicationSet이_환경마다_peaket-<환경>이고_Git파일생성기로_deploy/envs/<환경>/*.yaml을_읽으며_develop만·prune/selfHeal·HTTPRouteignoreDifferences를켠다', () => {
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
    // 파일 생성기다. 디렉터리 생성기는 폴더만 찾아 deploy/envs/<환경>/*.yaml 값 파일을 만들지 못한다(BAT-080 DP-03)
    assert.equal(git.directories, undefined, `${env}: 디렉터리 생성기를 쓴다`);
    assert.ok(Array.isArray(git.files) && git.files.length > 0, `${env}: git.files`);
    assert.deepEqual(git.files.map((f) => f.path), [`deploy/envs/${env}/*.yaml`], `${env}: 경로 glob`);
    for (const f of git.files) {
      // 값 파일만 고른다(폴더·flags/는 파일 생성기가 만들지 않는다)
      assert.match(f.path, /^deploy\/envs\/[a-z]+\/\*\.yaml$/, `${env}: 경로 ${f.path}`);
      assert.equal(f.exclude, undefined, `${env}: 값 파일 glob에 exclude`);
    }
    const t = s.spec.template.spec;
    // Application 이름: 파일 이름에서 .yaml만 뺀다(Go 템플릿이라 goTemplate이 켜져 있어야 한다)
    assert.equal(s.spec.goTemplate, true, `${env}: goTemplate`);
    assert.equal(s.spec.template.metadata.name, '{{ .path.basename | trimSuffix ".yaml" }}', `${env}: Application 이름`);
    assert.ok(TEAMS.map((x) => `peaket-${x}`).includes(t.project), `${env}: project ${t.project}`);
    // 차트는 source 하나이고, 그 파일 경로를 valueFiles로 받는다(파일 생성기의 .path.path)
    const sources = t.sources ?? (t.source ? [t.source] : []);
    assert.equal(sources.length, 1, `${env}: source 하나`);
    assert.equal(sources[0].repoURL, REPO_URL, `${env}: source.repoURL`);
    assert.equal(sources[0].targetRevision, 'develop', `${env}: source.targetRevision`);
    assert.equal(sources[0].path, 'deploy/charts/peaket-service', `${env}: 차트 경로`);
    assert.deepEqual(sources[0].helm.valueFiles, ['{{ .path.path }}'], `${env}: valueFiles`);
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

/** Git 파일 생성기의 패턴(마지막 마디의 *.yaml)에 저장소에서 실제로 맞는 '파일' 경로. '*'는 한 마디 안의 글자들이다 */
function filesMatching(pattern) {
  const parts = pattern.split('/');
  const name = parts.at(-1);
  assert.ok(name.includes('*'), `파일 패턴이 아니다: ${pattern}`);
  const dir = join(REPO, ...parts.slice(0, -1));
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const re = new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*')}$`);
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && re.test(d.name))
    .map((d) => `${parts.slice(0, -1).join('/')}/${d.name}`)
    .sort();
}
/** Go 템플릿 `{{ .path.basename | trimSuffix ".yaml" }}`가 파일 경로에 주는 Application 이름 */
const applicationName = (file) => file.split('/').at(-1).replace(/\.yaml$/, '');

test('DP-03 ApplicationSet 파일 생성기가 deploy/envs/local의 값 파일 여섯을 모두 찾고 각 파일 경로를 valueFiles로 받는다', () => {
  const sets = byKind(docs('applicationsets.yaml'), 'ApplicationSet');
  for (const env of ENVS) {
    const dir = join(REPO, 'deploy', 'envs', env);
    if (!existsSync(dir)) continue; // 아직 값이 없는 환경(demo·prod는 첫 승격 PR이 만든다)
    const expected = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.yaml'))
      .map((d) => `deploy/envs/${env}/${d.name}`)
      .sort();
    const s = sets.find((x) => x.metadata.name === `peaket-${env}`);
    assert.ok(s, `${env}: ApplicationSet peaket-${env}이 없다`);
    const git = s.spec.generators[0].git;
    // 생성기가 실제로 내놓는 파일이 env의 값 파일 전부와 같아야 한다(하나라도 빠지면 그 서비스는 배포되지 않는다)
    const matched = git.files.flatMap((f) => filesMatching(f.path)).sort();
    assert.deepEqual(matched, expected, `${env}: 파일 생성기가 값 파일과 다르다`);
    if (env === 'local') {
      // v0-gateway·v0-monolith·v1-bundle·v1-payment-relay·v1-purchase-relay·v1-realtime-gw
      assert.equal(expected.length, 6, `local 값 파일 ${expected.length}개`);
      assert.ok(expected.includes('deploy/envs/local/v1-realtime-gw.yaml'), 'v1-realtime-gw.yaml');
    }
    // 파일마다 Application 하나: 이름은 파일 이름에서 .yaml을 뺀 것, valueFiles는 그 파일 경로(.path.path)다
    const t = s.spec.template.spec;
    const sources = t.sources ?? (t.source ? [t.source] : []);
    assert.deepEqual(sources.flatMap((x) => x.helm.valueFiles), ['{{ .path.path }}'], `${env}: valueFiles`);
    assert.deepEqual(matched.map(applicationName), expected.map(applicationName), `${env}: Application 이름`);
    // 폴더(flags/)는 파일 생성기의 결과가 아니다
    for (const file of matched) assert.ok(file.endsWith('.yaml') && statSync(join(REPO, ...file.split('/'))).isFile(), `${env}: ${file}`);
  }
});
