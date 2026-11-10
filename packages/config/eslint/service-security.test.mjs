// 서비스 보안 린트 시험(docs/verification.md V-T31 ③, docs/security/asvs/delivery.md 15.3.1·15.3.2, ADR-0259 결정 10·11, BUILD_ORDER BAS-010 ①).
// 실행: cd packages/config && node --test "eslint/*.test.mjs"
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint, Linter } from 'eslint';
import { OUTBOUND_HTTP_EXCEPTIONS, RESPONSE_SCHEMA_BASELINE, serviceSecurityConfigs } from './service-security.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const OUTBOUND = 'peaket-service/no-direct-outbound-http';
const SCHEMA = 'peaket-service/route-response-schema';
const linter = new Linter({ configType: 'flat', cwd: ROOT });
const FILE = 'services/demo-svc/src/modules/note/adapters/x.ts';

/** 그 코드를 서비스 파일 자리에서 린트해 오류(규칙 ID와 글)를 돌려준다 */
function errorsOf(code, { filename = FILE, configs = serviceSecurityConfigs(['services/*/src']) } = {}) {
  const out = linter.verify(code, configs, { filename: `${ROOT}${filename}` });
  assert.deepEqual(out.filter((m) => m.fatal), [], `해석 실패: ${code}`);
  return out.filter((m) => m.severity === 2);
}
const ids = (code, opts) => errorsOf(code, opts).map((m) => m.ruleId);

const OUTBOUND_BLOCKED = [
  // 전역 fetch(부르기·값으로 넘기기·전역 객체로 부르기)
  "export const f = (u: string) => fetch(u);",
  "export const f = (u: string) => globalThis.fetch(u);",
  "export const f = (u: string) => global.fetch(u);",
  'export const impl = fetch;',
  'export const bound = fetch.bind(globalThis);',
  // node:http(s)·http(s)의 요청 함수: 기본·이름공간 가져오기의 .request·.get, 이름 가져오기, 구조 분해
  "import https from 'node:https';\nexport const r = (u: string) => https.request(u);",
  "import https from 'node:https';\nexport const r = (u: string) => https.get(u);",
  "import * as http from 'node:http';\nexport const r = (u: string) => http.request(u);",
  "import * as https from 'https';\nexport const r = (u: string) => https.get(u, () => {});",
  "import { request } from 'node:https';\nexport const r = (u: string) => request(u);",
  "import { get as g } from 'http';\nexport const r = (u: string) => g(u);",
  "import { request } from 'https';\nexport const r = (u: string) => request(u);",
  "import https from 'node:https';\nconst { request } = https;\nexport const r = (u: string) => request(u);",
  "import http2 from 'node:http2';\nexport const c = (u: string) => http2.connect(u);",
  "export { request } from 'node:https';",
  "export * from 'node:http';",
  // 동적 가져오기·require
  "export const r = async (u: string) => (await import('node:https')).request(u);",
  "declare const require: (m: string) => any;\nexport const r = (u: string) => require('node:https').request(u);",
  // undici는 무엇이든 직접 쓰지 않는다
  "import { fetch as uf } from 'undici';\nexport const f = (u: string) => uf(u);",
  "import { Agent } from 'undici';\nexport const a = new Agent();",
  "import 'undici';",
  "export const u = async () => import('undici');",
];
const OUTBOUND_ALLOWED = [
  // 서버를 여는 쓰임과 형만 가져오기
  "import http from 'node:http';\nexport const s = http.createServer(() => {});",
  "import { createServer } from 'node:https';\nexport const s = createServer({}, () => {});",
  "import * as https from 'node:https';\nexport const s = (o: https.ServerOptions) => https.createServer(o);",
  "import type { IncomingMessage, RequestOptions } from 'node:http';\nexport type M = IncomingMessage | RequestOptions;",
  "import { type IncomingHttpHeaders, STATUS_CODES } from 'node:http';\nexport const t = (h: IncomingHttpHeaders) => STATUS_CODES[200] + String(h);",
  "import http2 from 'node:http2';\nexport const s = http2.createSecureServer({});",
  // 공용 외부 호출 클라이언트와, 주입받은 fetch(지역 이름)
  "import { createExternalHttpClient } from '@peaket/platform';\nexport const c = createExternalHttpClient({ provider: 'kopis', baseUrl: 'https://x.test', timeoutCapMs: 1000 });\nexport const r = () => c.request({ method: 'GET', path: '/a' });",
  'export function make(fetch: typeof globalThis.fetch) { return (u: string) => fetch(u); }',
  'export type F = typeof fetch;\nexport type P = Parameters<typeof fetch>[0];',
  'export interface O { readonly fetch?: typeof fetch }',
  "export const m = new Map<string, number>();\nexport const v = m.get('a');\nexport const q = { request: 1, get: 2, fetch: 3 };",
  'export class C { constructor(private readonly http: { get(u: string): void; request(u: string): void }) {} run() { this.http.get("/a"); this.http.request("/b"); } }',
];

