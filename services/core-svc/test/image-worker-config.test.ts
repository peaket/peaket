// F-10-2 D-T35 ①②③ 배포·코드 모양 정적 시험(계획 docs/review/plans/F-10-2.md §3·§7, docs/devops.md D-T35,
// docs/security/asvs/catalog-review.md 1.2.5·1.3.6·1.4.1·5.2.1·15.2.5, ADR-0130, ADR-0257 결정 5).
// 실제 배포·Terraform·AWS 계정은 동결 범위 밖이다. 여기서는 동결 무대 값과 코드가 정한 모양을 지키는지만 본다.
// 시험 먼저: 구현 전에는 배포 값·image-worker 코드가 없어 실패한다(ADR-0372).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SERVICE = join(REPO, 'services', 'core-svc');
const IMAGE_WORKER = join(SERVICE, 'src', 'image-worker');
const read = (p: string): string => {
  try {
    return readFileSync(join(REPO, p), 'utf8');
  } catch {
    return '';
  }
};
const filesUnder = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true, withFileTypes: true }) as unknown as { isFile(): boolean; name: string; parentPath: string }[])
    .filter((d) => d.isFile() && d.name.endsWith('.ts'))
    .map((d) => join(d.parentPath, d.name));
};
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('F-10-2 image-worker 배포·코드 모양', () => {
  test('D-T35 ①②③ image-worker 배포 값은 DB·Kafka·Redis Secret이 없고, 비루트·읽기 전용 루트·S3 하나만 나가며, IRSA는 격리 읽기·준비 쓰기만 준다 [ASVS v5.0.0-15.2.5] [ASVS v5.0.0-5.2.1]', () => {
    const values = read('deploy/workloads/image-worker/values.yaml');
    expect(values, 'deploy/workloads/image-worker/values.yaml이 없다').not.toBe('');
    expect(values).toMatch(/name:\s*image-worker/);
    expect(values).toMatch(/dist\/image-worker\/main\.js/);
    // ① DB·Kafka·Redis Secret을 넣지 않는다(AWS S3 자격 증명은 동결 무대에서 Secret으로 받는다)
    expect(values).not.toMatch(/secretEnvFrom/);
    expect(values).not.toMatch(/^\s*(?:PEAKET_)?(?:DATABASE_URL|PARTNER_DATABASE_URL|OPS_DATABASE_URL|SEARCH_DATABASE_URL|MAINTENANCE_DATABASE_URL|KAFKA_[A-Z_]*|REDIS_[A-Z_]*):/m);
    // 필수 환경 값(계획 §5): 없으면 뜨지 않는 배포 값을 막는다
    for (const key of ['PEAKET_GRPC_PORT', 'PEAKET_IMAGE_S3_ENDPOINT', 'PEAKET_IMAGE_S3_REGION', 'PEAKET_IMAGE_BUCKET', 'PEAKET_IMAGE_CONCURRENCY', 'PEAKET_IMAGE_TIMEOUT_MS']) {
      expect(values, `${key}가 없다`).toMatch(new RegExp(`^\\s+${key}:\\s*["']?\\S+`, 'm'));
    }
    // ② 비루트·읽기 전용 루트·권한 상승 금지·capability 제거·seccomp는 공용 차트가 건다. 값이 덮어쓰지 않는다
    const helpers = read('deploy/charts/peaket-service/templates/_helpers.tpl');
    for (const line of ['readOnlyRootFilesystem: true', 'runAsNonRoot: true', 'allowPrivilegeEscalation: false', 'seccompProfile: { type: RuntimeDefault }', 'capabilities: { drop: ["ALL"] }']) {
      expect(helpers, `공용 차트에 ${line}가 없다`).toContain(line);
    }
    expect(values).not.toMatch(/^\s*securityContext:/m);
    expect(values).not.toMatch(/readOnlyRootFilesystem:\s*false|runAsNonRoot:\s*false|allowPrivilegeEscalation:\s*true/);
    // IRSA 서비스 어카운트 주석과 역할 ARN
    expect(values).toMatch(/serviceAccountAnnotations:/);
    expect(values).toMatch(/eks\.amazonaws\.com\/role-arn:\s*arn:aws:iam::<ACCOUNT_ID>:role\/peaket-image-worker/);
    expect(helpers, '공용 차트가 serviceAccountAnnotations를 싣지 않는다').toContain('serviceAccountAnnotations');
    // ③ 나가는 통신은 S3 VPC 엔드포인트 하나(10.20.0.0/16 [가정], 443)다. 공인 HTTPS·다른 namespace는 열지 않는다
    expect(values).toMatch(/publicHttps:\s*false/);
    expect(values, 'egress 값이 없다').toContain('egress:');
    const egress = values.slice(values.indexOf('egress:'));
    expect((egress.match(/cidrs:/g) ?? []).length).toBe(1);
    expect(egress).toMatch(/cidrs:\s*\[\s*10\.20\.0\.0\/16\s*\]/);
    expect(egress).not.toMatch(/0\.0\.0\.0\/0|::\/0|namespaces:|publicHttps:\s*true/);
    expect(egress).toMatch(/ports:\s*\[\s*443\s*\]/);
    // 동시 처리 1, 메모리·CPU 상한
    expect(values).toMatch(/PEAKET_IMAGE_CONCURRENCY:\s*["']1["']/);
    expect(values).toMatch(/limits:\s*\{[^}]*memory:/);
    // IAM: 격리 버킷 읽기와 준비 위치 쓰기만. s3:*·Resource:"*"·다른 action은 없다
    const raw = read('deploy/workloads/image-worker/irsa-policy.json');
    expect(raw, 'deploy/workloads/image-worker/irsa-policy.json이 없다').not.toBe('');
    const policy = JSON.parse(raw) as { Statement: { Effect: string; Action: string | string[]; Resource: string | string[] }[] };
    const rows = policy.Statement.flatMap((s) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      const resources = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
      return actions.flatMap((action) => resources.map((resource) => ({ effect: s.Effect, action, resource })));
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.effect).toBe('Allow');
      expect(['s3:GetObject', 's3:GetObjectTagging', 's3:PutObject', 's3:AbortMultipartUpload']).toContain(r.action);
      expect(r.resource, '버킷 ARN이 아니다').toMatch(/^arn:aws:s3:::[a-z0-9.-]+\/(?:quarantine|staging)\/\*$/);
      if (r.action === 's3:GetObject' || r.action === 's3:GetObjectTagging') expect(r.resource).toMatch(/\/quarantine\/\*$/);
      else expect(r.resource).toMatch(/\/staging\/\*$/);
    }
    expect(rows.some((r) => r.action === 's3:GetObject')).toBe(true);
    expect(rows.some((r) => r.action === 's3:GetObjectTagging')).toBe(true);
    expect(rows.some((r) => r.action === 's3:PutObject')).toBe(true);
  });

  test('F-10-2 image-worker 코드는 셸·외부 URL·DB 클라이언트를 쓰지 않고 sharp는 이 작업 안에서만 쓴다 [ASVS v5.0.0-1.2.5] [ASVS v5.0.0-1.3.6] [ASVS v5.0.0-1.4.1]', () => {
    const imageFiles = filesUnder(IMAGE_WORKER);
    expect(imageFiles.length, 'src/image-worker 코드가 없다').toBeGreaterThan(0);
    for (const file of imageFiles) {
      const text = stripComments(readFileSync(file, 'utf8'));
      const name = relative(REPO, file);
      expect(text, `${name}가 셸을 부른다`).not.toMatch(/from\s+['"]node:child_process['"]/);
      expect(text, `${name}가 셸을 부른다`).not.toMatch(/\bexec(?:File|Sync)?\s*\(|\bspawn(?:Sync)?\s*\(/);
      expect(text, `${name}가 HTTP를 직접 부른다`).not.toMatch(/from\s+['"](?:node:http|node:https|undici|axios|got|node-fetch|superagent|request)['"]/);
      expect(text, `${name}가 HTTP를 직접 부른다`).not.toMatch(/\b(?:axios|got|fetch|https?\.request)\s*\(/);
      expect(text, `${name}가 외부 URL을 부른다`).not.toMatch(/https?:\/\//);
      expect(text, `${name}가 DB·Kafka·Redis 클라이언트를 쓴다`).not.toMatch(/from\s+['"](?:pg|drizzle-orm|kafkajs|redis|ioredis)['"]/);
    }
    // sharp는 image-worker 밖에서 쓰지 않는다(1.4.1)
    const all = filesUnder(join(SERVICE, 'src'));
    const sharpUsers = all.filter((f) => /from\s+['"]sharp['"]/.test(readFileSync(f, 'utf8'))).map((f) => relative(REPO, f));
    expect(sharpUsers.length, 'sharp를 쓰는 곳이 없다').toBeGreaterThan(0);
    for (const f of sharpUsers) expect(f.replaceAll('\\', '/')).toMatch(/^services\/core-svc\/src\/image-worker\//);
    // 화소 상한은 디코딩 전에 보고, 메타데이터는 지운다(회전은 화소에 반영)
    const process = readFileSync(join(IMAGE_WORKER, 'process.ts'), 'utf8');
    expect(process).toMatch(/limitInputPixels/);
    expect(process).toMatch(/\.rotate\(/);
    expect(process).not.toMatch(/withMetadata\s*\(|withExif\s*\(|keepExif\s*\(/);
    // 자격 증명 확인과 시작 기록
    const main = readFileSync(join(IMAGE_WORKER, 'main.ts'), 'utf8');
    expect(main).toMatch(/forbiddenCredentialNames|forbiddenCredential/);
    expect(main).toMatch(/image_worker_started/);
    // 공개 파생본 S3 머리와 키 접두사(3.2.1·4.1.1·5.4.1, 5.3.2)
    const store = read('services/core-svc/src/modules/catalog/adapters/image-store-s3.ts');
    expect(store, 'S3 저장소 어댑터가 없다').not.toBe('');
    expect(store).toMatch(/CacheControl/);
    expect(store).toMatch(/public, max-age=31536000, immutable/);
    expect(store).toMatch(/private, no-store/);
    expect(store).toMatch(/ContentDisposition/);
    expect(store).toMatch(/inline; filename=/);
    expect(store).toMatch(/ContentType/);
    expect(store).toMatch(/IfNoneMatch|If-None-Match/);
    for (const kind of ['production', 'banner', 'review']) expect(store, `S3 어댑터에 ${kind} 접두사가 없다`).toContain(kind);
    const localStore = read('services/core-svc/src/modules/catalog/adapters/image-store.ts');
    for (const kind of ['production', 'banner', 'review']) expect(localStore, `로컬 저장소에 ${kind} 접두사가 없다`).toContain(kind);
    // 계약 설명도 구현처럼 원본 폭 이하만 만든다고 적는다(여덟 개 고정 금지, IR-06)
    const openapi = read('docs/api/openapi.yaml');
    expect(openapi).toMatch(/원본 폭 이하|원본보다 넓은 폭은 만들지 않는다/);
    expect(openapi).not.toMatch(/320·640·960·1,?280 \[가정\]의 여덟 개/);
  });
});
