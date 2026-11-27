// F-08-10 서비스 분리 효과 비교의 무대 계약(tools/local). 계획 docs/review/plans/F-08-10.md 2절 3·6.1·7.2.
// - (가) bundle: 같은 합본 이미지 한 프로세스(single), 복제 3, 파드 CPU는 네 역할 몫의 합.
// - 축소 (나) by-role: 같은 합본 이미지를 역할마다 따로 띄운 판. 정본의 열 갈래가 아니라 합본의 네 역할만 나눈다.
// - (다) services: 로컬 v1 무대에 10개 서비스 배포가 없어 이 도구는 거부한다.
// - apply는 Deployment/Service 적용 계획(JSON)만 쓴다. kubectl 적용은 측정 창에서 확인한다(이 턴 미실행).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 합본에 든 네 역할(켜는 차례). 정본 (나)의 열 갈래가 아니라 이 기능의 축소판이다. */
export const LOCAL_ROLES = Object.freeze(['payment-svc', 'purchase-svc', 'admission-ctrl', 'queue-svc']);

/** 역할별 자원 [가정]. (가) 합본 파드 자원은 이 넷의 합이다. */
export const ROLE_RESOURCES = Object.freeze(
  Object.fromEntries(LOCAL_ROLES.map((role) => [role, Object.freeze({ cpu: 1, memoryMi: 512 })])),
);

const NS = 'v1';
const roleList = (roles) => Object.keys(roles);

function checkResources(role, r) {
  if (!r || typeof r !== 'object') throw new RangeError(`${role}: 자원 값이 없다`);
  if (!Number.isInteger(r.cpu) || r.cpu < 1 || r.cpu > 16) throw new RangeError(`${role}: CPU는 1~16 정수다`);
  if (!Number.isInteger(r.memoryMi) || r.memoryMi < 256 || r.memoryMi > 32768) throw new RangeError(`${role}: 메모리는 256~32768Mi다`);
}

/**
 * (가)·축소 (나)의 배포 계획. 두 구성의 CPU·메모리 합계가 같아야 한다.
 * @param {{ config: 'bundle'|'by-role'|'services', replicas?: number, roles?: Record<string, {cpu:number, memoryMi:number}> }} o
 */
export function compareStagePlan(o = {}) {
  const { config } = o;
  if (!['bundle', 'by-role'].includes(config)) throw new RangeError(`로컬 비교 구성은 bundle·by-role만이다(services는 로컬 무대에 없다): ${config}`);
  const replicas = o.replicas ?? 3;
  if (!Number.isInteger(replicas) || replicas < 1 || replicas > 8) throw new RangeError('복제 수는 1~8 정수다');
  const roles = o.roles ?? ROLE_RESOURCES;
  const names = roleList(roles);
  for (const role of LOCAL_ROLES) if (!Object.hasOwn(roles, role)) throw new RangeError(`역할이 빠졌다: ${role}`);
  for (const role of names) {
    if (!LOCAL_ROLES.includes(role)) throw new RangeError(`모르는 역할: ${role}(합본의 네 역할만 쓴다)`);
    checkResources(role, roles[role]);
  }
  const sumCpu = LOCAL_ROLES.reduce((n, role) => n + roles[role].cpu, 0);
  const sumMemory = LOCAL_ROLES.reduce((n, role) => n + roles[role].memoryMi, 0);
  if (config === 'bundle') {
    const deployments = [{ name: 'bundle', replicas, cpu: sumCpu, memoryMi: sumMemory, services: [...LOCAL_ROLES] }];
    return {
      config,
      scope: 'bundle-four-services',
      mode: 'single',
      replicas,
      deployments,
      totals: { cpu: sumCpu * replicas, memoryMi: sumMemory * replicas },
    };
  }
  const deployments = LOCAL_ROLES.map((role) => ({ name: role, replicas, cpu: roles[role].cpu, memoryMi: roles[role].memoryMi, services: [role] }));
  return {
    config,
    scope: 'bundle-four-roles-shrink',
    mode: 'single',
    replicas,
    deployments,
    totals: { cpu: sumCpu * replicas, memoryMi: sumMemory * replicas },
  };
}