test('V-T31 ③ [ASVS v5.0.0-15.3.2] 서비스 코드의 fetch·node:http(s) 직접 호출을 규칙이 막는다', () => {
  for (const code of OUTBOUND_BLOCKED) assert.ok(ids(code).includes(OUTBOUND), `막아야 한다: ${code}`);
  for (const code of OUTBOUND_ALLOWED) assert.deepEqual(ids(code), [], `막지 않아야 한다: ${code}`);
  // 글은 대신 쓸 공용 클라이언트를 가리킨다
  const [m] = errorsOf("import https from 'node:https';\nexport const r = (u: string) => https.request(u);");
  assert.match(m.message, /createExternalHttpClient/);
});

test('V-T31 ③ [ASVS v5.0.0-15.3.2] 외부 호출 예외는 적은 파일의 적은 쓰임만 풀고, 뿌리 설정이 서비스 코드에 건다', async () => {
  for (const e of OUTBOUND_HTTP_EXCEPTIONS) {
    assert.ok(existsSync(`${ROOT}${e.file}`), `예외 파일이 없다: ${e.file}`);
    assert.ok(e.reason.trim().length > 0 && e.allow.length > 0, e.file);
  }
  const pg = OUTBOUND_HTTP_EXCEPTIONS.find((e) => e.file.endsWith('pg-http.ts'));
  assert.ok(pg, '결제사 연결 묶음 예외');
  const allowedThere = "import { Agent } from 'undici';\nexport const f = (u: string) => fetch(u, { dispatcher: new Agent() } as RequestInit);";
  assert.deepEqual(ids(allowedThere, { filename: pg.file }), []);
  // 같은 파일이라도 적지 않은 쓰임(node:https 요청)은 막는다
  assert.ok(ids("import https from 'node:https';\nexport const r = (u: string) => https.request(u);", { filename: pg.file }).includes(OUTBOUND));
  assert.throws(() => serviceSecurityConfigs(['services/*/src'], { exceptions: [{ file: 'services/a/src/x.ts', allow: ['fetch'], reason: ' ' }] }), /까닭/);
  assert.throws(() => serviceSecurityConfigs(['services/*/src'], { exceptions: [{ file: 'services/a/src/x.ts', allow: ['net'], reason: 'x' }] }), /net/);

  const eslint = new ESLint({ cwd: ROOT });
  const at = async (path) => {
    const [r] = await eslint.lintText('export const f = (u: string) => fetch(u);\n', { filePath: `${ROOT}${path}` });
    return r.messages.filter((m) => m.ruleId === OUTBOUND).length;
  };
  assert.equal(await at('services/demo-svc/src/modules/note/adapters/http.ts'), 1);
  assert.equal(await at('services/demo-svc/src/main.ts'), 1);
  assert.equal(await at('packages/platform/template/src/modules/example/adapters/http.ts'), 1);
  // 시험 코드와 화면 코드는 이 규칙의 범위가 아니다
  assert.equal(await at('services/demo-svc/test/x.test.ts'), 0);
  assert.equal(await at('apps/web/src/x.ts'), 0);
});

const NEST = "import { Controller, Get, Post } from '@nestjs/common';\nimport { ContractRouteSchema } from '@peaket/platform';\nimport { z } from 'zod';\nconst Body = z.object({ a: z.string() });\n";
const CONTROLLER = 'services/demo-svc/src/modules/note/inbound/note.controller.ts';
const schemaErrors = (code, baseline = []) =>
  errorsOf(code, { filename: CONTROLLER, configs: serviceSecurityConfigs(['services/*/src'], { baseline }) }).filter((m) => m.ruleId === SCHEMA);

