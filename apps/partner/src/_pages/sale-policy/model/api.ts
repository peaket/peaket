// SCR-024 판매 정책 화면의 API 잇기(openapi get/putPartnerSalePolicy, 판매 자격 명단 세 경로, ADR-0261).
// 브라우저에서만 부르고, 파트너 API 클라이언트를 늦게 싣는다(에디터와 같은 꼴).
export interface PolicyResponse {
  rules: unknown[];
  version: number;
  pending: boolean;
}
export interface EligibilityList {
  key: string;
  name: string;
  memberCount: number;
  lockedAt: string | null;
  destroyDueAt: string;
  uploadedAt: string;
  version: number;
}
export interface UploadResult {
  listKey: string;
  version: number;
  applied: number;
  invalidLineCount: number;
  invalidLines: number[];
  unknownLineCount: number;
  unknownLines: number[];
  fileSha256: string;
}

interface Deps {
  client: { send<T>(op: unknown, o: { params?: Record<string, string>; body?: unknown; headers?: Record<string, string>; ifMatch?: string; timeoutMs?: number }): Promise<{ data: T; status: number; headers: { get(k: string): string | null } }> };
  ops: Record<string, unknown>;
}

let deps: Promise<Deps> | null = null;
function live(): Promise<Deps> {
  deps ??= import('@/shared/api').then(
    (m) => ({ client: m.partnerApi() as unknown as Deps['client'], ops: m.OPERATIONS as unknown as Record<string, unknown> }),
    (e: unknown) => {
      deps = null;
      throw e;
    },
  );
  return deps;
}

export async function readPolicy(productionId: string): Promise<PolicyResponse> {
  const { client, ops } = await live();
  const r = await client.send<PolicyResponse>(ops.getPartnerSalePolicy, { params: { productionId } });
  return r.data;
}

export async function savePolicy(productionId: string, version: number, rules: unknown[]): Promise<{ version: number; pending: boolean }> {
  const { client, ops } = await live();
  const r = await client.send<{ version: number; pending: boolean }>(ops.putPartnerSalePolicy, { params: { productionId }, body: { rules }, ifMatch: `"${version}"`, timeoutMs: 20_000 });
  return r.data;
}

export async function listEligibility(productionId: string): Promise<EligibilityList[]> {
  const { client, ops } = await live();
  const r = await client.send<{ items: EligibilityList[] }>(ops.listPartnerSaleEligibilityLists, { params: { productionId } });
  return r.data.items;
}

export async function uploadEligibility(productionId: string, key: string, name: string, file: File): Promise<UploadResult> {
  const { client, ops } = await live();
  const fd = new FormData();
  fd.append('file', file);
  fd.append('key', key);
  fd.append('name', name);
  const r = await client.send<UploadResult>(ops.createPartnerSaleEligibilityList, { params: { productionId }, body: fd, headers: { 'X-Requested-With': 'peaket-partner' }, timeoutMs: 20_000 });
  return r.data;
}

export async function deleteEligibility(productionId: string, key: string): Promise<void> {
  const { client, ops } = await live();
  await client.send<unknown>(ops.deletePartnerSaleEligibilityList, { params: { productionId, listKey: key }, headers: { 'X-Requested-With': 'peaket-partner' } });
}
