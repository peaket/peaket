#!/usr/bin/env node
// 메시 포트별 허용 정책 생성기(BUILD_ORDER HOT-420, D-T36, ADR-0285 결정 1~9, docs/architecture.md §5 '포트별 허용 표'). 묶음 BAT-061 계획 4.2.
// 쓰는 법: node tools/ci/mesh-policies.mjs --write | --check [--root <폴더>]
//   --write  생성 파일 둘을 쓴다(원천·라우트·proto 대조 오류가 하나라도 있으면 쓰지 않는다)
//   --check  쓰지 않고 견준다. 다르면 바뀐 파일 이름과 첫 차이 줄을 보인다
//   --root   저장소 뿌리(기본은 이 파일의 두 단계 위). 시험이 임시 폴더를 가리킬 때 쓴다
// 입력: 원천 <root>/deploy/platform/mesh/port-allow.yaml, <root>/deploy/gateways/ 맨 위 *.yaml(하위 폴더는 읽지 않는다)의 HTTPRoute·GRPCRoute
//   backendRefs와 SecurityPolicy·EnvoyExtensionPolicy의 백엔드(공개키 묶음 remoteJWKS 주소 포함), <root>/docs/api/proto/peaket/**/*.proto의
//   package·service·rpc 이름, 있으면 배포 단위 값 <root>/deploy/workloads/<워크로드>/values.yaml(포트·업무 gRPC 주소, ADR-0285 결정 5·6)
// 출력: deploy/platform/mesh/policies.yaml(운영 오버레이: 노드 프록시 인가 정책 <워크로드>-ports, 웨이포인트 <워크로드>-waypoint,
//   업무 gRPC Service <워크로드>-grpc, 웨이포인트 인가 정책 <워크로드>-waypoint-callers), deploy/platform/mesh/meshless-networkpolicies.yaml
//   (메시 없는 실행의 NetworkPolicy <워크로드>-ports). 생성한 객체는 모두 라벨 peaket.io/generated-by: mesh-policies·peaket.io/workload를 단다(결정 3)
// 끝 코드: 0 같음·씀, 1 --check에서 다름 또는 원천·라우트·proto·배포 값 대조 오류(까닭을 '막음: <파일>: <까닭>' 줄로 모두 찍는다), 2 인자 오류
// 빈 결과는 통과가 아니다: 워크로드·라우트·proto 서비스를 하나도 읽지 못하면 1이다.
// 규칙에 출처(주체·출처 칸)나 포트가 빠진 것은 만들지 않는다(Istio ALLOW 규칙의 빈 from·to, NetworkPolicy의 빈 from·ports는 '모두'다).
// 부르는 쪽이 빈 목록인 proto 서비스·메서드는 규칙을 만들지 않는다(아무도 부르지 못함). 그 목록은 policies.yaml 머리 주석에 적는다.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments, stringify } from 'yaml';
import { runIfMain } from './entry.mjs';

export const SOURCE_FILE = 'deploy/platform/mesh/port-allow.yaml';
export const POLICIES_FILE = 'deploy/platform/mesh/policies.yaml';
export const MESHLESS_FILE = 'deploy/platform/mesh/meshless-networkpolicies.yaml';
export const GATEWAYS_DIR = 'deploy/gateways';
export const PROTO_DIR = 'docs/api/proto/peaket';
export const WORKLOAD_VALUES_DIR = 'deploy/workloads';
/** 생성 객체의 라벨(ADR-0285 결정 3) */
export const GENERATED_BY_LABEL = 'peaket.io/generated-by';
export const GENERATED_BY = 'mesh-policies';
export const WORKLOAD_LABEL = 'peaket.io/workload';
/** 포트 종류와 원천에 적는 차례 */
export const PORT_KINDS = ['rest', 'grpc', 'control', 'metrics'];
/** 웨이포인트가 듣는 HBONE 포트(Istio 앰비언트) */
export const WAYPOINT_PORT = 15008;
/** 제어 gRPC 계약(제어 포트가 받는다. 업무 gRPC 웨이포인트에는 두지 않는다, ADR-0102) */
export const CONTROL_SERVICE = 'peaket.control.v1.ControlReceiver';
/** proto 패키지 peaket.<x>.v1의 x → 받는 워크로드(ADR-0285 결정 1) */
export const PACKAGE_RECEIVERS = {
  core: 'core-svc',
  identity: 'identity-svc',
  payment: 'payment-svc',
  purchase: 'purchase-svc',
  queue: 'queue-svc',
  ticket: 'ticket-svc',
  trust: 'trust-svc',
  image: 'image-worker',
  seatmap: 'seatmap-worker',
};
/** 게이트웨이 프록시 파드를 고르는 라벨(Envoy Gateway v1.10) */
export const GATEWAY_NAME_LABEL = 'gateway.envoyproxy.io/owning-gateway-name';
export const NAMESPACE_NAME_LABEL = 'kubernetes.io/metadata.name';
const TRUST_DOMAIN = 'cluster.local';
const PRINCIPAL = /^cluster\.local\/ns\/([a-z0-9]([-a-z0-9]*[a-z0-9])?)\/sa\/([a-z0-9]([-a-z0-9.]*[a-z0-9])?)$/;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const PROTO_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GRPC_URL_KEY = /^PEAKET_[A-Z0-9_]+_GRPC_URL$/;

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const portOk = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;
const sameLabels = (a, b) => JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());
const labelsOf = (workload) => ({ [GENERATED_BY_LABEL]: GENERATED_BY, [WORKLOAD_LABEL]: workload });

/**
 * proto 글에서 주석과 글자열을 뺀다(줄 수는 그대로)
 * @param {string} text
 */