test('[ASVS v5.0.0-15.3.1] 응답 스키마 없는 새 라우트 처리기를 막고 기준선 처리기는 통과시킨다', () => {
  const blockedCases = [
    `${NEST}@Controller('n') export class NoteController { @Get(':id') get() { return { a: 'x' }; } }`,
    `${NEST}@Controller('n') export class NoteController { @Post() @ContractRouteSchema({ body: Body }) create() { return { a: 'x' }; } }`,
    `${NEST}@Controller('n') export class NoteController { @Post() @ContractRouteSchema({ body: Body, responses: {} }) create() { return {}; } }`,
    // 이름을 바꿔 가져오거나 이름공간으로 가져온 장식자도 라우트다
    `import { Controller, Delete as Del } from '@nestjs/common';\n@Controller('n') export class NoteController { @Del(':id') remove() {} }`,
    `import * as nest from '@nestjs/common';\n@nest.Controller('n') export class NoteController { @nest.Patch(':id') patch() {} @nest.All('x') all() {} }`,
    // 같은 이름이라도 @peaket/platform의 것이 아니면 표시가 아니다
    `import { Controller, Put } from '@nestjs/common';\nconst ContractRouteSchema = (_: unknown) => () => {};\n@Controller('n') export class NoteController { @Put() @ContractRouteSchema({ responses: { 200: 1 } }) put() {} }`,
    // 표시를 객체 글자 밖에서 만들면 responses를 확인할 수 없다
    `${NEST}const S = { body: Body };\n@Controller('n') export class NoteController { @Post() @ContractRouteSchema(S) create() {} }`,
  ];
  for (const code of blockedCases) assert.ok(schemaErrors(code).length > 0, `막아야 한다: ${code}`);
  assert.equal(schemaErrors(blockedCases[4]).length, 2, '처리기마다 하나씩');

  const allowedCases = [
    `${NEST}@Controller('n') export class NoteController { @Get(':id') @ContractRouteSchema({ responses: { 200: Body } }) get() { return { a: 'x' }; } }`,
    `${NEST}@Controller('n') export class NoteController { @ContractRouteSchema({ body: Body, responses: { 201: Body, 409: Body } }) @Post() create() { return { a: 'x' }; } }`,
    `${NEST}const RESPONSES = { 200: Body };\n@Controller('n') export class NoteController { @Get() @ContractRouteSchema({ responses: RESPONSES }) list() { return { a: 'x' }; } }`,
    `${NEST}const S = { responses: { 200: Body } };\n@Controller('n') export class NoteController { @Get() @ContractRouteSchema(S) list() { return { a: 'x' }; } }`,
    // 라우트가 아닌 메서드, 다른 꾸러미의 Get
    `${NEST}@Controller('n') export class NoteController { helper() { return 1; } }`,
    `import { Get } from './my-decorators';\nexport class Other { @Get() x() {} }`,
  ];
  for (const code of allowedCases) assert.deepEqual(schemaErrors(code), [], `막지 않아야 한다: ${code}`);

  // 기준선 줄(파일 경로#클래스.메서드)에 있는 처리기는 통과하고, 같은 파일의 새 처리기는 막는다
  const two = `${NEST}@Controller('n') export class NoteController { @Get(':id') get() {} @Post() create() {} }`;
  const errs = schemaErrors(two, [`${CONTROLLER}#NoteController.get`]);
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /NoteController\.create/);
  assert.match(errs[0].message, /@ContractRouteSchema\(\{ …, responses: \{ 200: /);
});

test('[ASVS v5.0.0-15.3.1] 기준선에 있는데 사라졌거나 이미 응답 스키마를 단 처리기는 기준선에서 지우라고 알린다', () => {
  const code = `${NEST}@Controller('n') export class NoteController { @Get(':id') @ContractRouteSchema({ responses: { 200: Body } }) get() {} }`;
  const errs = schemaErrors(code, [`${CONTROLLER}#NoteController.get`, `${CONTROLLER}#NoteController.gone`, 'services/other/src/x.ts#Other.keep']);
  assert.deepEqual(errs.map((m) => m.message.match(/NoteController\.\w+/)?.[0]).sort(), ['NoteController.get', 'NoteController.gone']);
  assert.ok(errs.every((m) => /기준선/.test(m.message)));
});

test('[ASVS v5.0.0-15.3.1] 기준선은 규칙을 합친 때의 처리기만 담고 형식과 파일이 맞다', () => {
  const raw = JSON.parse(readFileSync(new URL('./response-schema-baseline.json', import.meta.url), 'utf8'));
  assert.deepEqual(RESPONSE_SCHEMA_BASELINE, raw.handlers);
  assert.ok(RESPONSE_SCHEMA_BASELINE.length > 0);
  assert.equal(new Set(RESPONSE_SCHEMA_BASELINE).size, RESPONSE_SCHEMA_BASELINE.length, '겹치는 줄');
  assert.deepEqual([...RESPONSE_SCHEMA_BASELINE].sort(), RESPONSE_SCHEMA_BASELINE, '정렬');
  for (const line of RESPONSE_SCHEMA_BASELINE) {
    assert.match(line, /^(services\/[a-z0-9-]+\/src|packages\/platform\/template\/src)\/[\w./-]+\.ts#[\w$<>]+\.[\w$#]+$/, line);
    assert.ok(existsSync(`${ROOT}${line.split('#')[0]}`), `기준선 파일이 없다(지운 파일이면 그 줄을 지운다): ${line}`);
  }
  // 이 묶음이 새로 만드는 추가 검증 처리기는 기준선에 넣지 않는다(새 처리기는 응답 스키마를 단다)
  assert.deepEqual(RESPONSE_SCHEMA_BASELINE.filter((l) => l.startsWith('services/queue-svc/src/modules/verification/')), []);
});

// ---------- 리뷰 R7·R8(2026-11-10) 재현 시험 ----------
const BASELINE_MAX = 85;
test('[ASVS v5.0.0-15.3.1] 응답 스키마 기준선은 85줄보다 늘지 않는다(줄이기만 한다)', () => {
  assert.ok(RESPONSE_SCHEMA_BASELINE.length <= BASELINE_MAX, `기준선 ${RESPONSE_SCHEMA_BASELINE.length}줄 > 상한 ${BASELINE_MAX}줄: 새 처리기는 기준선에 넣지 않고 응답 스키마를 단다`);
});

test('[ASVS v5.0.0-15.3.1] 2xx 응답이 없거나 따라갈 수 없는 이름이면 응답 스키마 표시로 치지 않는다', () => {
  const blockedCases = [
    `${NEST}@Controller('n') export class NoteController { @Get() @ContractRouteSchema({ responses: { 404: Body } }) get() {} }`,
    `${NEST}@Controller('n') export class NoteController { @Get() @ContractRouteSchema({ responses: { 400: Body, 503: Body } }) get() {} }`,
    `${NEST}import { RESPONSES } from './responses';\n@Controller('n') export class NoteController { @Get() @ContractRouteSchema({ responses: RESPONSES }) get() {} }`,
    `${NEST}declare function makeResponses(): Record<number, typeof Body>;\n@Controller('n') export class NoteController { @Get() @ContractRouteSchema({ responses: makeResponses() }) get() {} }`,
    `${NEST}import { SCHEMA } from './schemas';\n@Controller('n') export class NoteController { @Get() @ContractRouteSchema(SCHEMA) get() {} }`,
    `${NEST}const OK = 200;\n@Controller('n') export class NoteController { @Get() @ContractRouteSchema({ responses: { [OK]: Body } }) get() {} }`,
    `${NEST}const BASE = { 200: Body };\n@Controller('n') export class NoteController { @Get() @ContractRouteSchema({ responses: { ...BASE } }) get() {} }`,
    `${NEST}@Controller('n') export class NoteController { @Get() @ContractRouteSchema({ responses: { 200: undefined } }) get() {} }`,
    `${NEST}const R = { 404: Body };\n@Controller('n') export class NoteController { @Get() @ContractRouteSchema({ responses: R }) get() {} }`,
  ];
  for (const code of blockedCases) assert.ok(schemaErrors(code).length > 0, `막아야 한다: ${code}`);
  const allowedCases = [
    `${NEST}@Controller('n') export class NoteController { @Post() @ContractRouteSchema({ responses: { '201': Body, 409: Body } }) create() {} }`,
    `${NEST}@Controller('n') export class NoteController { @Get() @ContractRouteSchema({ responses: { 200: Body, 404: Body } }) get() {} }`,
  ];
  for (const code of allowedCases) assert.deepEqual(schemaErrors(code), [], `막지 않아야 한다: ${code}`);
});

test('[ASVS v5.0.0-15.3.1] RequestMapping·Sse·Search와 @nestjs/common 하위 경로에서 가져온 장식자도 라우트 처리기로 본다', () => {
  const cases = [
    "import { Controller, RequestMapping, RequestMethod } from '@nestjs/common';\n@Controller('n') export class C { @RequestMapping({ path: 'x', method: RequestMethod.GET }) get() {} }",
    "import { Controller, Sse } from '@nestjs/common';\n@Controller('n') export class C { @Sse('events') stream() {} }",
    "import { Controller, Search } from '@nestjs/common';\n@Controller('n') export class C { @Search() find() {} }",
    "import { Get } from '@nestjs/common/decorators';\nexport class C { @Get() x() {} }",
    "import { Post } from '@nestjs/common/decorators/http/request-mapping.decorator';\nexport class C { @Post() y() {} }",
    "import * as d from '@nestjs/common/decorators';\nexport class C { @d.Put() z() {} }",
  ];
  for (const code of cases) assert.equal(schemaErrors(code).length, 1, `라우트로 봐야 한다: ${code}`);
});

test('V-T31 ③ [ASVS v5.0.0-15.3.2] ClientRequest 생성·전역 객체에서 fetch 떼어 내기도 막는다', () => {
  const blockedCases = [
    "import * as http from 'node:http';\nexport const r = (u: string) => new http.ClientRequest(u);",
    "import http from 'node:http';\nexport const r = (u: string) => new http.ClientRequest(u);",
    "import { ClientRequest } from 'node:http';\nexport const r = (u: string) => new ClientRequest(u);",
    "import { ClientRequest as CR } from 'http';\nexport const r = (u: string) => new CR(u);",
    'const { fetch } = globalThis;\nexport const f = (u: string) => fetch(u);',
    'const { fetch: f } = window;\nexport const g = (u: string) => f(u);',
    'const { fetch } = self;\nexport const f = (u: string) => fetch(u);',
    "let f: typeof globalThis.fetch;\n({ fetch: f } = globalThis);\nexport const g = (u: string) => f(u);",
    'export const f = (u: string) => (globalThis as any).fetch(u);',
  ];
  for (const code of blockedCases) assert.ok(ids(code).includes(OUTBOUND), `막아야 한다: ${code}`);
  // 지역 객체에서 같은 이름을 떼어 내는 것은 막지 않는다
  assert.deepEqual(ids('export function f(o: { fetch: typeof globalThis.fetch }) { const { fetch } = o; return fetch; }'), []);
});

// ---------- 다시 보기 S2(2026-11-10) 재현 시험 ----------
// 이 규칙을 develop에 합친 때(b13b096d 위, 2026-11-10) 응답 스키마 표시가 없던 처리기 85개(파일 → 클래스.메서드). 묶음을 시작한 320e213a의 79개에 그사이 다른 갈래가 더한 core-svc 처리기 6개를 더했다. 기준선은 이 목록의 부분집합이어야 한다:
// 줄 수만 보면 줄을 지운 뒤 다른 처리기 줄을 더해도 지나간다(리뷰 S2)
const BASELINE_320E213A = Object.entries({
  'packages/platform/template/src/modules/example/inbound/note.controller.ts': ['NoteController.create', 'NoteController.get'],
  'services/core-svc/src/modules/catalog/inbound/event-summary.controller.ts': ['EventSummaryController.get'],
  'services/core-svc/src/modules/catalog/inbound/partner-media.controller.ts': ['PartnerMediaController.importSeatmap', 'PartnerMediaController.remove', 'PartnerMediaController.update', 'PartnerMediaController.upload'],
  'services/core-svc/src/modules/catalog/inbound/partner-seatmap.controller.ts': ['PartnerSeatmapController.load', 'PartnerSeatmapController.save'],
  'services/core-svc/src/modules/catalog/inbound/partner-directory.controller.ts': ['PartnerDirectoryController.listArtists', 'PartnerDirectoryController.listPlaces'],
  'services/core-svc/src/modules/catalog/inbound/partner-production.controller.ts': ['PartnerProductionController.create', 'PartnerProductionController.createEvent'],
  'services/core-svc/src/modules/catalog/inbound/wish.controller.ts': ['WishController.delete', 'WishController.put'],
  'services/identity-svc/src/modules/admin/inbound/admin-login.controller.ts': ['AdminLoginController.ops', 'AdminLoginController.partner'],
  'services/identity-svc/src/modules/admin/inbound/admin-passkey.controller.ts': ['AdminPasskeyController.opsBegin', 'AdminPasskeyController.opsCreate', 'AdminPasskeyController.opsList', 'AdminPasskeyController.opsReauth', 'AdminPasskeyController.opsRemove', 'AdminPasskeyController.partnerBegin', 'AdminPasskeyController.partnerCreate', 'AdminPasskeyController.partnerList', 'AdminPasskeyController.partnerReauth', 'AdminPasskeyController.partnerRemove'],
  'services/identity-svc/src/modules/admin/inbound/admin-password-change.controller.ts': ['AdminPasswordChangeController.ops', 'AdminPasswordChangeController.partner'],
  'services/identity-svc/src/modules/admin/inbound/admin-token.controller.ts': ['AdminTokenController.opsLogout', 'AdminTokenController.opsRefresh', 'AdminTokenController.partnerLogout', 'AdminTokenController.partnerRefresh'],
  'services/identity-svc/src/modules/admin/inbound/admin-unlock.controller.ts': ['AdminUnlockController.opsResend', 'AdminUnlockController.opsUnlock', 'AdminUnlockController.partnerResend', 'AdminUnlockController.partnerUnlock'],
  'services/identity-svc/src/modules/admin/inbound/partner-team-accounts.controller.ts': ['PartnerTeamAccountsController.list'],
  'services/identity-svc/src/modules/session/inbound/account-summary.controller.ts': ['AccountSummaryController.me', 'AccountSummaryController.nicknameCheck', 'AccountSummaryController.signupCancellation', 'AccountSummaryController.signupCompletion'],
  'services/identity-svc/src/modules/session/inbound/account.controller.ts': ['AccountController.remove', 'ProvidersController.providers', 'ProvidersController.remove'],
  'services/identity-svc/src/modules/session/inbound/merge.controller.ts': ['MergeProposalsController.confirmation', 'MergeProposalsController.get'],
  'services/identity-svc/src/modules/session/inbound/sessions.controller.ts': ['SessionsController.remove', 'SessionsController.sessions'],
  'services/identity-svc/src/modules/session/inbound/token.controller.ts': ['TokenController.jwks', 'TokenController.refreshTokens'],
  'services/identity-svc/src/modules/verification/inbound/verification.controller.ts': ['VerificationController.confirm', 'VerificationController.result', 'VerificationController.start'],
  'services/payment-svc/src/modules/payment/inbound/payment-webhook.controller.ts': ['PaymentWebhookController.portone', 'PaymentWebhookController.toss'],
  'services/purchase-svc/src/modules/booking/inbound/orders.controller.ts': ['OrdersController.accept'],
  'services/purchase-svc/src/modules/inventory/inbound/hold-lifecycle.controller.ts': ['HoldLifecycleController.release'],
  'services/purchase-svc/src/modules/inventory/inbound/purchase-session.controller.ts': ['PurchaseSessionController.leave'],
  'services/purchase-svc/src/modules/inventory/inbound/snapshot.controller.ts': ['SnapshotController.get'],
  'services/queue-svc/src/modules/admission/inbound/admission.controller.ts': ['AdmissionController.admit'],
  'services/queue-svc/src/modules/entry/inbound/queue.controller.ts': ['QueueController.enter', 'QueueController.leaveEntry', 'QueueController.leaveLobby', 'QueueController.lobby', 'QueueController.preverify'],
  'services/queue-svc/src/modules/state/inbound/shuffle-proof.controller.ts': ['ShuffleProofController.batchResult', 'ShuffleProofController.proof', 'ShuffleProofController.shuffleResult'],
  'services/queue-svc/src/modules/state/inbound/state-files.controller.ts': ['StateFilesController.segment'],
  'services/trust-svc/src/modules/scoring/inbound/honeypot.controller.ts': ['HoneypotController.hit'],
  'services/v0-monolith/src/modules/booking/inbound/order.controller.ts': ['OrderController.create', 'OrderController.pay', 'OrderController.view'],
  'services/v0-monolith/src/modules/inventory/inbound/seat-page.controller.ts': ['SeatPageController.asset', 'SeatPageController.page'],
  'services/v0-monolith/src/modules/inventory/inbound/seat.controller.ts': ['HoldController.extend', 'HoldController.release', 'SeatController.hold', 'SeatListController.seats'],
  'services/v0-monolith/src/modules/queue/inbound/queue.controller.ts': ['QueueController.admit', 'QueueController.cancel', 'QueueController.enter', 'QueueController.status'],
  'services/v0-monolith/src/modules/ticket/inbound/scan.controller.ts': ['ScanController.scan'],
}).flatMap(([file, methods]) => methods.map((m) => `${file}#${m}`));
test('[ASVS v5.0.0-15.3.1] 응답 스키마 기준선은 규칙을 합친 때 목록(85줄)의 부분집합이다(지운 줄을 다른 처리기 줄로 다시 채우지 못한다)', () => {
  assert.equal(BASELINE_320E213A.length, 85);
  const frozen = new Set(BASELINE_320E213A);
  assert.deepEqual(RESPONSE_SCHEMA_BASELINE.filter((l) => !frozen.has(l)), [], '합친 때 목록에 없던 줄: 새 처리기는 기준선에 넣지 않고 응답 스키마를 단다');
});

test('[ASVS v5.0.0-15.3.1] 성공 응답이 z.any()·z.unknown()처럼 아무 값이나 받는 스키마면 응답 스키마 표시로 치지 않는다', () => {
  const C = (decl, responses) => `${NEST}${decl}\n@Controller('n') export class NoteController { @Get() @ContractRouteSchema({ responses: ${responses} }) get() {} }`;
  const blockedCases = [
    C('', '{ 200: z.any() }'),
    C('', '{ 200: z.unknown() }'),
    C('', '{ 200: z.any().optional() }'),
    C('', '{ 200: z.unknown().nullable().describe("x") }'),
    C("import * as zod from 'zod';", '{ 200: zod.any() }'),
    C("import { z as v } from 'zod';", '{ 200: v.unknown() }'),
    C("import { any } from 'zod';", '{ 200: any() }'),
    C("import zd from 'zod/v4';", '{ 200: zd.any() }'),
    C('const Anything = z.any();', '{ 200: Anything }'),
    // 성공 응답이 둘이면 둘 다 진짜 스키마여야 한다
    C('', '{ 200: Body, 201: z.any() }'),
  ];
  for (const code of blockedCases) assert.ok(schemaErrors(code).length > 0, `막아야 한다: ${code.split('\n').at(-1)}`);
  const allowedCases = [
    C('', '{ 200: z.object({ a: z.string() }) }'),
    C("import { NoteBody } from './schemas';", '{ 200: NoteBody, 404: z.any() }'),
    // zod가 아닌 꾸러미의 any는 막지 않는다
    C("import { any } from './my-schemas';", '{ 200: any() }'),
  ];
  for (const code of allowedCases) assert.deepEqual(schemaErrors(code), [], `막지 않아야 한다: ${code.split('\n').at(-1)}`);
});

test('V-T31 ③ [ASVS v5.0.0-15.3.2] node:http(s) 모듈을 다시 내보내는 꼴도 막는다', () => {
  const blockedCases = [
    "export { default as h } from 'node:http';",
    "export { default } from 'https';",
    "export { request } from 'node:https';",
    "export { get as httpGet } from 'node:http';",
    "export * as h from 'node:http';",
    "import http from 'node:http';\nexport { http };",
    "import * as https from 'node:https';\nexport { https as client };",
    "import https from 'node:https';\nexport default https;",
  ];
  for (const code of blockedCases) assert.ok(ids(code).includes(OUTBOUND), `막아야 한다: ${code}`);
  // 형만 다시 내보내기와 서버 쪽 이름은 막지 않는다
  for (const code of ["export type { IncomingMessage } from 'node:http';", "export { createServer, STATUS_CODES } from 'node:http';"]) assert.deepEqual(ids(code), [], `막지 않아야 한다: ${code}`);
});