/** 두 계획의 CPU·메모리 합계가 같은지 확인한다. */
export function assertSameTotals(a, b) {
  if (!a?.totals || !b?.totals) throw new RangeError('합계가 없는 계획이다');
  if (a.totals.cpu !== b.totals.cpu || a.totals.memoryMi !== b.totals.memoryMi) {
    throw new RangeError(`자원 합계가 다르다: ${a.totals.cpu}·${a.totals.memoryMi} vs ${b.totals.cpu}·${b.totals.memoryMi}`);
  }
  return true;
}

/**
 * 구성별 k6·gRPC 주소. 역할별 배포는 Service 이름이 역할 이름이다.
 * @param {'bundle'|'by-role'|'services'} config
 * @param {string} [namespace]
 */
export function stageUrls(config, namespace = NS) {
  if (config === 'bundle') {
    return {
      queueUrl: `http://bundle.${namespace}.svc.cluster.local:8080`,
      purchaseUrl: `http://bundle.${namespace}.svc.cluster.local:8081`,
      holdUrl: `http://bundle.${namespace}.svc.cluster.local:8083`,
      paymentGrpc: '127.0.0.1:50051',
    };
  }
  if (config === 'by-role') {
    return {
      queueUrl: `http://queue-svc.${namespace}.svc.cluster.local:8080`,
      purchaseUrl: `http://purchase-svc.${namespace}.svc.cluster.local:8081`,
      holdUrl: `http://purchase-svc.${namespace}.svc.cluster.local:8083`,
      paymentGrpc: `payment-svc.${namespace}.svc.cluster.local:50051`,
    };
  }
  throw new RangeError(`로컬 비교 구성은 bundle·by-role만이다: ${config}`);
}

/** 역할별 배포에서 payment gRPC가 파드 밖으로 열리게 하는 환경 값. */
export function stageEnv(config, namespace = NS) {
  if (config === 'bundle') return { payment: { PEAKET_GRPC_HOST: '127.0.0.1' }, purchase: { PEAKET_PAYMENT_GRPC_ADDR: '127.0.0.1:50051' } };
  if (config === 'by-role') return { payment: { PEAKET_GRPC_HOST: '0.0.0.0' }, purchase: { PEAKET_PAYMENT_GRPC_ADDR: `payment-svc.${namespace}.svc.cluster.local:50051` } };
  throw new RangeError(`로컬 비교 구성은 bundle·by-role만이다: ${config}`);
}

const here = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === here) {
  try {
    const [cmd, ...rest] = process.argv.slice(2);
    if (cmd !== 'apply') throw new Error('쓰는 법: node tools/local/compare-stage.mjs apply --config bundle|by-role [--replicas 3]');
    let config;
    let replicas = 3;
    let namespace = NS;
    for (let i = 0; i < rest.length; i += 1) {
      const flag = rest[i];
      const v = rest[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag}에 값이 없다`);
      i += 1;
      if (flag === '--config') config = v;
      else if (flag === '--replicas') replicas = Number(v);
      else if (flag === '--namespace') namespace = v;
      else throw new Error(`모르는 인자: ${flag}`);
    }
    const plan = compareStagePlan({ config, replicas });
    const outDir = join('.cache', 'peaket-f10', 'stage');
    mkdirSync(outDir, { recursive: true });
    const out = join(outDir, `${config}.json`);
    writeFileSync(out, JSON.stringify({ ...plan, urls: stageUrls(config, namespace), env: stageEnv(config, namespace), applied: false, note: 'Deployment/Service 적용은 측정 창에서 한다' }, null, 2));
    console.log(`compare-stage: ${config} 계획을 ${out}에 남겼다(적용 안 함)`);
  } catch (e) {
    console.error(`compare-stage: ${e.message}`);
    process.exit(2);
  }
}