function stripProto(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') out += '\n';
        i++;
      }
      i++;
    } else if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < text.length && text[i] !== q) {
        if (text[i] === '\\') i++;
        i++;
      }
      out += '""';
    } else out += c;
  }
  return out;
}

/**
 * proto 파일 하나의 package와 service·rpc 이름
 * @param {string} text
 * @returns {{ package?: string, services: Array<{ name: string, methods: string[] }>, problems: string[] }}
 */
export function parseProto(text) {
  const src = stripProto(text);
  const problems = [];
  const pkg = /\bpackage\s+([A-Za-z0-9_.]+)\s*;/.exec(src)?.[1];
  const services = [];
  const re = /\bservice\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let j = re.lastIndex;
    for (; j < src.length && depth > 0; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') depth--;
    }
    if (depth !== 0) {
      problems.push(`service ${m[1]}의 닫는 괄호가 없다`);
      break;
    }
    const body = src.slice(re.lastIndex, j - 1);
    const methods = [...body.matchAll(/\brpc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map((x) => x[1]);
    services.push({ name: m[1], methods });
    re.lastIndex = j;
  }
  if (services.length && !pkg) problems.push('package 줄이 없다');
  return { package: pkg, services, problems };
}

/** 폴더 아래 확장자가 ext인 파일(하위 폴더 포함, 이름 차례) */
function walk(dir, ext) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const n of readdirSync(dir).sort(byText)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...walk(p, ext));
    else if (n.endsWith(ext)) out.push(p);
  }
  return out;
}

/**
 * <root>/docs/api/proto/peaket/**\/*.proto → 서비스 전체 이름 → { file, package, name, methods }
 * @param {string} root
 * @returns {{ services: Map<string, { file: string, package: string, name: string, methods: string[] }>, problems: Array<[string, string]> }}
 */
export function readProtos(root) {
  const services = new Map();
  const problems = [];
  for (const file of walk(join(root, PROTO_DIR), '.proto')) {
    const rel = relative(root, file).split('\\').join('/');
    const parsed = parseProto(readFileSync(file, 'utf8'));
    for (const p of parsed.problems) problems.push([rel, p]);
    for (const s of parsed.services) {
      const full = `${parsed.package}.${s.name}`;
      if (services.has(full)) problems.push([rel, `proto 서비스 ${full}가 ${services.get(full).file}에도 있다`]);
      else services.set(full, { file: rel, package: parsed.package, name: s.name, methods: s.methods });
    }
  }
  return { services, problems };
}

/**
 * <root>/deploy/gateways/ 맨 위 *.yaml의 객체(파일 이름 차례). 하위 폴더(routes·controller·test)는 읽지 않는다
 * @param {string} root
 * @returns {{ objects: Array<{ file: string, obj: Record<string, any> }>, problems: Array<[string, string]> }}
 */
export function readGatewayObjects(root) {
  const dir = join(root, GATEWAYS_DIR);
  const objects = [];
  const problems = [];
  if (!existsSync(dir)) return { objects, problems };
  for (const n of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).sort(byText)) {
    const p = join(dir, n);
    if (!statSync(p).isFile()) continue;
    const rel = `${GATEWAYS_DIR}/${n}`;
    for (const d of parseAllDocuments(readFileSync(p, 'utf8'))) {
      if (d.errors.length) {
        problems.push([rel, `YAML을 읽지 못했다: ${d.errors[0].message}`]);
        continue;
      }
      const o = d.toJS();
      if (isObject(o)) objects.push({ file: rel, obj: o });
    }
  }
  return { objects, problems };
}

/**
 * <root>/deploy/workloads/<이름>/values.yaml(있는 것만)
 * @param {string} root
 * @returns {{ values: Map<string, { file: string, values: Record<string, any> }>, problems: Array<[string, string]> }}
 */
export function readWorkloadValues(root) {
  const dir = join(root, WORKLOAD_VALUES_DIR);
  const values = new Map();
  const problems = [];
  if (!existsSync(dir)) return { values, problems };
  for (const n of readdirSync(dir).sort(byText)) {
    const p = join(dir, n, 'values.yaml');
    if (!existsSync(p)) continue;
    const rel = `${WORKLOAD_VALUES_DIR}/${n}/values.yaml`;
    try {
      values.set(n, { file: rel, values: parse(readFileSync(p, 'utf8')) ?? {} });
    } catch (e) {
      problems.push([rel, `YAML을 읽지 못했다: ${e.message}`]);
    }
  }
  return { values, problems };
}

/** 모르는 칸이 있으면 까닭 */
function unknownKeys(obj, allowed, where) {
  return Object.keys(obj)
    .filter((k) => !allowed.includes(k))
    .map((k) => `${where}: 모르는 칸 ${k}(아는 칸 ${allowed.join('·')})`);
}

/** 라벨 묶음이 바른가(빈 것은 needNonEmpty일 때 틀림) */
function labelProblems(labels, where, needNonEmpty) {
  if (!isObject(labels)) return [`${where}: 라벨 묶음(키: 값)이 아니다`];
  const out = [];
  if (needNonEmpty && Object.keys(labels).length === 0) out.push(`${where}: 비었다(네임스페이스의 모든 파드를 고르게 된다)`);
  for (const [k, v] of Object.entries(labels)) if (typeof v !== 'string' || v === '' || k === '') out.push(`${where}: 라벨 ${k}의 값이 비었거나 글이 아니다`);
  return out;
}

/**
 * 원천을 읽어 검사한다. 부르는 쪽 목록은 이름 차례로 정리해 돌려준다
 * @param {any} raw port-allow.yaml을 읽은 것
 * @param {Set<string>} gatewayNames deploy/gateways의 Gateway 이름
 */
