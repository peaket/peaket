// 감사 체인 키·앵커 저장소의 환경 값(ADR-0341 결정 2·5, BAT-355 계획 8.5). main.ts를 고치지 않고 모듈 조립(팩토리)과 검증 잡이 같은 함수를 쓴다.
// 키: PEAKET_AUDIT_CHAIN_KMS_KEY_ID(mrk-), 넘길 리전 PEAKET_KMS_FAILOVER_REGION, 흉내 끝점 PEAKET_KMS_ENDPOINT·PEAKET_KMS_FAILOVER_ENDPOINT(local·ci만, identity-svc와 같은 이름·뜻).
//   local·ci·demo에서 키 ID가 없으면 PEAKET_AUDIT_CHAIN_LOCAL_KEY(base64, 32바이트 이상), 그것도 없으면 시작 때 만든 임시 키와 경고 한 줄.
//   그 밖의 환경에서 키 ID나 넘길 리전이 없으면 시작하지 않는다(던짐).
// 앵커: PEAKET_AUDIT_ANCHOR_BUCKET, 흉내 끝점 PEAKET_AUDIT_ANCHOR_S3_ENDPOINT(local·ci만). local·ci·demo는 버킷이 없으면 폴더 PEAKET_AUDIT_ANCHOR_DIR,
//   그것도 없으면 메모리와 경고 한 줄. 그 밖의 환경은 버킷이 없으면 시작하지 않는다.
// 공개 앵커 게시 작업(ADR-0348 결정 5·6, local·ci만 열린다): 공개 게시 버킷 PEAKET_AUDIT_PUBLIC_BUCKET(local·ci는 폴더 PEAKET_AUDIT_PUBLIC_DIR나 메모리)과
//   감사 앵커 버킷 PEAKET_AUDIT_ANCHOR_BUCKET(local·ci는 PEAKET_AUDIT_ANCHOR_DIR나 메모리), 흉내 S3 끝점은 두 버킷 모두 PEAKET_AUDIT_ANCHOR_S3_ENDPOINT(local·ci만).
//   캘린더 PEAKET_OTS_CALENDAR_URLS(쉼표로 나눈 https 주소, local·ci는 http 흉내 서버도 받고 비면 메모리 가짜 캘린더). 그 밖의 환경에서 하나라도 없으면 작업이 시작하지 않는다.
import { kmsAuditMacClient, KmsAuditMacKey, type AuditMacClient } from './adapters/kms-audit-mac-key.js';
import { ephemeralAuditMacKey, LocalAuditMacKey, AUDIT_LOCAL_KEY_MIN_BYTES, type AuditMacKey } from './mac.js';
import { DirMacAnchorStore, MemoryMacAnchorStore, S3MacAnchorStore, type MacAnchorStore } from './mac-anchor.js';
import { HttpOpenTimestampsCalendar, MemoryOpenTimestampsCalendar, type OpenTimestampsCalendar } from './ots.js';
import { DirAuditPublicStore, MemoryAuditPublicStore, S3AuditPublicStore, type AuditPublicStore } from './public-store.js';

export const AUDIT_CHAIN_KMS_KEY_ID_ENV = 'PEAKET_AUDIT_CHAIN_KMS_KEY_ID';
export const AUDIT_CHAIN_LOCAL_KEY_ENV = 'PEAKET_AUDIT_CHAIN_LOCAL_KEY';
export const AUDIT_ANCHOR_BUCKET_ENV = 'PEAKET_AUDIT_ANCHOR_BUCKET';
export const AUDIT_ANCHOR_S3_ENDPOINT_ENV = 'PEAKET_AUDIT_ANCHOR_S3_ENDPOINT';
export const AUDIT_ANCHOR_DIR_ENV = 'PEAKET_AUDIT_ANCHOR_DIR';
const KMS_ENDPOINT_ENV = 'PEAKET_KMS_ENDPOINT';
const KMS_FAILOVER_REGION_ENV = 'PEAKET_KMS_FAILOVER_REGION';
const KMS_FAILOVER_ENDPOINT_ENV = 'PEAKET_KMS_FAILOVER_ENDPOINT';

