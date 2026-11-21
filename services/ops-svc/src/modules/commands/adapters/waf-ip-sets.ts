// 명령 4가 쓰는 관제용 WAF IP 집합 둘(IPv4·IPv6)의 읽기·통째 바꾸기(ADR-0349 결정 9·10, docs/features/control-tower.md §5 'AWS WAF API' 행, docs/api/guidelines.md §8 'AWS WAF IP 집합 API' 행).
// 읽기는 GetIPSet(주소 목록과 잠금 토큰), 바꾸기는 UpdateIPSet(읽은 잠금 토큰과 고친 전체 목록). 잠금 토큰이 낡았으면 WAFOptimisticLockException이고
// 부르는 쪽(만료 차단 정리 작업)이 다시 읽어 한 번 더 한다. 실제 AWS는 부르지 않는 시험·local은 메모리 가짜(MemoryWafIpSets)를 쓴다.
// 환경 값(정리 작업과 ops-svc 정비 바퀴가 같은 함수로 읽는다):
//   PEAKET_WAF_IPSET_V4·PEAKET_WAF_IPSET_V6 = '<이름>|<ID>'(IP 집합 이름과 ID, 둘 다 있어야 한다)
//   PEAKET_WAF_SCOPE = REGIONAL | CLOUDFRONT(CLOUDFRONT면 리전은 us-east-1), 흉내 끝점 PEAKET_WAF_ENDPOINT(local·ci만)
// 시간 값은 연결 1초·요청 3초 [가정]이고 로그에는 오류 이름만 싣는다(메시지에 계정 번호·ARN이 들 수 있다).
import { randomUUID } from 'node:crypto';
import { GetIPSetCommand, UpdateIPSetCommand, WAFV2Client } from '@aws-sdk/client-wafv2';
import { WafLockConflict, type IpFamily, type IpSetSnapshot, type WafIpSets } from '../domain/block-expiry.js';

export { WafLockConflict, type WafIpSets } from '../domain/block-expiry.js';

export const WAF_IPSET_V4_ENV = 'PEAKET_WAF_IPSET_V4';
export const WAF_IPSET_V6_ENV = 'PEAKET_WAF_IPSET_V6';
export const WAF_SCOPE_ENV = 'PEAKET_WAF_SCOPE';
export const WAF_ENDPOINT_ENV = 'PEAKET_WAF_ENDPOINT';
/** 메모리 가짜·흉내 끝점을 허락하는 환경 */
export const WAF_OPEN_ENVS: readonly string[] = ['local', 'ci'];

const CONNECTION_TIMEOUT_MS = 1_000;
const REQUEST_TIMEOUT_MS = 3_000;

export interface WafIpSetRef {
  readonly name: string;
  readonly id: string;
}

export interface WafIpSetsConfig {
  readonly v4: WafIpSetRef;
  readonly v6: WafIpSetRef;
  readonly scope: 'REGIONAL' | 'CLOUDFRONT';
  readonly region: string;
  readonly endpoint?: string;
}

const refOf = (raw: string | undefined, env: string): WafIpSetRef | undefined => {
  const v = raw?.trim();
  if (!v) return undefined;
  const [name, id, ...rest] = v.split('|');
  if (!name || !id || rest.length > 0 || !/^[\w-]{1,128}$/.test(name) || !/^[\w-]{1,128}$/.test(id)) throw new Error(`${env}는 '<IP 집합 이름>|<ID>' 꼴이어야 한다`);
  return { name, id };
};

/**
 * 환경 값에서 IP 집합 설정을 읽는다. 둘 다 없으면 undefined(부르는 쪽이 환경마다 정한다: 작업은 local·ci 밖에서 시작 실패, ops-svc는 명령 4 만료 확인을 쉰다).
 * @throws Error 하나만 있음, 꼴이 틀림, 범위가 틀림, 흉내 끝점을 local·ci 밖에서 씀
 */
export function wafIpSetsConfigFromEnv(env: Record<string, string | undefined>, o: { envName: string }): WafIpSetsConfig | undefined {
  const v4 = refOf(env[WAF_IPSET_V4_ENV], WAF_IPSET_V4_ENV);
  const v6 = refOf(env[WAF_IPSET_V6_ENV], WAF_IPSET_V6_ENV);
  const endpoint = env[WAF_ENDPOINT_ENV]?.trim() || undefined;
  if (endpoint && !WAF_OPEN_ENVS.includes(o.envName)) throw new Error(`${WAF_ENDPOINT_ENV}는 ${WAF_OPEN_ENVS.join('·')}에서만 쓴다(지금 ${o.envName})`);
  if (!v4 && !v6) return undefined;
  if (!v4 || !v6) throw new Error(`${WAF_IPSET_V4_ENV}·${WAF_IPSET_V6_ENV}는 둘 다 있어야 한다(IP 집합은 주소 판 하나만 담는다)`);
  const scope = (env[WAF_SCOPE_ENV]?.trim() || 'REGIONAL').toUpperCase();
  if (scope !== 'REGIONAL' && scope !== 'CLOUDFRONT') throw new Error(`${WAF_SCOPE_ENV}는 REGIONAL 또는 CLOUDFRONT다`);
  const region = scope === 'CLOUDFRONT' ? 'us-east-1' : env.AWS_REGION?.trim() || 'ap-northeast-2';
  return { v4, v6, scope, region, ...(endpoint ? { endpoint } : {}) };
}