export function checkSource(raw, gatewayNames = new Set()) {
  const problems = [];
  const at = (msg) => problems.push(msg);
  if (!isObject(raw)) return { problems: ['원천이 YAML 묶음(키: 값)이 아니다'] };
  for (const p of unknownKeys(raw, ['version', 'callers', 'workloads'], '맨 위')) at(p);
  if (raw.version !== 1) at(`version이 1이 아니다(${JSON.stringify(raw.version)})`);
  const callers = new Map();
  if (!isObject(raw.callers) || Object.keys(raw.callers).length === 0) at('callers가 비었거나 묶음이 아니다');
  else
    for (const [name, c] of Object.entries(raw.callers)) {
      const where = `callers.${name}`;
      if (!DNS_LABEL.test(name)) at(`${where}: 이름이 소문자·숫자·-가 아니다`);
      if (!isObject(c)) {
        at(`${where}: 묶음이 아니다`);
        continue;
      }
      for (const p of unknownKeys(c, ['principal', 'meshless'], where)) at(p);
      const pm = typeof c.principal === 'string' ? PRINCIPAL.exec(c.principal) : null;
      if (!pm) at(`${where}.principal: ${TRUST_DOMAIN}/ns/<네임스페이스>/sa/<서비스 계정> 꼴이 아니다(${JSON.stringify(c.principal)})`);
      if (!isObject(c.meshless)) {
        at(`${where}.meshless: 묶음이 아니다`);
        continue;
      }
      for (const p of unknownKeys(c.meshless, ['namespace', 'podLabels'], `${where}.meshless`)) at(p);
      if (typeof c.meshless.namespace !== 'string' || !DNS_LABEL.test(c.meshless.namespace)) at(`${where}.meshless.namespace: 네임스페이스 이름이 아니다`);
      if (c.meshless.podLabels !== undefined) for (const p of labelProblems(c.meshless.podLabels, `${where}.meshless.podLabels`, true)) at(p);
      if (pm && pm[1] !== c.meshless.namespace) at(`${where}: 주체의 네임스페이스(${pm[1]})와 메시 없는 고르개의 네임스페이스(${c.meshless.namespace})가 다르다`);
      const gatewayLabel = c.meshless.podLabels?.[GATEWAY_NAME_LABEL];
      if (gatewayLabel !== undefined && gatewayLabel !== name) at(`${where}: ${GATEWAY_NAME_LABEL} 라벨(${gatewayLabel})이 이름과 다르다`);
      callers.set(name, { name, principal: c.principal, namespace: c.meshless.namespace, podLabels: c.meshless.podLabels, gateway: gatewayNames.has(name) || gatewayLabel !== undefined });
    }
  const known = (list, where) => {
    if (!Array.isArray(list)) {
      at(`${where}: 부르는 쪽 목록(배열)이 아니다`);
      return [];
    }
    const out = [];
    for (const n of list) {
      if (typeof n !== 'string') at(`${where}: 이름이 글이 아니다(${JSON.stringify(n)})`);
      else if (!callers.has(n)) at(`${where}: 모르는 부르는 쪽 ${n}(callers에 없다)`);
      else if (out.includes(n)) at(`${where}: ${n}가 두 번 있다`);
      else out.push(n);
    }
    return out.sort(byText);
  };
  const workloads = new Map();
  if (!isObject(raw.workloads) || Object.keys(raw.workloads).length === 0) at('workloads가 비었거나 묶음이 아니다(정책을 하나도 만들 수 없다)');
  else
    for (const [name, w] of Object.entries(raw.workloads)) {
      const where = `workloads.${name}`;
      if (!DNS_LABEL.test(name) || `${name}-waypoint-callers`.length > 63) at(`${where}: 이름이 소문자·숫자·-가 아니거나 너무 길다`);
      if (!isObject(w)) {
        at(`${where}: 묶음이 아니다`);
        continue;
      }
      for (const p of unknownKeys(w, ['namespace', 'serviceAccount', 'podLabels', 'ports'], where)) at(p);
      if (typeof w.namespace !== 'string' || !DNS_LABEL.test(w.namespace)) at(`${where}.namespace: 네임스페이스 이름이 아니다`);
      const serviceAccount = w.serviceAccount ?? name;
      if (typeof serviceAccount !== 'string' || !DNS_LABEL.test(serviceAccount)) at(`${where}.serviceAccount: 서비스 계정 이름이 아니다`);
      for (const p of labelProblems(w.podLabels, `${where}.podLabels`, true)) at(p);
      const self = callers.get(name);
      if (self) {
        const principal = `${TRUST_DOMAIN}/ns/${w.namespace}/sa/${serviceAccount}`;
        if (self.principal !== principal) at(`callers.${name}.principal: 워크로드의 주체 ${principal}와 다르다`);
        if (self.namespace !== w.namespace || !sameLabels(self.podLabels, w.podLabels)) at(`callers.${name}.meshless: 워크로드 칸의 네임스페이스·podLabels와 다르다`);
      }
      const ports = {};
      if (!isObject(w.ports)) {
        at(`${where}.ports: 묶음이 아니다(받는 통신이 없으면 {})`);
        workloads.set(name, { name, namespace: w.namespace, serviceAccount, podLabels: w.podLabels ?? {}, ports });
        continue;
      }
      for (const p of unknownKeys(w.ports, PORT_KINDS, `${where}.ports`)) at(p);
      const used = new Map();
      for (const kind of PORT_KINDS) {
        const p = w.ports[kind];
        if (p === undefined) continue;
        const pw = `${where}.ports.${kind}`;
        if (!isObject(p)) {
          at(`${pw}: 묶음이 아니다`);
          continue;
        }
        if (!portOk(p.port)) at(`${pw}.port: 1~65535 정수가 아니다(${JSON.stringify(p.port)})`);
        else if (used.has(p.port)) at(`${pw}.port: ${p.port}를 ${used.get(p.port)}도 쓴다`);
        else used.set(p.port, kind);
        if (kind === 'grpc') {
          for (const x of unknownKeys(p, ['port', 'services'], pw)) at(x);
          const services = new Map();
          if (!isObject(p.services) || Object.keys(p.services).length === 0) at(`${pw}.services: 비었거나 묶음이 아니다(업무 gRPC를 받지 않으면 grpc 칸을 지운다)`);
          else
            for (const [svc, v] of Object.entries(p.services)) {
              const sw = `${pw}.services.${svc}`;
              if (svc === CONTROL_SERVICE) at(`${sw}: 제어 gRPC는 업무 gRPC 포트가 아니라 control 칸이다`);
              if (Array.isArray(v)) services.set(svc, { callers: known(v, sw) });
              else if (isObject(v) && isObject(v.methods)) {
                for (const x of unknownKeys(v, ['methods'], sw)) at(x);
                const methods = new Map();
                if (Object.keys(v.methods).length === 0) at(`${sw}.methods: 비었다`);
                for (const [m, list] of Object.entries(v.methods)) {
                  if (!PROTO_NAME.test(m)) at(`${sw}.methods.${m}: 메서드 이름이 아니다`);
                  methods.set(m, known(list, `${sw}.methods.${m}`));
                }
                services.set(svc, { methods });
              } else at(`${sw}: 부르는 쪽 목록이나 { methods: { <메서드>: [...] } }가 아니다`);
            }
          ports.grpc = { port: p.port, services };
        } else {
          const allowed = kind === 'rest' ? ['port', 'callers', 'gatewaysWithoutRoute'] : ['port', 'callers'];
          for (const x of unknownKeys(p, allowed, pw)) at(x);
          const list = known(p.callers, `${pw}.callers`);
          const entry = { port: p.port, callers: list };
          if (kind === 'rest') {
            for (const n of list) if (callers.get(n)?.gateway) at(`${pw}.callers: 게이트웨이 ${n}는 적지 않는다(라우트에서 뽑는다. 라우트가 저장소에 없는 경로는 gatewaysWithoutRoute에)`);
            entry.gatewaysWithoutRoute = p.gatewaysWithoutRoute === undefined ? [] : known(p.gatewaysWithoutRoute, `${pw}.gatewaysWithoutRoute`);
            for (const n of entry.gatewaysWithoutRoute) if (!callers.get(n)?.gateway) at(`${pw}.gatewaysWithoutRoute: ${n}는 게이트웨이가 아니다`);
          }
          ports[kind] = entry;
        }
      }
      workloads.set(name, { name, namespace: w.namespace, serviceAccount, podLabels: w.podLabels ?? {}, ports });
    }
  return { problems, callers, workloads };
}