/** 메모리 키·폴더 앵커를 허락하는 환경 */
export const AUDIT_OPEN_ENVS: readonly string[] = ['local', 'ci', 'demo'];
/** 흉내 끝점을 허락하는 환경 */
const MOCK_ENVS: readonly string[] = ['local', 'ci'];

type Env = Record<string, string | undefined>;

/** 환경 이름. PEAKET_ENV가 없으면 플랫폼 설정이 local·ci로 본 경우(시험 조립)만 ci, 그 밖은 prod(닫힌 쪽)다 */
export function auditEnvName(env: Env, platformLocal = false): string {
  const v = env.PEAKET_ENV?.trim();
  if (v) return v;
  return platformLocal ? 'ci' : 'prod';
}

export interface AuditMacKeyFromEnv {
  readonly key: AuditMacKey;
  readonly warning?: string;
}

/**
 * 감사 체인 키를 고른다.
 * @throws Error 키 ID가 다중 리전 키가 아님, 흉내 끝점을 local·ci 밖에서 씀, local·ci·demo가 아닌데 키 ID·넘길 리전이 없음, 메모리 키가 짧음
 */
export function auditMacKeyFromEnv(
  env: Env,
  o: { envName: string; onFailover?: (op: 'GenerateMac' | 'VerifyMac', errorName: string) => void; client?: (c: { region: string; endpoint?: string }) => AuditMacClient },
): AuditMacKeyFromEnv {
  const open = AUDIT_OPEN_ENVS.includes(o.envName);
  const mock = MOCK_ENVS.includes(o.envName);
  const keyId = env[AUDIT_CHAIN_KMS_KEY_ID_ENV]?.trim();
  const endpoint = env[KMS_ENDPOINT_ENV]?.trim() || undefined;
  const failoverRegion = env[KMS_FAILOVER_REGION_ENV]?.trim() || undefined;
  const failoverEndpoint = env[KMS_FAILOVER_ENDPOINT_ENV]?.trim() || undefined;
  const make = o.client ?? kmsAuditMacClient;
  if (keyId) {
    if (!keyId.includes('mrk-')) throw new Error(`${AUDIT_CHAIN_KMS_KEY_ID_ENV}는 다중 리전 키(mrk-)여야 한다(복제 키로 넘기려면)`);
    if ((endpoint || failoverEndpoint) && !mock) throw new Error(`${KMS_ENDPOINT_ENV}·${KMS_FAILOVER_ENDPOINT_ENV}는 ${MOCK_ENVS.join('·')}에서만 쓴다(지금 ${o.envName})`);
    if (!failoverRegion && !open) throw new Error(`${AUDIT_CHAIN_KMS_KEY_ID_ENV}를 쓰려면 ${KMS_FAILOVER_REGION_ENV}(복제 키 리전)가 있어야 한다(ADR-0102·0341)`);
    if (!failoverRegion && failoverEndpoint) throw new Error(`${KMS_FAILOVER_ENDPOINT_ENV}를 쓰려면 ${KMS_FAILOVER_REGION_ENV}도 있어야 한다`);
    if (failoverRegion && endpoint && !failoverEndpoint) throw new Error(`${KMS_ENDPOINT_ENV}(흉내 서버)를 쓰면 ${KMS_FAILOVER_ENDPOINT_ENV}도 있어야 한다(넘길 때 실제 AWS로 나가지 않게)`);
    const region = env.AWS_REGION?.trim() || 'ap-northeast-2';
    if (failoverRegion === region) throw new Error(`${KMS_FAILOVER_REGION_ENV}는 서비스 리전과 달라야 한다`);
    const primary = make({ region, ...(endpoint ? { endpoint } : {}) });
    const failover = failoverRegion ? { client: make({ region: failoverRegion, ...(failoverEndpoint ? { endpoint: failoverEndpoint } : {}) }), region: failoverRegion } : undefined;
    return { key: new KmsAuditMacKey(primary, keyId, failover, o.onFailover) };
  }
  if (!open) throw new Error(`${AUDIT_CHAIN_KMS_KEY_ID_ENV}가 없다(감사 체인 키. ${AUDIT_OPEN_ENVS.join('·')}만 메모리 키를 쓴다)`);
  const local = env[AUDIT_CHAIN_LOCAL_KEY_ENV]?.trim();
  if (local) {
    const bytes = Buffer.from(local, 'base64');
    if (bytes.length < AUDIT_LOCAL_KEY_MIN_BYTES) throw new Error(`${AUDIT_CHAIN_LOCAL_KEY_ENV}는 base64로 ${AUDIT_LOCAL_KEY_MIN_BYTES}바이트 이상이다`);
    return { key: new LocalAuditMacKey(bytes, 'local') };
  }
  return { key: ephemeralAuditMacKey(), warning: `${AUDIT_CHAIN_KMS_KEY_ID_ENV}·${AUDIT_CHAIN_LOCAL_KEY_ENV}가 없어 시작 때 만든 임시 키로 감사 체인 mac을 채운다(재시작하면 앞의 mac을 검증하지 못한다)` };
}