const errorName = (e: unknown): string => {
  const n = (e as { name?: unknown } | null)?.name;
  return typeof n === 'string' ? n : 'Error';
};

/** AWS WAFV2 IP 집합(GetIPSet·UpdateIPSet만 부른다) */
export class AwsWafIpSets implements WafIpSets {
  readonly #client: WAFV2Client;
  /** 바꿀 때 설명(Description)을 그대로 넘기려고 마지막 읽기 값을 둔다 */
  readonly #description = new Map<IpFamily, string | undefined>();

  constructor(
    private readonly config: WafIpSetsConfig,
    client?: WAFV2Client,
  ) {
    this.#client =
      client ??
      new WAFV2Client({
        region: config.region,
        ...(config.endpoint ? { endpoint: config.endpoint } : {}),
        maxAttempts: 2,
        requestHandler: { connectionTimeout: CONNECTION_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS, throwOnRequestTimeout: true },
      });
  }

  #ref(family: IpFamily): WafIpSetRef {
    return family === 4 ? this.config.v4 : this.config.v6;
  }

  async get(family: IpFamily): Promise<IpSetSnapshot> {
    const ref = this.#ref(family);
    const out = await this.#client.send(new GetIPSetCommand({ Name: ref.name, Id: ref.id, Scope: this.config.scope }));
    if (!out.IPSet || out.LockToken === undefined) throw new Error('waf-ipset-empty-response');
    const version = out.IPSet.IPAddressVersion;
    if ((family === 4 && version !== 'IPV4') || (family === 6 && version !== 'IPV6')) throw new Error('waf-ipset-family-mismatch');
    this.#description.set(family, out.IPSet.Description);
    return { addresses: [...(out.IPSet.Addresses ?? [])], lockToken: out.LockToken };
  }

  async read(family: IpFamily): Promise<readonly string[]> {
    return (await this.get(family)).addresses;
  }

  async replace(family: IpFamily, addresses: readonly string[], lockToken: string): Promise<void> {
    const ref = this.#ref(family);
    const description = this.#description.get(family);
    try {
      await this.#client.send(
        new UpdateIPSetCommand({ Name: ref.name, Id: ref.id, Scope: this.config.scope, Addresses: [...addresses], LockToken: lockToken, ...(description !== undefined ? { Description: description } : {}) }),
      );
    } catch (e) {
      if (errorName(e) === 'WAFOptimisticLockException') throw new WafLockConflict();
      throw e;
    }
  }
}

/** 시험·local용 IP 집합. 바꿀 때마다 잠금 토큰이 바뀌고, 낡은 토큰이면 WafLockConflict다. 끼어들기·실패를 시험이 넣는다 */
export class MemoryWafIpSets implements WafIpSets {
  readonly sets: Record<IpFamily, { addresses: string[]; lockToken: string }> = { 4: { addresses: [], lockToken: randomUUID() }, 6: { addresses: [], lockToken: randomUUID() } };
  /** 읽은 뒤 바꾸기 전에 부른다(시험의 끼어들기). 한 번 쓰면 지운다 */
  beforeReplace: ((family: IpFamily) => void) | undefined;
  /** 참이면 읽기가 던진다(WAF를 읽지 못함) */
  failReads = false;
  /** 바꾸기를 늘 충돌로 막는다 */
  alwaysConflict = false;
  readonly replaced: { family: IpFamily; addresses: string[] }[] = [];

  constructor(initial: Partial<Record<IpFamily, readonly string[]>> = {}) {
    if (initial[4]) this.sets[4].addresses = [...initial[4]];
    if (initial[6]) this.sets[6].addresses = [...initial[6]];
  }

  /** 집합을 바깥에서 바꾼다(다른 쪽의 쓰기, 잠금 토큰이 바뀐다) */
  put(family: IpFamily, addresses: readonly string[]): void {
    this.sets[family] = { addresses: [...addresses], lockToken: randomUUID() };
  }

  async get(family: IpFamily): Promise<IpSetSnapshot> {
    if (this.failReads) throw new Error('waf-unavailable');
    const s = this.sets[family];
    return { addresses: [...s.addresses], lockToken: s.lockToken };
  }

  async read(family: IpFamily): Promise<readonly string[]> {
    return (await this.get(family)).addresses;
  }

  async replace(family: IpFamily, addresses: readonly string[], lockToken: string): Promise<void> {
    const hook = this.beforeReplace;
    this.beforeReplace = undefined;
    hook?.(family);
    if (this.alwaysConflict || this.sets[family].lockToken !== lockToken) throw new WafLockConflict();
    this.put(family, addresses);
    this.replaced.push({ family, addresses: [...addresses] });
  }
}