/** 라우트·정책의 백엔드 참조 하나 → { name, namespace, port } 또는 문제 */
function serviceRef(ref, defaultNs) {
  if (!isObject(ref)) return { problem: `백엔드 참조가 묶음이 아니다(${JSON.stringify(ref)})` };
  const group = ref.group ?? '';
  const kind = ref.kind ?? 'Service';
  if ((group !== '' && group !== 'core') || kind !== 'Service') return { problem: `Service가 아닌 백엔드 ${group || 'core'}/${kind} ${ref.name}(이 생성기가 받는 쪽을 정하지 못한다)` };
  if (!portOk(ref.port)) return { problem: `백엔드 Service ${ref.name}에 포트가 없다` };
  return { name: ref.name, namespace: ref.namespace ?? defaultNs, port: ref.port };
}

/** 묶음 안의 backendRefs(배열)·backendRef(묶음)를 모두 */
function deepBackendRefs(v, out = []) {
  if (Array.isArray(v)) for (const x of v) deepBackendRefs(x, out);
  else if (isObject(v))
    for (const [k, x] of Object.entries(v)) {
      if (k === 'backendRefs' && Array.isArray(x)) out.push(...x);
      else if (k === 'backendRef' && isObject(x)) out.push(x);
      else deepBackendRefs(x, out);
    }
  return out;
}

/** 공개키 묶음 주소 http(s)://<서비스>.<네임스페이스>.svc[.cluster.local][:포트]/… → 백엔드(클러스터 밖 주소면 undefined) */
function clusterUrl(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch {
    return { problem: `주소를 읽지 못했다(${uri})` };
  }
  const m = /^([a-z0-9]([-a-z0-9]*[a-z0-9])?)\.([a-z0-9]([-a-z0-9]*[a-z0-9])?)\.svc(\.cluster\.local)?\.?$/.exec(u.hostname);
  if (!m) return undefined;
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  return { name: m[1], namespace: m[3], port };
}

/**
 * 게이트웨이 → 워크로드 REST 포트. 라우트 parentRefs의 게이트웨이마다 그 규칙의 백엔드, 정책(SecurityPolicy·EnvoyExtensionPolicy)이 붙은
 * 게이트웨이마다 그 정책의 백엔드(remoteJWKS 주소 포함)
 * @param {Array<{ file: string, obj: Record<string, any> }>} objects
 * @returns {{ reach: Array<{ file: string, gateway: { name: string, namespace: string }, backend: { name: string, namespace: string, port: number }, via: string }>, routes: number, gateways: Set<string>, problems: Array<[string, string]> }}
 */