export interface MacAnchorStoreFromEnv {
  readonly store: MacAnchorStore;
  readonly warning?: string;
}

/**
 * 감사 앵커 저장소를 고른다.
 * @throws Error 흉내 끝점을 local·ci 밖에서 씀, local·ci·demo가 아닌데 버킷이 없음
 */
export function macAnchorStoreFromEnv(env: Env, o: { envName: string }): MacAnchorStoreFromEnv {
  const bucket = env[AUDIT_ANCHOR_BUCKET_ENV]?.trim();
  const endpoint = env[AUDIT_ANCHOR_S3_ENDPOINT_ENV]?.trim() || undefined;
  if (endpoint && !MOCK_ENVS.includes(o.envName)) throw new Error(`${AUDIT_ANCHOR_S3_ENDPOINT_ENV}는 ${MOCK_ENVS.join('·')}에서만 쓴다(지금 ${o.envName})`);
  if (bucket) return { store: new S3MacAnchorStore({ bucket, ...(endpoint ? { endpoint } : {}) }) };
  if (!AUDIT_OPEN_ENVS.includes(o.envName)) throw new Error(`${AUDIT_ANCHOR_BUCKET_ENV}가 없다(감사 앵커 버킷, S3 Object Lock. ${AUDIT_OPEN_ENVS.join('·')}만 폴더·메모리에 쓴다)`);
  const dir = env[AUDIT_ANCHOR_DIR_ENV]?.trim();
  if (dir) return { store: new DirMacAnchorStore(dir) };
  return { store: new MemoryMacAnchorStore(), warning: `${AUDIT_ANCHOR_BUCKET_ENV}·${AUDIT_ANCHOR_DIR_ENV}가 없어 감사 앵커를 메모리에만 쓴다(검증 잡은 DB 앵커 행을 본다)` };
}

/** 공개 앵커 게시 작업이 폴더·메모리·흉내 서버를 허락하는 환경(ADR-0348 결정 4~6: local·ci만) */
export const AUDIT_ANCHOR_JOB_OPEN_ENVS: readonly string[] = ['local', 'ci'];
export const AUDIT_PUBLIC_BUCKET_ENV = 'PEAKET_AUDIT_PUBLIC_BUCKET';
export const AUDIT_PUBLIC_DIR_ENV = 'PEAKET_AUDIT_PUBLIC_DIR';
export const OTS_CALENDAR_URLS_ENV = 'PEAKET_OTS_CALENDAR_URLS';

export interface AuditPublicTargetsFromEnv {
  /** [공개 게시 자리, 감사 앵커 자리] */
  readonly targets: readonly AuditPublicStore[];
  readonly warnings: readonly string[];
}

/**
 * 게시 자리 둘을 고른다(공개 게시 버킷·감사 앵커 버킷).
 * @throws Error local·ci 밖에서 버킷이 없음, 흉내 끝점을 local·ci 밖에서 씀, 두 버킷 이름이 같음
 */
