// 제어 gRPC 받는 파드 찾기(F-02-1 OPS-300, ADR-0365 결정 3, ASVS 1.3.6). 주소는 이 설정에서만 오고 명령 값에서 오지 않는다.
// - local·ci: 환경 값 PEAKET_<서비스>_CONTROL_GRPC_ADDRS(쉼표로 나눈 host:port 목록). 지금의 PEAKET_<서비스>_CONTROL_GRPC_ADDR 하나도 받는다.
// - 운영: PEAKET_<서비스>_CONTROL_GRPC_DNS(헤드리스 Service <서비스>-control의 이름:포트). 보낼 때마다 DNS A 기록을 다시 푼다(캐시하지 않는다,
//   클러스터 DNS는 EndpointSlice의 준비된 주소만 준다). admission-ctrl은 리더 전용 Service의 이름 하나다.
// - local·ci 밖에서 받는 쪽 셋 가운데 하나라도 주소 설정이 없으면 시작이 실패한다(던짐).
import { resolve4 } from 'node:dns/promises';
import type { ControlTargets } from '../modules/commands/index.js';

/** 받는 쪽 서비스와 환경 값 앞머리 */
export const CONTROL_TARGET_ENV: Readonly<Record<string, string>> = Object.freeze({
  'purchase-svc': 'PEAKET_PURCHASE_CONTROL_GRPC',
  'queue-svc': 'PEAKET_QUEUE_CONTROL_GRPC',
  'admission-ctrl': 'PEAKET_ADMISSION_CONTROL_GRPC',
});

/** 주소 설정 없이 뜰 수 있는 환경(제어 명령은 보내지 못해 ack 시한에 FAILED다) */
export const CONTROL_TARGETS_OPTIONAL_ENVS: readonly string[] = ['local', 'ci'];

const HOST_PORT = /^[A-Za-z0-9.-]{1,253}:\d{1,5}$/;

function hostPortOf(raw: string, name: string): { host: string; port: number } {
  const at = raw.lastIndexOf(':');
  const port = Number(raw.slice(at + 1));
  if (!HOST_PORT.test(raw) || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`${name}는 host:port(쉼표 목록)여야 한다`);
  return { host: raw.slice(0, at), port };
}

/** 서비스 하나의 주소 원천 */
export type ControlTargetSource = { readonly kind: 'static'; readonly addresses: readonly string[] } | { readonly kind: 'dns'; readonly host: string; readonly port: number };

/** 이름 풀기(시험은 가짜를 넣는다) */
export type ResolveA = (host: string) => Promise<readonly string[]>;

export class ConfiguredControlTargets implements ControlTargets {
  constructor(
    private readonly sources: Readonly<Record<string, ControlTargetSource>>,
    private readonly resolveA: ResolveA = (host) => resolve4(host),
  ) {}

  /** 설정이 있는 서비스 */
  get services(): string[] {
    return Object.keys(this.sources);
  }

  async resolve(service: string): Promise<readonly string[]> {
    const s = this.sources[service];
    if (!s) return [];
    if (s.kind === 'static') return s.addresses;
    // 부를 때마다 다시 푼다(ADR-0365 결정 3, 정할 것 5: 캐시하지 않는다)
    const ips = await this.resolveA(s.host);
    return [...new Set(ips)].sort().map((ip) => `${ip}:${s.port}`);
  }
}

/**
 * 환경 값에서 받는 쪽 주소 설정을 읽는다. 꼴이 틀리면 던진다. local·ci 밖에서 서비스 하나라도 설정이 없으면 던진다.
 * @returns targets와 설정이 없는 서비스(local·ci 경고용)
 */
export function controlTargetsFromEnv(env: Readonly<Record<string, string | undefined>>, resolveA?: ResolveA): { targets: ConfiguredControlTargets; missing: string[] } {
  const sources: Record<string, ControlTargetSource> = {};
  const missing: string[] = [];
  for (const [service, prefix] of Object.entries(CONTROL_TARGET_ENV)) {
    const list = (env[`${prefix}_ADDRS`] ?? env[`${prefix}_ADDR`] ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    const dns = env[`${prefix}_DNS`]?.trim();
    if (list.length > 0) {
      for (const a of list) hostPortOf(a, `${prefix}_ADDRS`);
      sources[service] = { kind: 'static', addresses: [...new Set(list)].sort() };
    } else if (dns) {
      const { host, port } = hostPortOf(dns, `${prefix}_DNS`);
      sources[service] = { kind: 'dns', host, port };
    } else {
      missing.push(service);
    }
  }
  const envName = env.PEAKET_ENV;
  if (missing.length > 0 && (envName === undefined || !CONTROL_TARGETS_OPTIONAL_ENVS.includes(envName))) {
    throw new Error(`제어 gRPC 받는 쪽 주소 설정이 없다(${missing.join(', ')}: ${missing.map((s) => `${CONTROL_TARGET_ENV[s]}_DNS`).join('·')}, ADR-0365 결정 3. local·ci만 없이 뜬다)`);
  }
  return { targets: new ConfiguredControlTargets(sources, resolveA), missing };
}