export function gatewayReach(objects) {
  const problems = [];
  const reach = [];
  const gateways = new Set();
  const routes = new Map();
  for (const { obj } of objects) if (obj.kind === 'Gateway' && obj.metadata?.name) gateways.add(obj.metadata.name);
  const parentsOf = (file, r) => {
    const ns = r.metadata?.namespace ?? 'default';
    const out = [];
    for (const p of r.spec?.parentRefs ?? []) {
      if ((p.group ?? 'gateway.networking.k8s.io') !== 'gateway.networking.k8s.io' || (p.kind ?? 'Gateway') !== 'Gateway') problems.push([file, `${r.kind}/${r.metadata?.name}: Gateway가 아닌 부모 ${p.kind}/${p.name}`]);
      else out.push({ name: p.name, namespace: p.namespace ?? ns });
    }
    if (!out.length) problems.push([file, `${r.kind}/${r.metadata?.name}: 부모 게이트웨이가 없다`]);
    return out;
  };
  for (const { file, obj } of objects) {
    if (!/Route$/.test(obj.kind ?? '')) continue;
    if (obj.kind !== 'HTTPRoute' && obj.kind !== 'GRPCRoute') {
      problems.push([file, `${obj.kind}/${obj.metadata?.name}: 이 생성기가 다루지 않는 라우트 종류다(HTTPRoute·GRPCRoute만)`]);
      continue;
    }
    const ns = obj.metadata?.namespace ?? 'default';
    routes.set(`${obj.kind}/${ns}/${obj.metadata?.name}`, { file, obj });
    const parents = parentsOf(file, obj);
    for (const rule of obj.spec?.rules ?? [])
      for (const ref of deepBackendRefs(rule)) {
        const b = serviceRef(ref, ns);
        if (b.problem) problems.push([file, `${obj.kind}/${obj.metadata?.name}: ${b.problem}`]);
        else for (const g of parents) reach.push({ file, gateway: g, backend: b, via: `${obj.kind}/${obj.metadata?.name}` });
      }
  }
  for (const { file, obj } of objects) {
    if (obj.kind !== 'SecurityPolicy' && obj.kind !== 'EnvoyExtensionPolicy') continue;
    const ns = obj.metadata?.namespace ?? 'default';
    const where = `${obj.kind}/${obj.metadata?.name}`;
    const backends = [];
    for (const ref of deepBackendRefs(obj.spec)) {
      const b = serviceRef(ref, ns);
      if (b.problem) problems.push([file, `${where}: ${b.problem}`]);
      else backends.push(b);
    }
    for (const p of obj.spec?.jwt?.providers ?? []) {
      if (!p?.remoteJWKS?.uri) continue;
      const b = clusterUrl(p.remoteJWKS.uri);
      if (b?.problem) problems.push([file, `${where}: 공개키 묶음 ${b.problem}`]);
      else if (b) backends.push(b);
    }
    if (!backends.length) continue;
    if (obj.spec?.targetSelectors) problems.push([file, `${where}: targetSelectors로 붙는 정책은 붙는 게이트웨이를 정하지 못한다(targetRefs로 적는다)`]);
    const targets = [...(obj.spec?.targetRefs ?? []), ...(obj.spec?.targetRef ? [obj.spec.targetRef] : [])];
    const gws = [];
    for (const t of targets) {
      if (t.kind === 'Gateway') gws.push({ name: t.name, namespace: ns });
      else if (t.kind === 'HTTPRoute' || t.kind === 'GRPCRoute') {
        const r = routes.get(`${t.kind}/${ns}/${t.name}`);
        if (!r) problems.push([file, `${where}: 붙는 ${t.kind} ${t.name}가 ${GATEWAYS_DIR} 맨 위 YAML에 없다`]);
        else gws.push(...parentsOf(r.file, r.obj));
      } else problems.push([file, `${where}: 붙는 대상 ${t.kind}/${t.name}를 다루지 않는다(Gateway·HTTPRoute·GRPCRoute만)`]);
    }
    if (!gws.length) problems.push([file, `${where}: 백엔드에 닿는데 붙는 게이트웨이를 찾지 못했다`]);
    for (const g of gws) for (const b of backends) reach.push({ file, gateway: g, backend: b, via: where });
  }
  return { reach, routes: routes.size, gateways, problems };
}

/** proto 패키지 peaket.<x>.v<n> → 받는 워크로드(제어면 'control', 모르면 undefined) */
function receiverOf(pkg) {
  const x = /^peaket\.([a-z0-9]+)\.v\d+$/.exec(pkg ?? '')?.[1];
  if (x === 'control') return 'control';
  return x ? PACKAGE_RECEIVERS[x] : undefined;
}

/**
 * 원천의 업무 gRPC 서비스·메서드와 proto를 견준다(ADR-0285 결정 1, 계획 4.2의 3)
 * @param {Map<string, any>} workloads checkSource의 workloads
 * @param {Map<string, { file: string, package: string, methods: string[] }>} protos
 */
export function protoProblems(workloads, protos) {
  const out = [];
  if (protos.size === 0) out.push([PROTO_DIR, 'proto 서비스를 하나도 읽지 못했다']);
  const owner = new Map();
  for (const w of workloads.values())
    for (const [svc, v] of w.ports.grpc?.services ?? []) {
      const where = `workloads.${w.name}.ports.grpc.services.${svc}`;
      if (owner.has(svc)) out.push([SOURCE_FILE, `${where}: ${owner.get(svc)}에도 있다(받는 쪽은 하나다)`]);
      owner.set(svc, w.name);
      const p = protos.get(svc);
      if (!p) {
        out.push([SOURCE_FILE, `${where}: proto에 없는 서비스다`]);
        continue;
      }
      const receiver = receiverOf(p.package);
      if (receiver !== w.name) out.push([SOURCE_FILE, `${where}: 패키지 ${p.package}의 받는 쪽은 ${receiver ?? '(정하지 못함)'}다`]);
      if (v.methods) {
        for (const m of v.methods.keys()) if (!p.methods.includes(m)) out.push([SOURCE_FILE, `${where}.methods.${m}: proto(${p.file})에 없는 메서드다`]);
        for (const m of p.methods) if (!v.methods.has(m)) out.push([SOURCE_FILE, `${where}.methods: proto 메서드 ${svc}/${m}(${p.file})의 부르는 쪽이 없다(메서드로 나눈 서비스는 모든 메서드를 적는다)`]);
      }
    }
  for (const [svc, p] of protos) {
    if (svc === CONTROL_SERVICE || owner.has(svc)) continue;
    const receiver = receiverOf(p.package);
    out.push([SOURCE_FILE, `원천에 없는 proto 서비스 ${svc}(${p.file}). ${receiver && receiver !== 'control' ? `workloads.${receiver}.ports.grpc.services에` : '받는 워크로드를 정해'} 부르는 쪽과 함께 더한다`]);
  }
  return out;
}