export function auditPublicTargetsFromEnv(env: Env, o: { envName: string }): AuditPublicTargetsFromEnv {
  const open = AUDIT_ANCHOR_JOB_OPEN_ENVS.includes(o.envName);
  const endpoint = env[AUDIT_ANCHOR_S3_ENDPOINT_ENV]?.trim() || undefined;
  if (endpoint && !open) throw new Error(`${AUDIT_ANCHOR_S3_ENDPOINT_ENV}는 ${AUDIT_ANCHOR_JOB_OPEN_ENVS.join('·')}에서만 쓴다(지금 ${o.envName})`);
  const warnings: string[] = [];
  const pick = (name: 'public' | 'anchor', bucketEnv: string, dirEnv: string): AuditPublicStore => {
    const bucket = env[bucketEnv]?.trim();
    if (bucket) return new S3AuditPublicStore(name, { bucket, ...(endpoint ? { endpoint } : {}) });
    if (!open) throw new Error(`${bucketEnv}가 없다(감사 공개 앵커 게시 자리. ${AUDIT_ANCHOR_JOB_OPEN_ENVS.join('·')}만 폴더·메모리에 쓴다)`);
    const dir = env[dirEnv]?.trim();
    if (dir) return new DirAuditPublicStore(name, dir);
    warnings.push(`${bucketEnv}·${dirEnv}가 없어 ${name} 게시 파일을 메모리에만 쓴다(프로세스가 끝나면 사라진다)`);
    return new MemoryAuditPublicStore(name);
  };
  const publicBucket = env[AUDIT_PUBLIC_BUCKET_ENV]?.trim();
  if (publicBucket && publicBucket === env[AUDIT_ANCHOR_BUCKET_ENV]?.trim()) throw new Error(`${AUDIT_PUBLIC_BUCKET_ENV}와 ${AUDIT_ANCHOR_BUCKET_ENV}는 다른 버킷이어야 한다(ADR-0348 결정 6)`);
  return { targets: [pick('public', AUDIT_PUBLIC_BUCKET_ENV, AUDIT_PUBLIC_DIR_ENV), pick('anchor', AUDIT_ANCHOR_BUCKET_ENV, AUDIT_ANCHOR_DIR_ENV)], warnings };
}

export interface OtsCalendarsFromEnv {
  readonly calendars: readonly OpenTimestampsCalendar[];
  readonly warning?: string;
}

/**
 * 공개 타임스탬프 캘린더 목록을 고른다.
 * @throws Error local·ci 밖에서 목록이 비었음, https가 아닌 주소(local·ci는 http도), 쿼리·조각·사용자 정보가 있는 주소
 */
export function otsCalendarsFromEnv(env: Env, o: { envName: string; fetch?: typeof fetch }): OtsCalendarsFromEnv {
  const open = AUDIT_ANCHOR_JOB_OPEN_ENVS.includes(o.envName);
  const raw = (env[OTS_CALENDAR_URLS_ENV] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const urls = [...new Set(raw)];
  if (urls.length === 0) {
    if (!open) throw new Error(`${OTS_CALENDAR_URLS_ENV}가 없다(공개 타임스탬프 캘린더. ${AUDIT_ANCHOR_JOB_OPEN_ENVS.join('·')}만 가짜 캘린더를 쓴다)`);
    return { calendars: [new MemoryOpenTimestampsCalendar()], warning: `${OTS_CALENDAR_URLS_ENV}가 없어 메모리 가짜 캘린더로 대기 증명을 만든다(완료 증명은 생기지 않는다)` };
  }
  const calendars = urls.map((u) => {
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      throw new Error(`${OTS_CALENDAR_URLS_ENV}의 값이 주소가 아니다`);
    }
    if (url.search || url.hash || url.username || url.password) throw new Error(`${OTS_CALENDAR_URLS_ENV}의 주소에는 쿼리·조각·사용자 정보를 두지 않는다`);
    if (url.protocol !== 'https:' && !(open && url.protocol === 'http:')) throw new Error(`${OTS_CALENDAR_URLS_ENV}는 https 주소다(${AUDIT_ANCHOR_JOB_OPEN_ENVS.join('·')}만 http 흉내 서버)`);
    return new HttpOpenTimestampsCalendar(u.replace(/\/+$/, ''), o.fetch ? { fetch: o.fetch } : {});
  });
  return { calendars };
}