/** 배포 단위 값과 원천이 같은지(ADR-0285 결정 5·6) */
export function valuesProblems(workloads, values) {
  const out = [];
  const grpcUrls = [];
  for (const [name, { file, values: v }] of values) {
    const w = workloads.get(name);
    if (w && v?.service?.port !== undefined && v.service.port !== w.ports.rest?.port) out.push([file, `service.port ${v.service.port}가 원천 REST 포트 ${w.ports.rest?.port ?? '(없음)'}와 다르다`]);
    if (w && v?.managementPort !== undefined && v.managementPort !== w.ports.metrics?.port) out.push([file, `managementPort ${v.managementPort}가 원천 지표 포트 ${w.ports.metrics?.port ?? '(없음)'}와 다르다`]);
    for (const at of ['env', 'service.env', 'outboxRelay.env']) {
      const env = at.split('.').reduce((o, k) => o?.[k], v);
      if (isObject(env)) for (const [k, x] of Object.entries(env)) if (GRPC_URL_KEY.test(k)) grpcUrls.push({ file, key: `${at}.${k}`, value: x });
    }
  }
  for (const { file, key, value } of grpcUrls) {
    const m = /^([a-z0-9-]+)-grpc:(\d+)$/.exec(String(value));
    const w = m ? workloads.get(m[1]) : undefined;
    if (!m || !w?.ports.grpc) out.push([file, `${key} ${JSON.stringify(value)}: 업무 gRPC 주소는 <업무 gRPC 워크로드>-grpc:<포트>다(웨이포인트를 붙인 Service, ADR-0285 결정 5)`]);
    else if (Number(m[2]) !== w.ports.grpc.port) out.push([file, `${key} ${JSON.stringify(value)}: ${w.name}의 업무 gRPC 포트는 ${w.ports.grpc.port}다`]);
  }
  return out;
}

/** 부르는 쪽 이름들 → 주체 목록(이름 차례) */
const principals = (names, callers) => [...new Set(names)].sort(byText).map((n) => callers.get(n).principal);

/** 부르는 쪽 이름들 → NetworkPolicy 출처 칸(부르는 쪽마다 한 칸, 네임스페이스와 파드 라벨을 함께) */
function peers(names, callers) {
  return [...new Set(names)].sort(byText).map((n) => {
    const c = callers.get(n);
    const peer = { namespaceSelector: { matchLabels: { [NAMESPACE_NAME_LABEL]: c.namespace } } };
    if (c.podLabels) peer.podSelector = { matchLabels: { ...c.podLabels } };
    return peer;
  });
}

/**
 * 원천·게이트웨이 정의·proto로 생성 파일 둘을 만든다
 * @param {{ source: any, gatewayObjects: Array<{ file: string, obj: Record<string, any> }>, protos: Map<string, any>, workloadValues?: Map<string, any> }} o
 * @returns {{ files: Map<string, string>, problems: Array<[string, string]>, uncalled: string[] }}
 */
export function generate(o) {
  const problems = [];
  const reachInfo = gatewayReach(o.gatewayObjects);
  problems.push(...reachInfo.problems);
  if (reachInfo.routes === 0) problems.push([GATEWAYS_DIR, '라우트(HTTPRoute)를 하나도 읽지 못했다(게이트웨이 REST 허용을 정하지 못한다)']);
  const src = checkSource(o.source, reachInfo.gateways);
  for (const p of src.problems) problems.push([SOURCE_FILE, p]);
  if (!src.workloads || !src.callers) return { files: new Map(), problems, uncalled: [] };
  const { callers, workloads } = src;
  problems.push(...protoProblems(workloads, o.protos));
  problems.push(...valuesProblems(workloads, o.workloadValues ?? new Map()));

  // 게이트웨이 → 워크로드 REST 포트
  const restGateways = new Map([...workloads.keys()].map((n) => [n, new Set()]));
  for (const r of reachInfo.reach) {
    const g = callers.get(r.gateway.name);
    const where = `${r.via} → ${r.backend.namespace}/${r.backend.name}:${r.backend.port}`;
    if (!g) problems.push([r.file, `${where}: 게이트웨이 ${r.gateway.name}가 원천 callers에 없다`]);
    else if (!g.gateway) problems.push([r.file, `${where}: callers.${r.gateway.name}가 게이트웨이가 아니다(Gateway 객체·${GATEWAY_NAME_LABEL} 라벨 없음)`]);
    else if (g.namespace !== r.gateway.namespace) problems.push([r.file, `${where}: 게이트웨이 ${r.gateway.name}의 네임스페이스 ${r.gateway.namespace}가 원천(${g.namespace})과 다르다`]);
    const w = workloads.get(r.backend.name);
    if (!w) {
      problems.push([r.file, `${where}: 원천에 없는 워크로드 ${r.backend.name}로 간다(원천 workloads에 더하거나 라우트를 고친다)`]);
      continue;
    }
    if (w.namespace !== r.backend.namespace) problems.push([r.file, `${where}: ${w.name}의 네임스페이스는 원천에서 ${w.namespace}다`]);
    else if (w.ports.rest?.port !== r.backend.port) problems.push([r.file, `${where}: ${w.name}의 REST 포트는 원천에서 ${w.ports.rest?.port ?? '(없음)'}다`]);
    else if (g?.gateway) restGateways.get(w.name).add(g.name);
  }
  for (const w of workloads.values())
    for (const n of w.ports.rest?.gatewaysWithoutRoute ?? []) if (restGateways.get(w.name).has(n)) problems.push([SOURCE_FILE, `workloads.${w.name}.ports.rest.gatewaysWithoutRoute: ${n}는 라우트가 이미 준다(예외에서 지운다)`]);
  if (problems.length) return { files: new Map(), problems, uncalled: [] };

  const mesh = [];
  const meshless = [];
  const uncalled = [];
  for (const w of [...workloads.values()].sort((a, b) => byText(a.name, b.name))) {
    const ports = [];
    for (const kind of PORT_KINDS) {
      const p = w.ports[kind];
      if (!p) continue;
      let names;
      let meshNames;
      if (kind === 'grpc') {
        names = [];
        for (const [svc, v] of [...p.services].sort((a, b) => byText(a[0], b[0]))) {
          if (v.methods)
            for (const [m, list] of [...v.methods].sort((a, b) => byText(a[0], b[0]))) {
              if (!list.length) uncalled.push(`${svc}/${m}`);
              names.push(...list);
            }
          else {
            if (!v.callers.length) uncalled.push(svc);
            names.push(...v.callers);
          }
        }
        meshNames = null; // 노드 프록시는 웨이포인트 하나
      } else {
        names = kind === 'rest' ? [...p.callers, ...p.gatewaysWithoutRoute, ...restGateways.get(w.name)] : [...p.callers];
        meshNames = names;
      }
      ports.push({ kind, port: p.port, names, meshNames });
    }
    ports.sort((a, b) => a.port - b.port);
    const meta = (name) => ({ name, namespace: w.namespace, labels: labelsOf(w.name) });
    const waypoint = `${w.name}-waypoint`;
    const waypointPrincipal = `${TRUST_DOMAIN}/ns/${w.namespace}/sa/${waypoint}`;
    const meshRules = [];
    for (const p of ports) {
      const from = p.kind === 'grpc' ? [waypointPrincipal] : principals(p.meshNames, callers);
      if (!from.length) continue;
      meshRules.push({ from: [{ source: { principals: from } }], to: [{ operation: { ports: [String(p.port)] } }] });
    }
    const nodePolicy = { apiVersion: 'security.istio.io/v1', kind: 'AuthorizationPolicy', metadata: meta(`${w.name}-ports`), spec: { selector: { matchLabels: { ...w.podLabels } }, action: 'ALLOW' } };
    if (meshRules.length) nodePolicy.spec.rules = meshRules;
    mesh.push(nodePolicy);
    if (w.ports.grpc) {
      const g = w.ports.grpc;
      mesh.push({
        apiVersion: 'gateway.networking.k8s.io/v1',
        kind: 'Gateway',
        metadata: { name: waypoint, namespace: w.namespace, labels: { ...labelsOf(w.name), 'istio.io/waypoint-for': 'service' } },
        spec: { gatewayClassName: 'istio-waypoint', listeners: [{ name: 'mesh', port: WAYPOINT_PORT, protocol: 'HBONE' }] },
      });
      mesh.push({
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: `${w.name}-grpc`, namespace: w.namespace, labels: { ...labelsOf(w.name), 'istio.io/use-waypoint': waypoint } },
        spec: { selector: { ...w.podLabels }, ports: [{ name: 'grpc', port: g.port, targetPort: g.port, protocol: 'TCP', appProtocol: 'grpc' }] },
      });
      const rules = [];
      for (const [svc, v] of [...g.services].sort((a, b) => byText(a[0], b[0]))) {
        const entries = v.methods ? [...v.methods].sort((a, b) => byText(a[0], b[0])).map(([m, list]) => [`/${svc}/${m}`, list]) : [[`/${svc}/*`, v.callers]];
        for (const [path, list] of entries) if (list.length) rules.push({ from: [{ source: { principals: principals(list, callers) } }], to: [{ operation: { paths: [path] } }] });
      }
      const waypointPolicy = {
        apiVersion: 'security.istio.io/v1',
        kind: 'AuthorizationPolicy',
        metadata: meta(`${w.name}-waypoint-callers`),
        spec: { targetRefs: [{ group: 'gateway.networking.k8s.io', kind: 'Gateway', name: waypoint }], action: 'ALLOW' },
      };
      if (rules.length) waypointPolicy.spec.rules = rules;
      mesh.push(waypointPolicy);
    }
    const ingress = [];
    for (const p of ports) {
      const from = peers(p.names, callers);
      if (!from.length) continue;
      ingress.push({ from, ports: [{ protocol: 'TCP', port: p.port }] });
    }
    meshless.push({ apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: meta(`${w.name}-ports`), spec: { podSelector: { matchLabels: { ...w.podLabels } }, policyTypes: ['Ingress'], ingress } });
  }
  if (!mesh.length || !meshless.length) return { files: new Map(), problems: [[SOURCE_FILE, '정책을 하나도 만들지 못했다']], uncalled };
  const body = (docs) => docs.map((d) => `---\n${stringify(d, { lineWidth: 0 })}`).join('');
  const head = `# 생성 파일이다. 손으로 고치지 않는다(원천 ${SOURCE_FILE}과 ${GATEWAYS_DIR}/*.yaml의 라우트·공개키 묶음 주소, docs/api/proto에서 node tools/ci/mesh-policies.mjs --write가 만든다, ADR-0285 결정 2)`;
  const files = new Map([
    [
      POLICIES_FILE,
      [
        head,
        '# 운영 오버레이 몫: 받는 쪽 노드 프록시 인가 정책 <워크로드>-ports(포트마다 허용 주체, 업무 gRPC 포트는 그 워크로드의 웨이포인트 하나), 업무 gRPC 워크로드의',
        '# 웨이포인트 <워크로드>-waypoint와 업무 gRPC Service <워크로드>-grpc, 웨이포인트 인가 정책 <워크로드>-waypoint-callers(서비스·메서드 경로마다 부르는 쪽, docs/architecture.md §5 \'포트별 허용 표\')',
        `# 부르는 쪽이 없어 규칙을 만들지 않은 업무 gRPC(아무도 부르지 못함): ${uncalled.length ? uncalled.join(', ') : '없음'}`,
        '',
      ].join('\n') + body(mesh),
    ],
    [
      MESHLESS_FILE,
      [
        head,
        '# 메시 없는 로컬·CI·데모 몫: 워크로드마다 Ingress NetworkPolicy <워크로드>-ports(포트마다 부르는 쪽의 네임스페이스와 파드 라벨을 한 출처 칸에 함께).',
        '# 업무 gRPC 포트는 경로로 거르지 못해 그 워크로드의 모든 업무 gRPC 부르는 쪽을 합쳐 받는다(ADR-0285 결정 8). 운영 오버레이에는 넣지 않는다(docs/infra.md §9)',
        '',
      ].join('\n') + body(meshless),
    ],
  ]);
  return { files, problems: [], uncalled };
}

/** 첫 차이 줄(1부터) */
function firstDiff(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return { line: i + 1, disk: x[i], want: y[i] };
  return null;
}

const USAGE = '쓰는 법: node tools/ci/mesh-policies.mjs --write | --check [--root <폴더>]';

/**
 * 저장소 뿌리에서 입력을 읽어 만든다(읽기 오류도 막음으로 돌려준다)
 * @param {string} root
 */
export function generateFromRoot(root) {
  const problems = [];
  let source;
  const sourcePath = join(root, SOURCE_FILE);
  if (!existsSync(sourcePath)) problems.push([SOURCE_FILE, '원천 파일이 없다']);
  else
    try {
      source = parse(readFileSync(sourcePath, 'utf8'));
    } catch (e) {
      problems.push([SOURCE_FILE, `YAML을 읽지 못했다: ${e.message}`]);
    }
  const gw = readGatewayObjects(root);
  const protos = readProtos(root);
  const values = readWorkloadValues(root);
  problems.push(...gw.problems, ...protos.problems, ...values.problems);
  if (problems.length) return { files: new Map(), problems, uncalled: [] };
  return generate({ source, gatewayObjects: gw.objects, protos: protos.services, workloadValues: values.values });
}

/** @param {string[]} argv @returns {number} */
export function main(argv) {
  let mode;
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write' || a === '--check') {
      if (mode) {
        console.error(`mesh-policies: --write와 --check는 하나만 쓴다\n${USAGE}`);
        return 2;
      }
      mode = a;
    } else if (a === '--root') {
      if (!argv[i + 1]) {
        console.error(`mesh-policies: --root 뒤에 폴더가 없다\n${USAGE}`);
        return 2;
      }
      root = resolve(argv[++i]);
    } else {
      console.error(`mesh-policies: 모르는 인자 ${a}\n${USAGE}`);
      return 2;
    }
  }
  if (!mode) {
    console.error(USAGE);
    return 2;
  }
  const { files, problems: all, uncalled } = generateFromRoot(root);
  // 같은 까닭(라우트 여럿이 같은 백엔드를 가리킴 등)은 한 줄로 찍는다
  const problems = [...new Map(all.map(([file, why]) => [JSON.stringify([file, why]), [file, why]])).values()];
  if (problems.length) {
    console.error(`mesh-policies: 원천·라우트·proto 대조 오류 ${problems.length}건(생성 파일을 쓰지 않았다)`);
    for (const [file, why] of problems) console.error(`막음: ${file}: ${why}`);
    return 1;
  }
  if (mode === '--write') {
    for (const [rel, text] of files) writeFileSync(join(root, rel), text);
    console.log(`mesh-policies: ${files.size}개를 썼다(${[...files.keys()].join(', ')}). 부르는 쪽이 없는 업무 gRPC: ${uncalled.join(', ') || '없음'}`);
    return 0;
  }
  const diffs = [];
  for (const [rel, text] of files) {
    const file = join(root, rel);
    if (!existsSync(file)) {
      diffs.push([rel, '생성 파일이 없다(node tools/ci/mesh-policies.mjs --write)']);
      continue;
    }
    const disk = readFileSync(file, 'utf8');
    if (disk === text) continue;
    const d = firstDiff(disk, text);
    diffs.push([rel, `다시 만든 결과와 다르다(줄 ${d?.line}: 저장소 ${JSON.stringify(d?.disk ?? '(없음)')} / 생성 ${JSON.stringify(d?.want ?? '(없음)')}). 손으로 고치지 않고 원천을 고쳐 --write로 다시 만든다`]);
  }
  if (diffs.length) {
    console.error(`mesh-policies: 생성 대조 실패(${diffs.length}건)`);
    for (const [file, why] of diffs) console.error(`막음: ${file}: ${why}`);
    return 1;
  }
  console.log(`mesh-policies: 생성 파일 ${files.size}개가 원천·라우트·proto와 같다. 부르는 쪽이 없는 업무 gRPC: ${uncalled.join(', ') || '없음'}`);
  return 0;
}

await runIfMain(import.meta.url, () => main(process.argv.slice(2)));
