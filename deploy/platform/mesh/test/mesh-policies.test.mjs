// 메시 포트별 허용 정책의 정적 시험(D-T36 ①~⑦ 정적, BUILD_ORDER HOT-420, 묶음 BAT-061 계획 6의 MS-01~19, ADR-0285).
// 생성 파일 둘(deploy/platform/mesh/policies.yaml·meshless-networkpolicies.yaml)과 손으로 쓴 메시 바탕(namespaces·peer-authentication·istiod-values·cacerts)을
// 읽어, 정본에서 이 시험이 스스로 만든 기대값과 견준다. 원천(port-allow.yaml)과 생성기(tools/ci/mesh-policies.mjs)에서는 값을 가져오지 않는다(원천은 시험의 대상이다).
// 정본: docs/architecture.md §5 '포트별 허용 표'(:741-748)·§3.2 'ADR-0171·0172가 더한 gRPC 호출'(:290), docs/api/proto/README.md §2 '부르는 쪽 확인'(:39)·
// §3 '호출 목록'(:65-122)·'아직 계약하지 않은 통신', docs/features/payment.md:720(TicketService/VoidTickets는 purchase-svc), ADR-0285 결정 1~12,
// docs/devops.md §5.2 '네임스페이스 지도'·§14 D-T36, docs/streaming.md §2.2(inv-ingest는 trust), docs/infra.md §9 '메시 포트별 허용 정책의 첫 구현'
// (게이트웨이 프록시 서비스 계정 이름 규칙), docs/security/secrets-and-keys.md '서비스 메시 중간 CA'.
// 판정은 글 모양이 아니라 '정책이 실제로 받는 것'을 흉내 내어 본다(바깥 경계): Istio ALLOW 규칙의 빈 from·to는 '모두', 규칙 없는 ALLOW는 '아무것도 받지 않음',
// NetworkPolicy의 빈 from·ports는 '모두', 한 출처 칸 안의 namespaceSelector·podSelector는 둘 다 맞아야 하고 podSelector만이면 같은 네임스페이스만이다.
// 허용·거부는 짝으로 본다: 정본 부르는 쪽은 받고, 목록 밖의 신원(게이트웨이 다섯, 표에 없는 파드, 라벨만 같고 네임스페이스가 다른 파드, 릴레이 파드)은 하나씩 거부.
// 생성 파일이 없거나 비면 모든 시험이 실패한다(빈 결과가 통과로 새지 않게).
// 실행(저장소 뿌리): node --test "deploy/platform/mesh/test/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const MESH = resolve(HERE, '..');
const REPO = resolve(MESH, '..', '..', '..');
const rel = (p) => relative(REPO, p).split('\\').join('/');

const POLICIES = join(MESH, 'policies.yaml');
const MESHLESS = join(MESH, 'meshless-networkpolicies.yaml');
const NAMESPACES = join(MESH, 'namespaces.yaml');
const PEER_AUTH = join(MESH, 'peer-authentication.yaml');
const ISTIOD_VALUES = join(MESH, 'istiod-values.yaml');
const CACERTS = join(MESH, 'cacerts.yaml');

// ===================== 정본 값 =====================

const GW_NS = 'envoy-gateway-system';
const GATEWAYS = ['gw-fan', 'gw-ops', 'gw-partner', 'gw-queue', 'gw-scanner'];
/** docs/devops.md §5.2 '네임스페이스 지도'(inv-ingest는 docs/streaming.md §2.2, core-notify-sender는 core의 notify 워커, Prometheus는 observability) */
const NAMESPACE_OF = {
  'admission-ctrl': 'queue',
  'queue-svc': 'queue',
  'purchase-svc': 'purchase',
  'payment-svc': 'purchase',
  'ticket-svc': 'ticket',
  'trust-svc': 'trust',
  'inv-ingest': 'trust',
  'core-svc': 'core',
  'identity-svc': 'core',
  'ops-svc': 'core',
  'image-worker': 'core',
  'seatmap-worker': 'core',
  'core-notify-sender': 'core',
  web: 'web',
  partner: 'web',
  prometheus: 'observability',
  'ops-breakglass': 'ops-breakglass',
};
/** 이 묶음의 워크로드(docs/architecture.md:743 업무 gRPC 아홉 + :744 게이트웨이 뒤의 서비스 + :745 제어 넷, 계획 4.1의 1) */
const WORKLOADS = ['admission-ctrl', 'core-svc', 'identity-svc', 'image-worker', 'ops-svc', 'partner', 'payment-svc', 'purchase-svc', 'queue-svc', 'seatmap-worker', 'ticket-svc', 'trust-svc', 'web'];
/** 업무 gRPC를 받는 아홉(docs/architecture.md:743) */
const GRPC_RECEIVERS = ['core-svc', 'identity-svc', 'image-worker', 'payment-svc', 'purchase-svc', 'queue-svc', 'seatmap-worker', 'ticket-svc', 'trust-svc'];
/** 제어 gRPC를 받는 넷(docs/architecture.md:745) */
const CONTROL_RECEIVERS = ['admission-ctrl', 'payment-svc', 'purchase-svc', 'queue-svc'];
/** 게이트웨이 뒤의 서비스(라우트 backendRefs가 가리키는 것, docs/architecture.md:744). trust-svc는 저장소에 라우트가 없는 gw-fan 허니팟 경로(ADR-0285 결정 9 끝) */
const REST_RECEIVERS = ['core-svc', 'identity-svc', 'ops-svc', 'partner', 'payment-svc', 'purchase-svc', 'queue-svc', 'ticket-svc', 'trust-svc', 'web'];
/** 지표 포트(docs/architecture.md:746 '모든 서비스와 작업자'). 화면 앱 서버(web·partner)는 관리 포트를 열지 않아 없어도 된다(계획 '구현 메모' 5). 있으면 Prometheus만 */
const METRICS_RECEIVERS = WORKLOADS.filter((w) => w !== 'web' && w !== 'partner');
const OPTIONAL_METRICS = ['web', 'partner'];
/** ADR-0285 결정 6: REST 8080(화면 앱 서버는 라우트의 포트 web 3000·partner 3001), 지표 9464, 업무 gRPC 50051(ticket-svc 50052), 제어 50061 */
const REST_PORT = (w) => ({ web: 3000, partner: 3001 })[w] ?? 8080;
const GRPC_PORT = (w) => (w === 'ticket-svc' ? 50052 : 50051);
const CONTROL_PORT = 50061;
const METRICS_PORT = 9464;
/** 제어 gRPC 포트의 부르는 쪽(docs/architecture.md:745, docs/api/proto/README.md:39) */
const CONTROL_CALLERS = ['ops-svc', 'ops-breakglass'];
/** 관리 경로를 처리하는 여덟 서비스(docs/architecture.md:290, D-T36 ⑦) */
const ADMIN_EIGHT = ['core-svc', 'identity-svc', 'ticket-svc', 'payment-svc', 'purchase-svc', 'queue-svc', 'trust-svc', 'ops-svc'];
/** ADR-0285 결정 9: REST 포트의 내부 HTTP 부르는 쪽 16쌍(2026-11-22 보충 포함)과 ADR-0288 결정 8의 purchase-svc → queue-svc(입장 토큰 공개키 묶음, BAT-057) 한 쌍, ADR-0353의 identity-svc → core-svc 한 쌍 [부르는 쪽, 받는 쪽] */
const INTERNAL_HTTP = [
  ['core-svc', 'identity-svc'],
  ['core-svc', 'purchase-svc'],
  // ADR-0353: identity-svc가 파트너 현장 스태프 초대의 회차 소유·유효 시간 확인에 core-svc 판매 설정 사본을 읽는다
  ['identity-svc', 'core-svc'],
  ['ops-svc', 'core-svc'],
  ['ops-svc', 'identity-svc'],
  ['ops-svc', 'payment-svc'],
  ['ops-svc', 'purchase-svc'],
  ['ops-svc', 'queue-svc'],
  ['payment-svc', 'core-svc'],
  ['payment-svc', 'identity-svc'],
  // ADR-0345·BAT-625: payment-svc가 지급 묶음 승인 ID를 ops-svc 지급 승인 기록 GET /internal/v1/payout-approvals/{approvalId}과 대조한다(W12-mesh RV-01)
  ['payment-svc', 'ops-svc'],
  ['purchase-svc', 'core-svc'],
  ['purchase-svc', 'ops-svc'],
  // ADR-0285 결정 9 보충(2026-11-22, W12-mesh): purchase-svc가 payment-svc 결제사 서킷 상태 GET /internal/v1/circuits를 읽는다(docs/features/transfer-refund.md §5 '서킷 연결', docs/api/guidelines.md §8.1)
  ['purchase-svc', 'payment-svc'],
  // ADR-0288 결정 8: purchase-svc가 queue-svc 앱 포트의 GET /internal/jwks/admission.json을 5분마다 읽는다(docs/features/seat-hold.md §2 '입장 토큰 공개키 묶음 주기 읽기')
  ['purchase-svc', 'queue-svc'],
  ['ticket-svc', 'core-svc'],
  ['ticket-svc', 'ops-svc'],
  ['web', 'identity-svc'],
];
/**
 * 업무 gRPC 부르는 쪽(받는 워크로드 → proto 서비스 → 부르는 쪽, 메서드마다 다르면 { 메서드: 부르는 쪽 }).
 * docs/api/proto/README.md:39 '부르는 쪽 확인', §3 '호출 목록'(:65-122) 첫 칸, docs/architecture.md:743·:290, docs/features/payment.md:720.
 * 배상 송금(CompensationTransferService)은 메서드 단위다: RequestCompensationTransfer는 purchase-svc만 부르고 GetCompensationTransfer는 부르는 쪽이 없다
 * (ADR-0317 결정 1, docs/api/proto/README.md §3 '호출 목록' purchase-svc → payment-svc 행 :75, docs/features/transfer-refund.md §5 '배상 계좌 입력').
 */
const GRPC = {
  'core-svc': {
    'peaket.core.v1.AccountMergeCheckService': ['identity-svc'],
    'peaket.core.v1.BookingRestrictionViewService': ['ops-svc'],
    'peaket.core.v1.CatalogAdminService': ['ops-svc'],
    'peaket.core.v1.FraudAppealViewService': ['ops-svc'],
    'peaket.core.v1.ReviewModerationService': ['ops-svc'],
    'peaket.core.v1.SaleReviewService': ['ops-svc'],
    'peaket.core.v1.SupportCaseService': ['ops-svc'],
  },
  'identity-svc': {
    'peaket.identity.v1.AccountHoldService': ['ops-svc'],
    'peaket.identity.v1.AdminAccountService': ['ops-svc'],
    'peaket.identity.v1.AdminAuthzService': [...ADMIN_EIGHT, 'admission-ctrl'],
    'peaket.identity.v1.AdminDesignationService': ['ops-svc'],
    'peaket.identity.v1.AdminSessionService': ['ops-svc'],
    'peaket.identity.v1.ContactRefService': ['purchase-svc'],
    'peaket.identity.v1.IdentityService': ['purchase-svc'],
    'peaket.identity.v1.InvestigationRefService': ['inv-ingest'],
    'peaket.identity.v1.MemberCodeService': ['core-svc'],
    'peaket.identity.v1.RecipientQueryService': ['core-notify-sender'],
    'peaket.identity.v1.RestrictedCiHoldService': ['ops-svc'],
    'peaket.identity.v1.ReverificationCheckService': ['queue-svc'],
    'peaket.identity.v1.ScannerSessionCheckService': ['ticket-svc'],
    'peaket.identity.v1.ScannerSessionQueryService': ['ops-svc'],
    'peaket.identity.v1.SessionService': ['web'],
  },
  'image-worker': { 'peaket.image.v1.ImageService': ['core-svc'] },
  'payment-svc': {
    'peaket.payment.v1.CompensationTransferService': { RequestCompensationTransfer: ['purchase-svc'], GetCompensationTransfer: [] },
    'peaket.payment.v1.PaymentService': {
      PrepareCheckout: ['purchase-svc', 'core-svc'],
      ConfirmPayment: ['purchase-svc', 'core-svc'],
      BatchGetPayments: ['purchase-svc'],
      GetPayment: ['purchase-svc'],
      CancelPayment: ['purchase-svc', 'core-svc'],
      GetNewPaymentPause: ['purchase-svc'],
      RegisterPayoutSeller: ['core-svc'],
      ApprovePayoutBatch: ['ops-svc'],
      // 명령 12 하위 결제사 사전 판정: ops-svc만 부른다(docs/api/proto/README.md §3 'ops-svc → payment-svc CheckEventPgAssignment', ADR-0349 결정 3)
      CheckEventPgAssignment: ['ops-svc'],
      // 명령 6 대체 결제사 전환의 갈 곳 묻기: ops-svc만 부른다(docs/api/proto/README.md §3 'ops-svc → payment-svc ResolvePgSwitch', ADR-0366 결정 5)
      ResolvePgSwitch: ['ops-svc'],
    },
  },
  'purchase-svc': {
    'peaket.purchase.v1.AccountMergeCheckService': ['identity-svc'],
    'peaket.purchase.v1.BookingRestrictionService': ['ops-svc'],
    'peaket.purchase.v1.EventRefundService': ['ops-svc'],
    'peaket.purchase.v1.FraudCancellationService': ['ops-svc'],
    'peaket.purchase.v1.PriorityPurchaseService': ['ops-svc'],
    // 탈퇴 참여자: identity-svc만 부른다(ADR-0284 결정 1, docs/features/identity.md §8 '참여자 호출', docs/api/proto/README.md §3)
    'peaket.purchase.v1.WithdrawalParticipantService': ['identity-svc'],
  },
  'queue-svc': {
    'peaket.queue.v1.BookingRestrictionService': ['ops-svc'],
    'peaket.queue.v1.PriorityGrantService': ['ops-svc'],
    'peaket.queue.v1.QueueService': ['trust-svc'],
    'peaket.queue.v1.VerificationAppealService': ['ops-svc'],
  },
  'seatmap-worker': { 'peaket.seatmap.v1.SeatmapImportService': ['core-svc'] },
  'ticket-svc': {
    'peaket.ticket.v1.AccountMergeCheckService': ['identity-svc'],
    'peaket.ticket.v1.ScannerDeviceLookupService': ['identity-svc'],
    'peaket.ticket.v1.ScannerDeviceService': ['ops-svc'],
    'peaket.ticket.v1.TicketReclaimService': ['ops-svc'],
    'peaket.ticket.v1.TicketService': {
      IssueTickets: ['purchase-svc'],
      BlockTicketIssuance: ['purchase-svc'],
      VoidTickets: ['purchase-svc'],
      CancelTickets: ['purchase-svc'],
      OperatorCancelTickets: ['purchase-svc'],
      EventCancelTickets: ['purchase-svc'],
      GetEntryRecords: ['purchase-svc'],
      CheckReviewEligibility: ['core-svc'],
      ListHeldTickets: ['core-svc'],
      ListTickets: ['web'],
    },
    'peaket.ticket.v1.TransferLockService': ['ops-svc'],
  },
  'trust-svc': {
    'peaket.trust.v1.TrustEvidenceService': ['ops-svc'],
    'peaket.trust.v1.TrustLabelService': ['ops-svc'],
    'peaket.trust.v1.TrustService': ['queue-svc', 'identity-svc'],
  },
};
/** 제어 계약(업무 gRPC 웨이포인트에 두지 않는다, ADR-0102) */
const CONTROL_SERVICE = 'peaket.control.v1.ControlReceiver';
/** proto 패키지 peaket.<x>.v1의 x → 받는 워크로드(ADR-0285 결정 1) */
const PACKAGE_RECEIVER = { core: 'core-svc', identity: 'identity-svc', payment: 'payment-svc', purchase: 'purchase-svc', queue: 'queue-svc', ticket: 'ticket-svc', trust: 'trust-svc', image: 'image-worker', seatmap: 'seatmap-worker' };
/** ADR-0285 결정 10: 앰비언트 등록 네임스페이스 */
const AMBIENT_NAMESPACES = ['queue', 'purchase', 'ticket', 'trust', 'core', 'web', 'data', 'observability', 'ops-breakglass', GW_NS];
/** docs/security/secrets-and-keys.md '서비스 메시 중간 CA', ADR-0285 결정 12 */
const CACERTS_KEYS = ['ca-cert.pem', 'ca-key.pem', 'root-cert.pem', 'cert-chain.pem'];
const GENERATED_BY_LABEL = 'peaket.io/generated-by';
const WORKLOAD_LABEL = 'peaket.io/workload';
const NAME_LABEL = 'kubernetes.io/metadata.name';
const GW_NAME_LABEL = 'gateway.envoyproxy.io/owning-gateway-name';
const GW_NS_LABEL = 'gateway.envoyproxy.io/owning-gateway-namespace';

/**
 * docs/infra.md §9 '메시 포트별 허용 정책의 첫 구현': Envoy Gateway v1.10 프록시의 서비스 계정 이름
 * envoy-<게이트웨이 네임스페이스>-<게이트웨이 이름>-<"<네임스페이스>/<이름>"의 SHA-256 16진 앞 8자>
 */
const gatewayServiceAccount = (gw, ns = GW_NS) => `envoy-${ns}-${gw}-${createHash('sha256').update(`${ns}/${gw}`).digest('hex').slice(0, 8)}`;
/** 공용 차트의 서비스 파드 라벨(ADR-0285 결정 7) */
const serviceLabels = (n) => ({ 'app.kubernetes.io/name': n, 'app.kubernetes.io/component': 'service' });
const gatewayLabels = (g) => ({ [GW_NAME_LABEL]: g, [GW_NS_LABEL]: GW_NS });

/** 부르는 쪽 신원(ADR-0285 결정 7): 운영 주체와 메시 없는 실행의 네임스페이스·파드 라벨 */
const IDENTITY = {};
for (const [n, ns] of Object.entries(NAMESPACE_OF)) {
  if (n === 'prometheus') IDENTITY[n] = { principal: 'cluster.local/ns/observability/sa/prometheus', namespace: ns, podLabels: { 'app.kubernetes.io/name': 'prometheus' } };
  // 비상 런북 Job은 네임스페이스만 본다(Job 파드의 라벨은 무엇이든 받는다). 흉내 낼 때는 Job 컨트롤러가 다는 라벨 하나를 둔다
  else if (n === 'ops-breakglass') IDENTITY[n] = { principal: 'cluster.local/ns/ops-breakglass/sa/ops-breakglass', namespace: ns, podLabels: { 'batch.kubernetes.io/job-name': 'runbook-test' } };
  else IDENTITY[n] = { principal: `cluster.local/ns/${ns}/sa/${n}`, namespace: ns, podLabels: serviceLabels(n) };
}
for (const g of GATEWAYS) IDENTITY[g] = { principal: `cluster.local/ns/${GW_NS}/sa/${gatewayServiceAccount(g)}`, namespace: GW_NS, podLabels: gatewayLabels(g) };
const waypointPrincipal = (w) => `cluster.local/ns/${NAMESPACE_OF[w]}/sa/${w}-waypoint`;
const principalOf = (n) => IDENTITY[n].principal;
const nameOfPrincipal = new Map(Object.entries(IDENTITY).map(([n, v]) => [v.principal, n]));
const sorted = (xs) => [...new Set(xs)].sort();
const show = (xs) => JSON.stringify(sorted(xs));

/** 목록 밖 신원(거부를 보는 사례): 표에 없는 파드, 라벨 없는 파드, 릴레이 파드, 라벨은 같고 네임스페이스가 다른 파드, 게이트웨이 라벨을 단 다른 네임스페이스 파드 */
const OUTSIDERS = (() => {
  const out = [];
  const spaces = ['core', 'purchase', 'queue', 'ticket', 'trust', 'web', 'data', 'observability', GW_NS, 'default', 'otel', 'platform'];
  for (const ns of spaces) {
    out.push({ who: `표에 없는 파드(${ns})`, namespace: ns, podLabels: serviceLabels('mesh-test-stranger') });
    out.push({ who: `라벨 없는 파드(${ns})`, namespace: ns, podLabels: {} });
  }
  // 워크로드가 아닌 부르는 쪽(core-notify-sender·inv-ingest)도 같은 이름 라벨의 릴레이·작업 파드가 있을 수 있다(검증 V09)
  for (const n of ['admission-ctrl', 'core-svc', 'identity-svc', 'ops-svc', 'payment-svc', 'purchase-svc', 'queue-svc', 'ticket-svc', 'trust-svc', 'web', 'core-notify-sender', 'inv-ingest']) {
    const ns = NAMESPACE_OF[n];
    out.push({ who: `${n} 릴레이 파드`, namespace: ns, podLabels: { 'app.kubernetes.io/name': n, 'app.kubernetes.io/component': 'outbox-relay' } });
    out.push({ who: `${n} 이름 라벨만`, namespace: ns, podLabels: { 'app.kubernetes.io/name': n } });
    for (const other of ['default', ns === 'core' ? 'purchase' : 'core']) out.push({ who: `${n} 라벨을 단 ${other} 파드`, namespace: other, podLabels: serviceLabels(n) });
  }
  for (const g of GATEWAYS) {
    for (const other of ['core', 'default']) out.push({ who: `${g} 라벨을 단 ${other} 파드`, namespace: other, podLabels: gatewayLabels(g) });
    out.push({ who: `${g} 이름 라벨만(${GW_NS})`, namespace: GW_NS, podLabels: { [GW_NAME_LABEL]: g } });
  }
  out.push({ who: 'prometheus 라벨을 단 core 파드', namespace: 'core', podLabels: { 'app.kubernetes.io/name': 'prometheus' } });
  out.push({ who: 'Envoy Gateway 컨트롤러 파드', namespace: GW_NS, podLabels: { 'control-plane': 'envoy-gateway', 'app.kubernetes.io/name': 'gateway-helm' } });
  return out;
})();

// ===================== 읽기 =====================

const cache = new Map();
/** YAML 객체들(여러 문서). 파일이 없거나 비면 실패 */
function objectsOf(file) {
  if (cache.has(file)) return cache.get(file);
  assert.ok(existsSync(file), `${rel(file)}가 없다(이 시험이 볼 생성 파일·매니페스트)`);
  const out = [];
  for (const d of parseAllDocuments(readFileSync(file, 'utf8'))) {
    assert.equal(d.errors.length, 0, `${rel(file)}: YAML을 읽지 못했다: ${d.errors[0]?.message}`);
    const o = d.toJS();
    if (o && typeof o === 'object') out.push(o);
  }
  assert.ok(out.length > 0, `${rel(file)}에 객체가 하나도 없다`);
  cache.set(file, out);
  return out;
}
const meshObjects = () => objectsOf(POLICIES);
const meshlessObjects = () => objectsOf(MESHLESS);

/** 폴더 아래 파일(재귀, 걸러 내기) */
function walk(dir, keep, out = []) {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (n === 'node_modules' || n.startsWith('.')) continue;
    if (statSync(p).isDirectory()) walk(p, keep, out);
    else if (keep(p)) out.push(p);
  }
  return out;
}
/** 주석 줄을 뺀 글 */
const withoutComments = (text) =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
/**
 * deploy/ 아래 매니페스트 글 파일(YAML·Helm 템플릿·JSON, 이 시험 폴더 뺌). 운영 오버레이가 놓일 deploy/envs/<환경>/와 차트 템플릿까지 훑는다
 * (리뷰 RV-02·RV-03: 줄 모양·확장자에 기대지 않는다). 주석 줄을 뺀 글과 함께 돌려준다
 */
const deployTexts = () =>
  walk(join(REPO, 'deploy'), (f) => /\.(ya?ml|tpl|json)$/.test(f) && !f.startsWith(HERE)).map((f) => ({ file: f, text: withoutComments(readFileSync(f, 'utf8')) }));

/** proto: 전체 서비스 이름 → { package, file, methods } (시험이 스스로 읽는다, MS-08) */
function readProtos() {
  const dir = join(REPO, 'docs', 'api', 'proto', 'peaket');
  const out = new Map();
  for (const file of walk(dir, (p) => p.endsWith('.proto'))) {
    const text = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(text)?.[1];
    const re = /\bservice\s+(\w+)\s*\{/g;
    let m;
    while ((m = re.exec(text))) {
      let depth = 1;
      let i = re.lastIndex;
      for (; i < text.length && depth > 0; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') depth--;
      }
      const body = text.slice(re.lastIndex, i - 1);
      const methods = [...body.matchAll(/\brpc\s+(\w+)\s*\(/g)].map((x) => x[1]);
      out.set(`${pkg}.${m[1]}`, { package: pkg, file: rel(file), methods });
    }
  }
  assert.ok(out.size > 0, 'proto 서비스를 하나도 읽지 못했다');
  return out;
}
let protoCache;
const protos = () => (protoCache ??= readProtos());

/** 정본 표의 서비스 → 메서드마다 부르는 쪽(서비스 단위로 적은 것은 proto의 모든 메서드에 편다) */
function methodTable() {
  const out = new Map(); // `/${svc}/${method}` → { receiver, callers }
  for (const [w, services] of Object.entries(GRPC))
    for (const [svc, v] of Object.entries(services)) {
      const p = protos().get(svc);
      assert.ok(p, `정본 표의 ${svc}가 proto에 없다(시험 표를 고친다)`);
      for (const m of p.methods) {
        const callers = Array.isArray(v) ? v : v[m];
        assert.ok(Array.isArray(callers), `정본 표에 ${svc}/${m}의 부르는 쪽이 없다(새 메서드면 정본에서 부르는 쪽을 찾아 표에 더한다)`);
        out.set(`/${svc}/${m}`, { receiver: w, service: svc, method: m, callers });
      }
      if (!Array.isArray(v)) for (const m of Object.keys(v)) assert.ok(p.methods.includes(m), `정본 표의 ${svc}/${m}가 proto에 없다`);
    }
  return out;
}

/**
 * 게이트웨이 → 워크로드 REST 포트 쌍(시험이 deploy/gateways 맨 위 YAML을 스스로 읽는다, MS-01, ADR-0285 결정 1):
 * HTTPRoute·GRPCRoute 규칙의 backendRefs(그 라우트의 parentRefs 게이트웨이), SecurityPolicy·EnvoyExtensionPolicy의 백엔드와 remoteJWKS 주소(붙는 게이트웨이)
 */
function gatewayReach() {
  const dir = join(REPO, 'deploy', 'gateways');
  assert.ok(existsSync(dir), 'deploy/gateways가 없다');
  const objs = [];
  for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort()) {
    const p = join(dir, f);
    if (!statSync(p).isFile()) continue;
    for (const d of parseAllDocuments(readFileSync(p, 'utf8'))) {
      const o = d.toJS();
      if (o && typeof o === 'object') objs.push(o);
    }
  }
  const gateways = new Set(objs.filter((o) => o.kind === 'Gateway').map((o) => o.metadata?.name));
  const refsIn = (v, acc = []) => {
    if (Array.isArray(v)) for (const x of v) refsIn(x, acc);
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        if (k === 'backendRefs' && Array.isArray(x)) acc.push(...x);
        else if (k === 'backendRef' && x && typeof x === 'object') acc.push(x);
        else refsIn(x, acc);
      }
    return acc;
  };
  const routes = new Map();
  const pairs = []; // { gateway, name, namespace, port, via }
  const parents = (r) => (r.spec?.parentRefs ?? []).filter((p) => (p.kind ?? 'Gateway') === 'Gateway').map((p) => p.name);
  for (const r of objs.filter((o) => o.kind === 'HTTPRoute' || o.kind === 'GRPCRoute')) {
    const ns = r.metadata?.namespace ?? 'default';
    routes.set(`${r.kind}/${ns}/${r.metadata?.name}`, r);
    for (const rule of r.spec?.rules ?? [])
      for (const ref of refsIn(rule)) for (const g of parents(r)) pairs.push({ gateway: g, name: ref.name, namespace: ref.namespace ?? ns, port: ref.port, kind: ref.kind ?? 'Service', via: `${r.kind}/${r.metadata?.name}` });
  }
  for (const pol of objs.filter((o) => o.kind === 'SecurityPolicy' || o.kind === 'EnvoyExtensionPolicy')) {
    const ns = pol.metadata?.namespace ?? 'default';
    const backends = refsIn(pol.spec).map((ref) => ({ name: ref.name, namespace: ref.namespace ?? ns, port: ref.port, kind: ref.kind ?? 'Service' }));
    for (const prov of pol.spec?.jwt?.providers ?? []) {
      const uri = prov?.remoteJWKS?.uri;
      if (!uri) continue;
      const u = new URL(uri);
      const h = /^([a-z0-9-]+)\.([a-z0-9-]+)\.svc\.cluster\.local$/.exec(u.hostname);
      assert.ok(h, `${pol.metadata?.name}: 공개키 묶음 주소가 클러스터 안 Service가 아니다: ${uri}`);
      backends.push({ name: h[1], namespace: h[2], port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)), kind: 'Service' });
    }
    if (!backends.length) continue;
    const gws = [];
    for (const t of [...(pol.spec?.targetRefs ?? []), ...(pol.spec?.targetRef ? [pol.spec.targetRef] : [])]) {
      if (t.kind === 'Gateway') gws.push(t.name);
      else {
        const r = routes.get(`${t.kind}/${ns}/${t.name}`);
        assert.ok(r, `${pol.metadata?.name}: 붙는 ${t.kind}/${t.name}가 deploy/gateways 맨 위 YAML에 없다`);
        gws.push(...parents(r));
      }
    }
    assert.ok(gws.length, `${pol.metadata?.name}: 백엔드에 닿는데 붙는 게이트웨이를 찾지 못했다`);
    for (const g of gws) for (const b of backends) pairs.push({ gateway: g, ...b, via: `${pol.kind}/${pol.metadata?.name}` });
  }
  const reach = new Map(REST_RECEIVERS.map((w) => [w, new Set()]));
  return { gateways, routes: routes.size, pairs, reach };
}
let reachCache;
/** 워크로드 → 그 REST 포트에 닿는 게이트웨이(라우트·공개키 묶음 + trust-svc의 gw-fan 예외) */
function restGateways() {
  if (reachCache) return reachCache;
  const r = gatewayReach();
  assert.ok(r.routes > 0, 'deploy/gateways 맨 위 YAML에서 라우트를 하나도 읽지 못했다');
  assert.deepEqual(sorted(r.gateways), GATEWAYS, 'deploy/gateways의 Gateway는 다섯이다');
  for (const p of r.pairs) {
    assert.equal(p.kind, 'Service', `${p.via}: Service가 아닌 백엔드 ${p.kind}/${p.name}`);
    assert.ok(REST_RECEIVERS.includes(p.name), `${p.via}: 이 시험의 정본 표에 없는 백엔드 ${p.namespace}/${p.name}(새 서비스면 정본 표와 시험을 함께 고친다)`);
    assert.equal(p.namespace, NAMESPACE_OF[p.name], `${p.via}: ${p.name}의 네임스페이스`);
    assert.equal(p.port, REST_PORT(p.name), `${p.via}: ${p.name}의 REST 포트`);
    r.reach.get(p.name).add(p.gateway);
  }
  // ADR-0285 결정 9 끝: trust-svc 허니팟 경로는 공개 경로를 설정으로 넣어 저장소 라우트에 없다(gw-fan만)
  assert.equal(r.reach.get('trust-svc').size, 0, '저장소 라우트가 trust-svc를 가리킨다(정본은 예외 한 줄이다. 시험 표를 다시 본다)');
  r.reach.get('trust-svc').add('gw-fan');
  reachCache = r.reach;
  return reachCache;
}

/** 워크로드 → 포트 → 부르는 쪽 이름(메시 없는 실행 기준. 업무 gRPC는 그 워크로드의 모든 서비스·메서드 부르는 쪽의 합, ADR-0285 결정 8) */
function expectedCallers() {
  const out = new Map(WORKLOADS.map((w) => [w, new Map()]));
  const gw = restGateways();
  for (const w of REST_RECEIVERS) out.get(w).set(REST_PORT(w), new Set([...gw.get(w), ...INTERNAL_HTTP.filter(([, to]) => to === w).map(([from]) => from)]));
  for (const w of GRPC_RECEIVERS) {
    const all = new Set();
    for (const v of Object.values(GRPC[w])) for (const c of Array.isArray(v) ? v : Object.values(v).flat()) all.add(c);
    out.get(w).set(GRPC_PORT(w), all);
  }
  for (const w of CONTROL_RECEIVERS) out.get(w).set(CONTROL_PORT, new Set(CONTROL_CALLERS));
  for (const w of METRICS_RECEIVERS) out.get(w).set(METRICS_PORT, new Set(['prometheus']));
  return out;
}
/** 운영 오버레이 기준(업무 gRPC 포트는 웨이포인트 하나) → 포트 → 주체 */
function expectedPrincipals() {
  const out = new Map();
  for (const [w, ports] of expectedCallers()) {
    const m = new Map();
    for (const [port, names] of ports) m.set(port, new Set(GRPC_RECEIVERS.includes(w) && port === GRPC_PORT(w) ? [waypointPrincipal(w)] : [...names].map(principalOf)));
    out.set(w, m);
  }
  return out;
}

// ===================== 흉내(정책이 실제로 받는 것) =====================

const ALL = '*';
const labelsMatch = (sel, labels) => Object.entries(sel ?? {}).every(([k, v]) => labels?.[k] === v);
/** 쿠버네티스 라벨 고르개(matchLabels·matchExpressions) */
function selectorMatches(sel, labels) {
  if (!sel) return true;
  if (!labelsMatch(sel.matchLabels, labels)) return false;
  for (const e of sel.matchExpressions ?? []) {
    const has = Object.hasOwn(labels ?? {}, e.key);
    const v = labels?.[e.key];
    if (e.operator === 'In' && !(has && e.values.includes(v))) return false;
    if (e.operator === 'NotIn' && has && e.values.includes(v)) return false;
    if (e.operator === 'Exists' && !has) return false;
    if (e.operator === 'DoesNotExist' && has) return false;
  }
  return true;
}

/** 받는 쪽 노드 프록시 정책: 워크로드 파드에 걸리는 AuthorizationPolicy(셀렉터로 고르거나 셀렉터 없는 네임스페이스 전체) */
function nodePolicies(objs, w) {
  return objs.filter((o) => o.kind === 'AuthorizationPolicy' && o.metadata?.namespace === NAMESPACE_OF[w] && !o.spec?.targetRefs && !o.spec?.targetRef && labelsMatch(o.spec?.selector?.matchLabels, serviceLabels(w)));
}
/** 규칙의 출처 주체(빈 from, 주체 밖의 칸, '*'는 모두) */
function sourcesOf(rule) {
  if (!Array.isArray(rule.from) || rule.from.length === 0) return ALL;
  const out = new Set();
  for (const f of rule.from) {
    const s = f?.source ?? {};
    const keys = Object.keys(s);
    if (keys.length !== 1 || keys[0] !== 'principals' || !Array.isArray(s.principals) || s.principals.length === 0) return ALL;
    for (const p of s.principals) {
      if (String(p).includes('*')) return ALL;
      out.add(p);
    }
  }
  return out;
}
/** 노드 프록시 정책이 받는 것: 포트(글) → 주체 집합(ALL은 모두). 포트가 빠진 규칙은 ALL 포트 */
function meshNodeAllow(objs, w) {
  const allow = new Map();
  const add = (port, srcs) => {
    const cur = allow.get(port) ?? new Set();
    if (srcs === ALL) cur.add(ALL);
    else for (const s of srcs) cur.add(s);
    allow.set(port, cur);
  };
  for (const p of nodePolicies(objs, w)) {
    assert.equal(p.spec?.action ?? 'ALLOW', 'ALLOW', `${p.metadata?.name}: ALLOW가 아닌 정책`);
    for (const r of p.spec?.rules ?? []) {
      const srcs = sourcesOf(r);
      const tos = Array.isArray(r.to) ? r.to : [];
      if (!tos.length) add(ALL, srcs);
      for (const t of tos) {
        const ports = t?.operation?.ports;
        if (!Array.isArray(ports) || ports.length === 0) add(ALL, srcs);
        else for (const port of ports) add(String(port), srcs);
      }
    }
  }
  return allow;
}
const allowedOn = (allow, port) => new Set([...(allow.get(String(port)) ?? []), ...(allow.get(ALL) ?? [])]);

/** Istio 경로 맞춤(정확, 앞머리*, *뒷머리, *) */
const pathMatch = (pat, path) => (pat === '*' ? true : pat.endsWith('*') ? path.startsWith(pat.slice(0, -1)) : pat.startsWith('*') ? path.endsWith(pat.slice(1)) : pat === path);
/** 웨이포인트 정책(그 워크로드의 웨이포인트에 붙은 것) */
function waypointPolicies(objs, w) {
  return objs.filter((o) => o.kind === 'AuthorizationPolicy' && o.metadata?.namespace === NAMESPACE_OF[w] && (o.spec?.targetRefs ?? []).some((t) => t.kind === 'Gateway' && t.name === `${w}-waypoint`));
}
/** 웨이포인트 정책이 그 경로에 받는 주체(ALL은 모두) */
function waypointAllowed(objs, w, path) {
  const out = new Set();
  for (const p of waypointPolicies(objs, w)) {
    assert.equal(p.spec?.action ?? 'ALLOW', 'ALLOW', `${p.metadata?.name}: ALLOW가 아닌 정책`);
    for (const r of p.spec?.rules ?? []) {
      const tos = Array.isArray(r.to) ? r.to : [];
      const hit = !tos.length || tos.some((t) => !t?.operation || !Array.isArray(t.operation.paths) || t.operation.notPaths || t.operation.paths.some((pat) => pathMatch(pat, path)));
      if (!hit) continue;
      const srcs = sourcesOf(r);
      if (srcs === ALL) out.add(ALL);
      else for (const s of srcs) out.add(s);
    }
  }
  return out;
}

/** 메시 없는 실행: 워크로드 파드를 고르는 NetworkPolicy가 (포트, 부르는 쪽 파드)를 받나. 고르는 정책이 없으면 모두 받는다 */
function meshlessAllows(objs, w, port, who) {
  const ns = NAMESPACE_OF[w];
  const nps = objs.filter((o) => o.kind === 'NetworkPolicy' && o.metadata?.namespace === ns && selectorMatches(o.spec?.podSelector ?? {}, serviceLabels(w)) && (o.spec?.policyTypes ?? ['Ingress']).includes('Ingress'));
  if (!nps.length) return true;
  return nps.some((np) =>
    (np.spec?.ingress ?? []).some((rule) => {
      const portOk = !Array.isArray(rule.ports) || rule.ports.length === 0 || rule.ports.some((p) => (p.protocol ?? 'TCP') === 'TCP' && (p.port === undefined || (typeof p.port === 'number' && (p.endPort ? port >= p.port && port <= p.endPort : port === p.port))));
      if (!portOk) return false;
      if (!Array.isArray(rule.from) || rule.from.length === 0) return true;
      return rule.from.some((peer) => {
        if (peer.ipBlock || (!peer.namespaceSelector && !peer.podSelector)) return true;
        const nsOk = peer.namespaceSelector ? selectorMatches(peer.namespaceSelector, { [NAME_LABEL]: who.namespace }) : who.namespace === ns;
        const podOk = peer.podSelector ? selectorMatches(peer.podSelector, who.podLabels ?? {}) : true;
        return nsOk && podOk;
      });
    }),
  );
}
/** 메시 없는 정책이 그 (워크로드, 포트)에 받는 정본 신원 이름들 */
const meshlessCallerNames = (objs, w, port) => Object.keys(IDENTITY).filter((n) => meshlessAllows(objs, w, port, IDENTITY[n]));
/** 목록 밖 신원 가운데 받는 것(있으면 결함) */
const meshlessOutsidersIn = (objs, w, port) => OUTSIDERS.filter((o) => meshlessAllows(objs, w, port, o)).map((o) => o.who);
/** 워크로드의 정본 포트들(정본 밖 포트도 막혀야 하므로 함께 본다) */
const ALL_PORTS = [8080, 3000, 3001, 50051, 50052, 50061, METRICS_PORT, 15008, 443, 80];

// ===================== MS-01 D-T36 ① =====================

test('MS-01 D-T36 ① 정적 게이트웨이 → 서비스 REST 포트: 두 생성 파일의 REST 규칙에 든 게이트웨이가 라우트 backendRefs·remoteJWKS로 시험이 뽑은 쌍과 같고, 경로를 보내지 않는 게이트웨이는 하나씩 없다', () => {
  const reach = restGateways();
  // 정본 쌍의 보기(계획 6 MS-01, 2026-11-18 저장소 라우트): 시험의 라우트 읽기가 틀리면 여기서 먼저 깨진다
  assert.deepEqual(sorted(reach.get('core-svc')), ['gw-fan', 'gw-ops', 'gw-partner'], 'core-svc REST에 닿는 게이트웨이(gw-queue·gw-scanner 없음)');
  assert.deepEqual(sorted(reach.get('queue-svc')), ['gw-queue'], 'queue-svc REST는 gw-queue만');
  assert.ok(reach.get('identity-svc').has('gw-queue'), 'gw-queue는 공개키 묶음(remoteJWKS)으로 identity-svc REST에 닿는다');
  assert.deepEqual(sorted(reach.get('web')), ['gw-fan'], '손으로 쓴 gw-fan.yaml의 web 백엔드');
  assert.deepEqual(sorted(reach.get('partner')), ['gw-partner'], '손으로 쓴 gw-partner.yaml의 partner 백엔드');
  const mesh = meshObjects();
  const meshless = meshlessObjects();
  for (const w of WORKLOADS) {
    const allow = meshNodeAllow(mesh, w);
    for (const g of GATEWAYS) {
      const want = REST_RECEIVERS.includes(w) && reach.get(w).has(g);
      for (const port of ALL_PORTS) {
        const meshHas = allowedOn(allow, port).has(principalOf(g)) || allowedOn(allow, port).has(ALL);
        const meshlessHas = meshlessAllows(meshless, w, port, IDENTITY[g]);
        const expect = want && port === REST_PORT(w);
        assert.equal(meshHas, expect, `policies.yaml ${w}:${port}에 ${g}가 ${expect ? '없다' : '있다'}`);
        assert.equal(meshlessHas, expect, `meshless ${w}:${port}에 ${g} 파드가 ${expect ? '닿지 못한다' : '닿는다'}`);
      }
    }
  }
});

// ===================== MS-02 D-T36 ② =====================

test('MS-02 D-T36 ② 정적 업무 gRPC 포트: 노드 프록시 정책의 주체는 그 워크로드의 웨이포인트 하나이고, NetworkPolicy는 정본 부르는 쪽의 합만 받으며 표에 없는 파드는 하나씩 거부한다', () => {
  const mesh = meshObjects();
  const meshless = meshlessObjects();
  const want = expectedCallers();
  for (const w of GRPC_RECEIVERS) {
    const port = GRPC_PORT(w);
    assert.deepEqual(sorted(allowedOn(meshNodeAllow(mesh, w), port)), [waypointPrincipal(w)], `policies.yaml ${w}:${port}의 주체는 웨이포인트 하나다`);
    assert.deepEqual(sorted(meshlessCallerNames(meshless, w, port)), sorted(want.get(w).get(port)), `meshless ${w}:${port}의 부르는 쪽`);
    assert.deepEqual(meshlessOutsidersIn(meshless, w, port), [], `meshless ${w}:${port}에 목록 밖 파드가 닿는다`);
  }
  // 정본에 없는 파드의 보기(계획 6 MS-02)
  for (const n of ['web', 'trust-svc']) assert.equal(meshlessAllows(meshless, 'payment-svc', 50051, IDENTITY[n]), false, `payment-svc 업무 gRPC에 ${n}가 닿는다`);
  assert.equal(meshlessAllows(meshless, 'image-worker', 50051, IDENTITY['ops-svc']), false, 'image-worker 업무 gRPC에 ops-svc가 닿는다');
  for (const g of GATEWAYS) for (const w of GRPC_RECEIVERS) assert.equal(meshlessAllows(meshless, w, GRPC_PORT(w), IDENTITY[g]), false, `${w} 업무 gRPC에 ${g}가 닿는다`);
});

// ===================== MS-03 D-T36 ③ =====================

test('MS-03 D-T36 ③ 정적 웹 앱 서버 → identity-svc: SessionService 메서드마다 웨이포인트가 받는 주체는 web뿐이고, 메시 없는 identity-svc 업무 gRPC는 web(네임스페이스 web·라벨)을 받는다', () => {
  const mesh = meshObjects();
  const p = protos().get('peaket.identity.v1.SessionService');
  assert.ok(p && p.methods.length >= 6, 'proto에 SessionService 메서드가 없다');
  for (const m of p.methods) assert.deepEqual(sorted(waypointAllowed(mesh, 'identity-svc', `/peaket.identity.v1.SessionService/${m}`)), [principalOf('web')], `SessionService/${m}`);
  // web은 identity-svc의 다른 서비스에 닿지 않는다(정본 부르는 쪽이 아니다)
  for (const [svc] of Object.entries(GRPC['identity-svc']).filter(([s]) => s !== 'peaket.identity.v1.SessionService'))
    for (const m of protos().get(svc).methods) assert.ok(!waypointAllowed(mesh, 'identity-svc', `/${svc}/${m}`).has(principalOf('web')), `${svc}/${m}에 web이 있다`);
  const meshless = meshlessObjects();
  assert.equal(meshlessAllows(meshless, 'identity-svc', 50051, IDENTITY.web), true, 'meshless identity-svc 업무 gRPC에 web이 닿지 못한다');
  // web 라벨을 단 다른 네임스페이스 파드는 닿지 않는다
  assert.equal(meshlessAllows(meshless, 'identity-svc', 50051, { namespace: 'core', podLabels: serviceLabels('web') }), false, 'core 네임스페이스의 web 라벨 파드가 닿는다');
});

// ===================== MS-04·05 D-T36 ④⑤ =====================

test('MS-04 D-T36 ④ 정적 게이트웨이 → 제어 gRPC 포트: 넷의 제어 규칙에 게이트웨이 다섯의 주체·라벨이 하나도 없고 envoy-gateway-system 출처도 없다', () => {
  const mesh = meshObjects();
  const meshless = meshlessObjects();
  for (const w of CONTROL_RECEIVERS) {
    const got = allowedOn(meshNodeAllow(mesh, w), CONTROL_PORT);
    for (const g of GATEWAYS) {
      assert.ok(!got.has(principalOf(g)) && !got.has(ALL), `policies.yaml ${w} 제어 포트에 ${g}`);
      assert.equal(meshlessAllows(meshless, w, CONTROL_PORT, IDENTITY[g]), false, `meshless ${w} 제어 포트에 ${g} 파드가 닿는다`);
      assert.equal(meshlessAllows(meshless, w, CONTROL_PORT, { namespace: GW_NS, podLabels: { [GW_NAME_LABEL]: g } }), false, `meshless ${w} 제어 포트에 ${g} 이름 라벨 파드가 닿는다`);
    }
    assert.ok(![...got].some((p) => p.startsWith(`cluster.local/ns/${GW_NS}/`)), `policies.yaml ${w} 제어 포트에 ${GW_NS}의 주체`);
    const np = meshless.find((o) => o.kind === 'NetworkPolicy' && o.metadata?.name === `${w}-ports`);
    assert.ok(np, `meshless에 ${w}-ports가 없다`);
    for (const rule of np.spec?.ingress ?? [])
      if ((rule.ports ?? []).some((p) => p.port === CONTROL_PORT))
        for (const peer of rule.from ?? []) assert.notEqual(peer.namespaceSelector?.matchLabels?.[NAME_LABEL], GW_NS, `meshless ${w} 제어 포트에 ${GW_NS} 출처`);
  }
});

test('MS-05 D-T36 ⑤ 정적 런북 Job → 제어 gRPC 포트: 넷의 제어 규칙 주체가 정확히 {ops-svc, 비상 런북 Job}이고 NetworkPolicy 출처가 정확히 {ops-svc 칸, ops-breakglass 네임스페이스만 칸}이다', () => {
  const mesh = meshObjects();
  const meshless = meshlessObjects();
  for (const w of CONTROL_RECEIVERS) {
    assert.deepEqual(sorted(allowedOn(meshNodeAllow(mesh, w), CONTROL_PORT)), sorted(CONTROL_CALLERS.map(principalOf)), `policies.yaml ${w} 제어 포트`);
    assert.deepEqual(sorted(meshlessCallerNames(meshless, w, CONTROL_PORT)), sorted(CONTROL_CALLERS), `meshless ${w} 제어 포트의 부르는 쪽`);
    // 비상 런북 Job은 라벨과 상관없이 ops-breakglass 네임스페이스면 받는다
    for (const labels of [{}, { 'job-name': 'x' }]) assert.equal(meshlessAllows(meshless, w, CONTROL_PORT, { namespace: 'ops-breakglass', podLabels: labels }), true, `${w}: ops-breakglass 파드(${JSON.stringify(labels)})가 닿지 못한다`);
    assert.deepEqual(meshlessOutsidersIn(meshless, w, CONTROL_PORT), [], `meshless ${w} 제어 포트에 목록 밖 파드`);
    // 다른 서비스(같은 네임스페이스 포함)는 거부: purchase-svc → admission-ctrl, queue-svc → admission-ctrl
    for (const n of ['purchase-svc', 'queue-svc', 'payment-svc', 'core-svc', 'identity-svc', 'web']) assert.equal(meshlessAllows(meshless, w, CONTROL_PORT, IDENTITY[n]), false, `${w} 제어 포트에 ${n}가 닿는다`);
    const np = meshless.find((o) => o.kind === 'NetworkPolicy' && o.metadata?.name === `${w}-ports`);
    const peers = (np?.spec?.ingress ?? []).filter((r) => (r.ports ?? []).some((p) => p.port === CONTROL_PORT)).flatMap((r) => r.from ?? []);
    assert.equal(peers.length, 2, `${w} 제어 포트의 출처 칸은 둘이다: ${JSON.stringify(peers)}`);
    const nsOnly = peers.filter((p) => p.namespaceSelector && !p.podSelector);
    assert.deepEqual(nsOnly.map((p) => p.namespaceSelector.matchLabels), [{ [NAME_LABEL]: 'ops-breakglass' }], `${w}: 네임스페이스만인 칸은 ops-breakglass 하나`);
    const ops = peers.filter((p) => p.podSelector);
    assert.deepEqual(ops.map((p) => [p.namespaceSelector?.matchLabels, p.podSelector.matchLabels]), [[{ [NAME_LABEL]: 'core' }, serviceLabels('ops-svc')]], `${w}: ops-svc 칸`);
  }
});

// ===================== MS-06 D-T36 ⑥ =====================

test('MS-06 D-T36 ⑥ 정적 gw-fan → trust-svc REST 포트: 두 파일에서 trust-svc REST는 정확히 gw-fan 하나이고 다른 게이트웨이·내부 HTTP 신원·그 밖의 파드는 없다', () => {
  const mesh = meshObjects();
  const meshless = meshlessObjects();
  assert.deepEqual(sorted(allowedOn(meshNodeAllow(mesh, 'trust-svc'), 8080)), [principalOf('gw-fan')], 'policies.yaml trust-svc:8080');
  assert.deepEqual(meshlessCallerNames(meshless, 'trust-svc', 8080), ['gw-fan'], 'meshless trust-svc:8080');
  assert.deepEqual(meshlessOutsidersIn(meshless, 'trust-svc', 8080), [], 'meshless trust-svc:8080에 목록 밖 파드');
  for (const n of ['gw-partner', 'gw-ops', 'gw-queue', 'gw-scanner', 'identity-svc', 'queue-svc', 'ops-svc', 'web']) assert.equal(meshlessAllows(meshless, 'trust-svc', 8080, IDENTITY[n]), false, `trust-svc REST에 ${n}가 닿는다`);
});

// ===================== MS-07 D-T36 ⑦ =====================

const ADMIN_PATH = '/peaket.identity.v1.AdminAuthzService/GetAdminAuthz';
/** AdminAuthzService 판정(틀린 판을 넣어 이 판정이 실제로 잡는지 함께 본다) */
function adminAuthzProblems(mesh, meshless) {
  const out = [];
  const got = waypointAllowed(mesh, 'identity-svc', ADMIN_PATH);
  const want = sorted([...ADMIN_EIGHT, 'admission-ctrl'].map(principalOf));
  if (show(got) !== JSON.stringify(want)) out.push(`웨이포인트 ${ADMIN_PATH}: ${show([...got].map((p) => nameOfPrincipal.get(p) ?? p))}`);
  for (const n of [...ADMIN_EIGHT, 'admission-ctrl']) if (!meshlessAllows(meshless, 'identity-svc', 50051, IDENTITY[n])) out.push(`meshless identity-svc 업무 gRPC에 ${n}가 닿지 못한다`);
  return out;
}
const clone = (v) => structuredClone(v);
/** policies.yaml 사본에서 AdminAuthzService 경로 규칙의 주체를 바꾼다 */
function mutateAdmin(mesh, fn) {
  const c = clone(mesh);
  let hit = 0;
  for (const p of waypointPolicies(c, 'identity-svc'))
    for (const r of p.spec?.rules ?? [])
      if ((r.to ?? []).some((t) => (t.operation?.paths ?? []).some((pat) => pathMatch(pat, ADMIN_PATH))))
        for (const f of r.from ?? []) {
          f.source.principals = fn(f.source.principals ?? []);
          hit++;
        }
  assert.ok(hit > 0, 'AdminAuthzService 경로 규칙을 찾지 못했다(틀린 판을 만들 수 없다)');
  return c;
}

test('MS-07 D-T36 ⑦ 정적 RolesGuard → GetAdminAuthz: 웨이포인트가 받는 주체가 정확히 여덟 서비스와 admission-ctrl이고, 하나씩 뺀 판·web을 더한 판은 이 판정이 잡는다. 메시 없는 identity-svc 업무 gRPC는 아홉을 모두 받는다', () => {
  const mesh = meshObjects();
  const meshless = meshlessObjects();
  assert.deepEqual(adminAuthzProblems(mesh, meshless), []);
  for (const n of [...ADMIN_EIGHT, 'admission-ctrl']) {
    const bad = mutateAdmin(mesh, (ps) => ps.filter((p) => p !== principalOf(n)));
    assert.notDeepEqual(adminAuthzProblems(bad, meshless), [], `${n}를 뺀 판을 판정이 놓친다`);
  }
  for (const n of ['web', 'image-worker', 'seatmap-worker', 'gw-ops']) {
    const bad = mutateAdmin(mesh, (ps) => [...ps, principalOf(n)]);
    assert.notDeepEqual(adminAuthzProblems(bad, meshless), [], `${n}를 더한 판을 판정이 놓친다`);
  }
  // 그 밖의 파드(이미지·좌석맵 작업자, 표에 없는 파드)는 GetAdminAuthz 경로를 부르지 못한다
  const got = waypointAllowed(mesh, 'identity-svc', ADMIN_PATH);
  for (const n of ['image-worker', 'seatmap-worker', 'web', 'partner', 'prometheus', ...GATEWAYS]) assert.ok(!got.has(principalOf(n)), `GetAdminAuthz에 ${n}`);
});

// ===================== MS-08·09 proto·부르는 쪽 표 =====================

test('MS-08 proto 대조: ControlReceiver를 뺀 proto 서비스는 모두 정본 표에 있고 받는 쪽은 패키지로 정한 워크로드다. 웨이포인트 정책의 경로는 모두 proto에 있는 그 워크로드의 서비스·메서드이고 ControlReceiver 경로는 없다', () => {
  const mesh = meshObjects();
  const table = methodTable();
  for (const [svc, p] of protos()) {
    if (svc === CONTROL_SERVICE) continue;
    const x = /^peaket\.([a-z0-9]+)\.v\d+$/.exec(p.package)?.[1];
    const receiver = PACKAGE_RECEIVER[x];
    assert.ok(receiver, `${svc}(${p.file}): 패키지 ${p.package}의 받는 쪽을 정하지 못했다`);
    assert.ok(GRPC[receiver]?.[svc], `proto 서비스 ${svc}(${p.file})가 정본 표에 없다(부르는 쪽을 정본에서 정해 원천·시험에 함께 더한다)`);
  }
  const all = [...table.keys()];
  for (const w of WORKLOADS) {
    const pols = waypointPolicies(mesh, w);
    for (const p of pols)
      for (const r of p.spec?.rules ?? [])
        for (const t of r.to ?? [])
          for (const pat of t.operation?.paths ?? []) {
            const exact = !pat.includes('*');
            const hits = all.filter((path) => pathMatch(pat, path));
            assert.ok(hits.length > 0, `${p.metadata?.name}: 경로 ${pat}가 proto의 어느 메서드에도 맞지 않는다`);
            for (const h of hits) assert.equal(table.get(h).receiver, w, `${p.metadata?.name}: 경로 ${pat}가 다른 워크로드(${table.get(h).receiver})의 메서드 ${h}에 맞는다`);
            if (!exact) assert.match(pat, /^\/peaket\.[a-z0-9]+\.v\d+\.\w+\/\*$/, `${p.metadata?.name}: 서비스 단위가 아닌 넓은 경로 ${pat}`);
          }
  }
  const control = protos().get(CONTROL_SERVICE);
  assert.ok(control, 'proto에 ControlReceiver가 없다');
  for (const w of WORKLOADS) for (const m of control.methods) assert.equal(waypointAllowed(mesh, w, `/${CONTROL_SERVICE}/${m}`).size, 0, `${w} 웨이포인트에 ${CONTROL_SERVICE}/${m} 경로`);
});

test('MS-09 부르는 쪽 표 대조: proto 메서드마다 웨이포인트가 받는 주체가 정본 표(서비스·메서드 → 부르는 쪽)와 같다(TicketService/ListTickets는 web, IssueTickets에 web 없음, VoidTickets는 purchase-svc, 배상 송금은 RequestCompensationTransfer만 purchase-svc이고 GetCompensationTransfer는 아무도 없음)', () => {
  const mesh = meshObjects();
  const table = methodTable();
  assert.ok(table.size > 80, `정본 표가 너무 작다(${table.size})`);
  for (const [path, { receiver, callers }] of table) {
    const got = waypointAllowed(mesh, receiver, path);
    assert.deepEqual(sorted(got), sorted(callers.map(principalOf)), `${receiver} ${path}`);
    // 다른 워크로드의 웨이포인트가 이 경로를 받지 않는다
    for (const w of GRPC_RECEIVERS.filter((x) => x !== receiver)) assert.equal(waypointAllowed(mesh, w, path).size, 0, `${w} 웨이포인트가 ${path}를 받는다`);
  }
  const t = (m) => sorted(waypointAllowed(mesh, 'ticket-svc', `/peaket.ticket.v1.TicketService/${m}`));
  assert.deepEqual(t('ListTickets'), [principalOf('web')]);
  assert.ok(!t('IssueTickets').includes(principalOf('web')), 'IssueTickets에 web이 있다(메서드 단위를 버렸다)');
  assert.deepEqual(t('VoidTickets'), [principalOf('purchase-svc')]);
  const pay = (m) => sorted(waypointAllowed(mesh, 'payment-svc', `/peaket.payment.v1.PaymentService/${m}`));
  assert.deepEqual(pay('ApprovePayoutBatch'), [principalOf('ops-svc')]);
  assert.deepEqual(pay('RegisterPayoutSeller'), [principalOf('core-svc')]);
  assert.ok(!pay('ConfirmPayment').includes(principalOf('ops-svc')), 'ConfirmPayment에 ops-svc가 있다');
  // 명령 12 판정(BAT-360, ADR-0349 결정 3): ops-svc 하나만 받고 결제를 만드는 쪽(purchase-svc·core-svc)은 받지 않는다
  assert.deepEqual(pay('CheckEventPgAssignment'), [principalOf('ops-svc')]);
  // 탈퇴 참여자(BAT-010, ADR-0284 결정 1): identity-svc는 받고, 그 밖(web·purchase-svc 자신·ops-svc·게이트웨이)은 받지 않는다
  const wd = waypointAllowed(mesh, 'purchase-svc', '/peaket.purchase.v1.WithdrawalParticipantService/ProcessAccountWithdrawal');
  assert.ok(wd.has(principalOf('identity-svc')), 'ProcessAccountWithdrawal에 identity-svc가 없다');
  for (const n of ['web', 'purchase-svc', 'ops-svc', 'core-svc', ...GATEWAYS]) assert.ok(!wd.has(principalOf(n)) && !wd.has(ALL), `ProcessAccountWithdrawal에 ${n}`);
  // 배상 송금(ADR-0317 결정 1): 송금 요청은 purchase-svc 하나, 부르는 쪽 0개(경계)인 송금 조회는 아무도 부르지 못한다
  const comp = (m) => sorted(waypointAllowed(mesh, 'payment-svc', `/peaket.payment.v1.CompensationTransferService/${m}`));
  assert.deepEqual(comp('RequestCompensationTransfer'), [principalOf('purchase-svc')]);
  assert.deepEqual(comp('GetCompensationTransfer'), [], 'CompensationTransferService/GetCompensationTransfer에 규칙이 있다');
});

// ===================== MS-10 기본 거부 =====================

test('MS-10 기본 거부: 워크로드 열셋마다 <워크로드>-ports가 두 파일에 하나씩 있고, 모든 규칙에 출처와 포트가 있으며(메시 출처는 principals뿐), 받는 포트·신원이 정본 표와 정확히 같다', () => {
  const mesh = meshObjects();
  const meshless = meshlessObjects();
  const nodeNames = mesh.filter((o) => o.kind === 'AuthorizationPolicy' && !o.spec?.targetRefs).map((o) => o.metadata?.name);
  assert.deepEqual(sorted(nodeNames), sorted(WORKLOADS.map((w) => `${w}-ports`)), 'policies.yaml의 노드 프록시 정책');
  assert.deepEqual(sorted(meshless.filter((o) => o.kind === 'NetworkPolicy').map((o) => o.metadata?.name)), sorted(WORKLOADS.map((w) => `${w}-ports`)), 'meshless의 NetworkPolicy');
  for (const w of WORKLOADS) {
    const nps = nodePolicies(mesh, w);
    assert.equal(nps.length, 1, `${w} 파드를 고르는 노드 프록시 정책이 하나가 아니다(${nps.map((p) => p.metadata?.name)})`);
    assert.deepEqual(nps[0].spec?.selector?.matchLabels, serviceLabels(w), `${w}-ports 고르개`);
    assert.equal(nps[0].spec?.action, 'ALLOW', `${w}-ports action`);
    const np = meshless.find((o) => o.kind === 'NetworkPolicy' && o.metadata?.name === `${w}-ports`);
    assert.deepEqual(np.spec?.podSelector, { matchLabels: serviceLabels(w) }, `meshless ${w}-ports 고르개`);
    assert.deepEqual(np.spec?.policyTypes, ['Ingress'], `meshless ${w}-ports policyTypes`);
  }
  for (const p of mesh.filter((o) => o.kind === 'AuthorizationPolicy'))
    for (const r of p.spec?.rules ?? []) {
      assert.deepEqual(sorted(Object.keys(r)), ['from', 'to'], `${p.metadata?.name}: 규칙에 from·to 밖의 칸이 있거나 빠졌다 ${JSON.stringify(r)}`);
      assert.ok(Array.isArray(r.from) && r.from.length > 0, `${p.metadata?.name}: 빈 from(모든 출처)`);
      for (const f of r.from) {
        assert.deepEqual(Object.keys(f.source ?? {}), ['principals'], `${p.metadata?.name}: 출처는 principals뿐이다(namespaces·ipBlocks 없음) ${JSON.stringify(f)}`);
        assert.ok(f.source.principals.length > 0 && f.source.principals.every((x) => !String(x).includes('*')), `${p.metadata?.name}: 빈 주체나 '*'`);
      }
      assert.ok(Array.isArray(r.to) && r.to.length > 0, `${p.metadata?.name}: 빈 to(모든 포트·경로)`);
      for (const t of r.to) {
        const op = t.operation ?? {};
        assert.ok((Array.isArray(op.ports) && op.ports.length > 0) || (Array.isArray(op.paths) && op.paths.length > 0), `${p.metadata?.name}: 포트·경로가 빠진 to ${JSON.stringify(t)}`);
      }
    }
  for (const np of meshless.filter((o) => o.kind === 'NetworkPolicy'))
    for (const r of np.spec?.ingress ?? []) {
      assert.ok(Array.isArray(r.from) && r.from.length > 0, `${np.metadata?.name}: from 없는 규칙(모든 출처)`);
      assert.ok(Array.isArray(r.ports) && r.ports.length > 0, `${np.metadata?.name}: ports 없는 규칙(모든 포트)`);
      for (const p of r.ports) assert.ok(p.protocol === 'TCP' && typeof p.port === 'number' && p.endPort === undefined, `${np.metadata?.name}: 포트 칸 ${JSON.stringify(p)}`);
    }
  // 받는 것 전체가 정본 표와 같다(정본 밖 포트·신원은 받지 않는다)
  const wantP = expectedPrincipals();
  const wantC = expectedCallers();
  for (const w of WORKLOADS) {
    const allow = meshNodeAllow(mesh, w);
    const ports = [...allow.keys()];
    assert.ok(!ports.includes(ALL), `policies.yaml ${w}: 포트가 빠진 규칙(모든 포트)`);
    const extra = OPTIONAL_METRICS.includes(w) ? [String(METRICS_PORT)] : [];
    assert.deepEqual(sorted(ports.filter((p) => !extra.includes(p))), sorted([...wantP.get(w).keys()].map(String)), `policies.yaml ${w}의 받는 포트`);
    for (const [port, set] of wantP.get(w)) assert.deepEqual(sorted(allowedOn(allow, port)), sorted(set), `policies.yaml ${w}:${port}`);
    if (ports.includes(String(METRICS_PORT)) && OPTIONAL_METRICS.includes(w)) assert.deepEqual(sorted(allowedOn(allow, METRICS_PORT)), [principalOf('prometheus')], `${w} 지표 포트`);
    for (const port of ALL_PORTS) {
      const want = wantC.get(w).get(port);
      if (OPTIONAL_METRICS.includes(w) && port === METRICS_PORT) {
        const got = meshlessCallerNames(meshless, w, port);
        assert.ok(got.length === 0 || show(got) === JSON.stringify(['prometheus']), `meshless ${w} 지표 포트 ${show(got)}`);
        continue;
      }
      assert.deepEqual(sorted(meshlessCallerNames(meshless, w, port)), sorted(want ?? []), `meshless ${w}:${port}의 부르는 쪽`);
      assert.deepEqual(meshlessOutsidersIn(meshless, w, port), [], `meshless ${w}:${port}에 목록 밖 파드`);
    }
  }
});

// ===================== MS-11 웨이포인트·디스커버리 =====================

test('MS-11 웨이포인트와 디스커버리: 업무 gRPC 워크로드마다 <워크로드>-waypoint(istio-waypoint·15008 HBONE·waypoint-for service)와 업무 gRPC 포트 하나만 내는 <워크로드>-grpc Service(use-waypoint)가 있고 웨이포인트 정책이 그 웨이포인트를 가리킨다. 그 밖에는 웨이포인트·use-waypoint가 없다', () => {
  const mesh = meshObjects();
  for (const w of GRPC_RECEIVERS) {
    const ns = NAMESPACE_OF[w];
    const gws = mesh.filter((o) => o.kind === 'Gateway' && o.metadata?.name === `${w}-waypoint`);
    assert.equal(gws.length, 1, `${w}-waypoint`);
    const g = gws[0];
    assert.equal(g.apiVersion, 'gateway.networking.k8s.io/v1');
    assert.equal(g.metadata.namespace, ns, `${w}-waypoint 네임스페이스`);
    assert.equal(g.spec?.gatewayClassName, 'istio-waypoint');
    assert.equal(g.metadata?.labels?.['istio.io/waypoint-for'], 'service', `${w}-waypoint waypoint-for`);
    assert.deepEqual(g.spec?.listeners, [{ name: 'mesh', port: 15008, protocol: 'HBONE' }], `${w}-waypoint 듣는 곳`);
    const svcs = mesh.filter((o) => o.kind === 'Service' && o.metadata?.name === `${w}-grpc`);
    assert.equal(svcs.length, 1, `${w}-grpc`);
    const s = svcs[0];
    assert.equal(s.metadata.namespace, ns, `${w}-grpc 네임스페이스`);
    assert.equal(s.metadata?.labels?.['istio.io/use-waypoint'], `${w}-waypoint`, `${w}-grpc use-waypoint`);
    assert.deepEqual(s.spec?.selector, serviceLabels(w), `${w}-grpc 고르개(차트 서비스 파드 라벨)`);
    assert.notEqual(s.spec?.clusterIP, 'None', `${w}-grpc는 헤드리스가 아니다`);
    assert.equal((s.spec?.ports ?? []).length, 1, `${w}-grpc는 포트 하나(REST·제어·지표를 내지 않는다)`);
    const [p] = s.spec.ports;
    assert.deepEqual([p.name, p.port, p.targetPort ?? p.port, p.appProtocol, p.protocol ?? 'TCP'], ['grpc', GRPC_PORT(w), GRPC_PORT(w), 'grpc', 'TCP'], `${w}-grpc 포트`);
    const wps = waypointPolicies(mesh, w);
    assert.equal(wps.length, 1, `${w} 웨이포인트 정책`);
    assert.equal(wps[0].metadata?.name, `${w}-waypoint-callers`);
    assert.deepEqual(wps[0].spec?.targetRefs, [{ group: 'gateway.networking.k8s.io', kind: 'Gateway', name: `${w}-waypoint` }], `${w}-waypoint-callers targetRefs`);
    assert.equal(wps[0].spec?.selector, undefined, `${w}-waypoint-callers는 고르개를 쓰지 않는다`);
  }
  for (const w of WORKLOADS.filter((x) => !GRPC_RECEIVERS.includes(x))) {
    for (const name of [`${w}-waypoint`, `${w}-grpc`, `${w}-waypoint-callers`]) assert.ok(!mesh.some((o) => o.metadata?.name === name), `업무 gRPC가 없는 ${w}에 ${name}`);
  }
  assert.equal(mesh.filter((o) => o.kind === 'Gateway').length, GRPC_RECEIVERS.length, 'policies.yaml의 웨이포인트 수');
  assert.equal(mesh.filter((o) => o.kind === 'Service').length, GRPC_RECEIVERS.length, 'policies.yaml의 Service 수');
  // 웨이포인트 정책은 모두 웨이포인트를 가리킨다(다른 대상·고르개 없는 targetRefs 없음)
  for (const p of mesh.filter((o) => o.kind === 'AuthorizationPolicy' && o.spec?.targetRefs))
    assert.ok(p.spec.targetRefs.every((t) => t.kind === 'Gateway' && GRPC_RECEIVERS.some((w) => t.name === `${w}-waypoint`)), `${p.metadata?.name}: 웨이포인트가 아닌 대상 ${JSON.stringify(p.spec.targetRefs)}`);
  // deploy/ 아래 다른 곳(기본 Service·네임스페이스·차트)에 use-waypoint가 없다(기본 Service에 붙이면 내부 HTTP가 웨이포인트를 지난다, ADR-0285 결정 5)
  const others = deployTexts().filter((x) => x.file !== POLICIES);
  assert.ok(others.length > 10, 'deploy/ 아래 YAML을 읽지 못했다');
  for (const { file, text } of others) assert.doesNotMatch(text, /istio\.io\/use-waypoint/, `${rel(file)}에 istio.io/use-waypoint`);
});

test('MS-11 배포 값: deploy/workloads/*/values.yaml의 PEAKET_*_GRPC_URL은 모두 <업무 gRPC 워크로드>-grpc:<그 포트>다(ops-svc의 PEAKET_IDENTITY_GRPC_URL은 identity-svc-grpc:50051, ADR-0285 결정 5)', () => {
  const files = walk(join(REPO, 'deploy', 'workloads'), (f) => /values\.ya?ml$/.test(f));
  assert.ok(files.length > 0, 'deploy/workloads/*/values.yaml이 없다');
  const found = [];
  const visit = (v, path, file) => {
    if (Array.isArray(v)) v.forEach((x, i) => visit(x, `${path}[${i}]`, file));
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        if (/^PEAKET_[A-Z0-9_]+_GRPC_(URL|ADDR)$/.test(k)) found.push({ file: rel(file), key: `${path}.${k}`, value: x });
        visit(x, `${path}.${k}`, file);
      }
  };
  for (const f of files) visit(parse(readFileSync(f, 'utf8')) ?? {}, '', f);
  assert.ok(found.length > 0, '업무 gRPC 주소 값을 하나도 찾지 못했다');
  for (const { file, key, value } of found) {
    const m = /^([a-z0-9-]+)-grpc:(\d+)$/.exec(String(value));
    assert.ok(m, `${file} ${key}: ${JSON.stringify(value)}는 <워크로드>-grpc:<포트>가 아니다(기본 Service로 부르면 웨이포인트를 지나지 않는다)`);
    assert.ok(GRPC_RECEIVERS.includes(m[1]), `${file} ${key}: ${m[1]}는 업무 gRPC를 받는 워크로드가 아니다`);
    assert.equal(Number(m[2]), GRPC_PORT(m[1]), `${file} ${key}: ${m[1]}의 업무 gRPC 포트`);
  }
  const ops = found.find((x) => x.file === 'deploy/workloads/ops-svc/values.yaml' && x.key.endsWith('.PEAKET_IDENTITY_GRPC_URL'));
  assert.equal(ops?.value, 'identity-svc-grpc:50051', 'ops-svc의 PEAKET_IDENTITY_GRPC_URL');
});

// ===================== MS-12·13·14·15 메시 바탕 =====================

test('MS-12 RV-03 STRICT: deploy/ 아래(YAML·템플릿·JSON) 주석 밖에 PeerAuthentication이 나오는 파일은 peer-authentication.yaml 하나이고 그 안은 istio-system의 default 하나(mode STRICT, 고르개·portLevelMtls 없음)다. mode PERMISSIVE·DISABLE·UNSET은 어느 꼴(줄 끝 주석·흐름 꼴·JSON)로도 없다', () => {
  const files = deployTexts();
  assert.ok(files.length > 10, 'deploy/ 아래 매니페스트를 읽지 못했다');
  // 줄 모양(kind: 앞뒤 고정)에 기대지 않는다: 줄 끝 주석 꼴 'kind: PeerAuthentication # 메모', 흐름 꼴 '{ kind: PeerAuthentication, … }', JSON도 센다(리뷰 RV-03)
  const holders = files.filter((x) => /PeerAuthentication/.test(x.text));
  assert.deepEqual(holders.map((x) => rel(x.file)), ['deploy/platform/mesh/peer-authentication.yaml'], 'PeerAuthentication이 있는 파일');
  // YAML은 문서로도 읽어 kind를 본다(글 찾기를 비켜 간 꼴이 남지 않게)
  for (const { file } of files.filter((x) => /\.ya?ml$/.test(x.file))) {
    let docs;
    try {
      docs = parseAllDocuments(readFileSync(file, 'utf8')).map((d) => d.toJS());
    } catch {
      continue;
    }
    if (file !== PEER_AUTH) assert.ok(!docs.some((o) => o?.kind === 'PeerAuthentication'), `${rel(file)}에 PeerAuthentication 객체`);
  }
  const pas = objectsOf(PEER_AUTH).filter((o) => o.kind === 'PeerAuthentication');
  assert.equal(pas.length, 1, 'PeerAuthentication 수');
  const [pa] = pas;
  assert.equal(pa.apiVersion, 'security.istio.io/v1');
  assert.deepEqual([pa.metadata?.namespace, pa.metadata?.name], ['istio-system', 'default']);
  assert.deepEqual(pa.spec, { mtls: { mode: 'STRICT' } }, '고르개·portLevelMtls 없이 STRICT 하나');
  // 줄 앞에 묶지 않는다: 'mtls: { mode: PERMISSIVE }', '"mode": "DISABLE"'도 잡는다(리뷰 RV-03)
  for (const { file, text } of files) assert.doesNotMatch(text, /["']?\bmode["']?\s*:\s*["']?(PERMISSIVE|DISABLE|UNSET)\b/, `${rel(file)}에 mTLS를 푸는 mode`);
});

test('MS-20 RV-02 V26 다른 인가 정책·NetworkPolicy 없음: deploy/ 아래(YAML·템플릿·JSON) 주석 밖에 AuthorizationPolicy가 나오는 파일은 policies.yaml 하나, NetworkPolicy 객체를 두는 파일은 meshless 파일과 공용 차트 템플릿뿐이다(둘 다 받는 쪽은 합집합이라 다른 파일의 정책 하나가 표를 넓힌다)', () => {
  const files = deployTexts();
  assert.ok(files.length > 10, 'deploy/ 아래 매니페스트를 읽지 못했다');
  const holders = files.filter((x) => /AuthorizationPolicy/.test(x.text)).map((x) => rel(x.file));
  assert.deepEqual(holders, ['deploy/platform/mesh/policies.yaml'], 'AuthorizationPolicy가 있는 파일');
  // 검증 V26: kind 칸을 줄 모양에 기대지 않고 찾는다(줄 끝 주석·흐름 꼴·JSON). 공용 차트의 NetworkPolicy와의 합집합은 정리 목록(리뷰 RV-10)
  const np = files.filter((x) => /\bkind["']?\s*:\s*["']?NetworkPolicy\b/.test(x.text)).map((x) => rel(x.file));
  assert.deepEqual(np.filter((f) => !f.startsWith('deploy/charts/peaket-service/templates/')), ['deploy/platform/mesh/meshless-networkpolicies.yaml'], 'NetworkPolicy가 있는 파일(차트 템플릿 밖)');
});

test('MS-13 V13 V14 최소 TLS 1.3: istiod 값이 정확히 meshConfig.trustDomain: cluster.local과 meshMTLS.minProtocolVersion: TLSV1_3이고(다른 기본값 덮어쓰기 없음, ADR-0285 결정 10), deploy/ 아래에 다른 최소 판·istio-system 밖의 rootNamespace·trustDomainAliases가 없다', () => {
  assert.ok(existsSync(ISTIOD_VALUES), `${rel(ISTIOD_VALUES)}가 없다`);
  const v = parse(readFileSync(ISTIOD_VALUES, 'utf8'));
  assert.equal(v?.meshConfig?.meshMTLS?.minProtocolVersion, 'TLSV1_3');
  assert.equal(v?.meshConfig?.trustDomain, 'cluster.local');
  // 검증 V13·V14: 뿌리 네임스페이스를 옮기면 istio-system의 default STRICT가 메시 전체가 아니게 되고, 신뢰 도메인 별칭은 다른 도메인 신원을 같은 주체로 받는다
  assert.deepEqual(v, { meshConfig: { trustDomain: 'cluster.local', meshMTLS: { minProtocolVersion: 'TLSV1_3' } } }, 'istiod 값은 두 칸뿐이다');
  for (const { file, text } of deployTexts()) {
    for (const m of text.matchAll(/minProtocolVersion["']?\s*:\s*["']?(\w+)/g)) assert.equal(m[1], 'TLSV1_3', `${rel(file)}의 minProtocolVersion`);
    for (const m of text.matchAll(/rootNamespace["']?\s*:\s*["']?([\w-]+)/g)) assert.equal(m[1], 'istio-system', `${rel(file)}의 rootNamespace`);
    assert.doesNotMatch(text, /trustDomainAliases/, `${rel(file)}에 trustDomainAliases`);
  }
});

test('MS-14 V17 V18 cacerts: ExternalSecret이 istio-system에 Secret cacerts를 키 넷으로 만들고(ClusterSecretStore aws-secrets-manager, 경로는 자리 표시 그대로 peaket/<환경>/mesh/cacerts), deploy/ 아래 그 경로를 읽는 것은 이것 하나이며, 메시 폴더 어디에도 kind: Secret·stringData·PEM 글이 없다', () => {
  const objs = objectsOf(CACERTS);
  assert.equal(objs.length, 1, 'cacerts.yaml의 객체는 ExternalSecret 하나');
  const [es] = objs;
  assert.deepEqual([es.apiVersion, es.kind, es.metadata?.namespace], ['external-secrets.io/v1', 'ExternalSecret', 'istio-system']);
  assert.equal(es.spec?.target?.name, 'cacerts', '대상 Secret 이름');
  assert.deepEqual(es.spec?.secretStoreRef, { kind: 'ClusterSecretStore', name: 'aws-secrets-manager' });
  assert.equal(es.spec?.dataFrom, undefined, 'dataFrom으로 다른 칸을 끌어오지 않는다');
  const data = es.spec?.data ?? [];
  assert.deepEqual(sorted(data.map((d) => d.secretKey)), sorted(CACERTS_KEYS), '받는 키 넷');
  assert.equal(data.length, CACERTS_KEYS.length, '같은 키를 두 번 받지 않는다');
  for (const d of data) {
    // 검증 V18: 바탕 파일은 환경 이름을 박지 않는다(<환경> 자리는 환경 오버레이가 채운다, ADR-0285 결정 12, docs/security/secrets-and-keys.md '서비스 메시 중간 CA')
    assert.equal(d.remoteRef?.key, 'peaket/<환경>/mesh/cacerts', `${d.secretKey}의 비밀 저장소 경로`);
    assert.equal(d.remoteRef?.property, d.secretKey, `${d.secretKey}는 같은 이름 칸에서 받는다`);
  }
  // 검증 V17: 메시 중간 CA 경로를 다른 네임스페이스로 끌어오는 ExternalSecret이 없다(접근은 istiod(istio-system)만)
  const texts = deployTexts();
  assert.deepEqual(
    texts.filter((x) => /mesh\/cacerts/.test(x.text)).map((x) => rel(x.file)),
    ['deploy/platform/mesh/cacerts.yaml'],
    '주석 밖에 mesh/cacerts 경로가 있는 파일',
  );
  const readers = [];
  for (const { file } of texts.filter((x) => /\.ya?ml$/.test(x.file))) {
    let docs = [];
    try {
      docs = parseAllDocuments(readFileSync(file, 'utf8')).map((d) => d.toJS());
    } catch {
      continue;
    }
    for (const o of docs)
      if (o?.kind === 'ExternalSecret' && JSON.stringify(o.spec ?? {}).includes('mesh/cacerts')) readers.push(`${o.metadata?.namespace}/${o.metadata?.name}`);
  }
  assert.deepEqual(readers, ['istio-system/cacerts'], 'mesh/cacerts를 읽는 ExternalSecret');
  const files = walk(MESH, (f) => /\.(ya?ml|json)$/.test(f) && !f.startsWith(HERE));
  assert.ok(files.length >= 6, '메시 폴더의 매니페스트를 읽지 못했다');
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /^\s*kind:\s*["']?Secret["']?\s*$/m, `${rel(f)}에 Secret 객체`);
    assert.doesNotMatch(text, /stringData/, `${rel(f)}에 stringData`);
    assert.doesNotMatch(text, /-----BEGIN/, `${rel(f)}에 PEM 글`);
  }
});

test('MS-15 V15 앰비언트 등록: namespaces.yaml이 ADR-0285 결정 10의 네임스페이스 열에 istio.io/dataplane-mode: ambient를 달고, 워크로드·부르는 쪽 네임스페이스가 모두 그 안에 있으며 istio-system·kube-system은 없다. deploy/ 아래 다른 곳(차트 템플릿 포함)에는 dataplane-mode 라벨이 없다', () => {
  // 검증 V15: 파드·Service에 istio.io/dataplane-mode: none을 달면 그 파드가 앰비언트에서 빠져 STRICT·인가 정책을 모두 건너뛴다
  const texts = deployTexts();
  assert.deepEqual(
    texts.filter((x) => /istio\.io\/dataplane-mode/.test(x.text)).map((x) => rel(x.file)),
    ['deploy/platform/mesh/namespaces.yaml'],
    '주석 밖에 istio.io/dataplane-mode가 있는 파일',
  );
  for (const { text } of texts) for (const m of text.matchAll(/istio\.io\/dataplane-mode["']?\s*:\s*["']?([\w-]+)/g)) assert.equal(m[1], 'ambient', 'istio.io/dataplane-mode 값');
  const objs = objectsOf(NAMESPACES);
  assert.ok(objs.every((o) => o.kind === 'Namespace' && o.apiVersion === 'v1'), 'Namespace 밖의 객체');
  assert.deepEqual(sorted(objs.map((o) => o.metadata?.name)), sorted(AMBIENT_NAMESPACES), '등록 네임스페이스');
  for (const o of objs) {
    assert.equal(o.metadata?.labels?.['istio.io/dataplane-mode'], 'ambient', `${o.metadata?.name}의 앰비언트 라벨`);
    assert.equal(o.metadata?.labels?.['istio-injection'], undefined, `${o.metadata?.name}에 사이드카 주입 라벨`);
  }
  const names = new Set(objs.map((o) => o.metadata?.name));
  for (const ns of new Set(Object.values(IDENTITY).map((i) => i.namespace))) assert.ok(names.has(ns), `${ns}가 앰비언트에 등록되지 않았다`);
  for (const ns of ['istio-system', 'kube-system']) assert.ok(!names.has(ns), `${ns}에 앰비언트 라벨`);
});

// ===================== MS-16·17·18·19 =====================

test('MS-16 포트 번호: 규칙의 포트가 ADR-0285 결정 6과 같고(REST 8080·web 3000·partner 3001, 지표 9464, 업무 gRPC 50051·ticket-svc 50052, 제어 50061), 배포 단위 값의 service.port·managementPort가 같다', () => {
  const mesh = meshObjects();
  const meshless = meshlessObjects();
  const wantPorts = (w) => {
    const s = new Set();
    if (REST_RECEIVERS.includes(w)) s.add(REST_PORT(w));
    if (GRPC_RECEIVERS.includes(w)) s.add(GRPC_PORT(w));
    if (CONTROL_RECEIVERS.includes(w)) s.add(CONTROL_PORT);
    if (METRICS_RECEIVERS.includes(w) || OPTIONAL_METRICS.includes(w)) s.add(METRICS_PORT);
    return s;
  };
  for (const w of WORKLOADS) {
    const ok = wantPorts(w);
    for (const port of meshNodeAllow(mesh, w).keys()) assert.ok(ok.has(Number(port)), `policies.yaml ${w}의 정본 밖 포트 ${port}`);
    const np = meshless.find((o) => o.kind === 'NetworkPolicy' && o.metadata?.name === `${w}-ports`);
    for (const r of np?.spec?.ingress ?? []) for (const p of r.ports ?? []) assert.ok(ok.has(p.port), `meshless ${w}의 정본 밖 포트 ${p.port}`);
  }
  assert.ok(meshNodeAllow(mesh, 'ticket-svc').has('50052'), 'ticket-svc 업무 gRPC는 50052');
  assert.ok(!meshNodeAllow(mesh, 'ticket-svc').has('50051'), 'ticket-svc에 50051');
  assert.equal(mesh.find((o) => o.kind === 'Service' && o.metadata?.name === 'ticket-svc-grpc')?.spec?.ports?.[0]?.port, 50052);
  let seen = 0;
  for (const f of walk(join(REPO, 'deploy', 'workloads'), (x) => /values\.ya?ml$/.test(x))) {
    const w = rel(f).split('/')[2];
    if (!WORKLOADS.includes(w)) continue;
    const v = parse(readFileSync(f, 'utf8')) ?? {};
    if (v.service?.port !== undefined) {
      assert.equal(v.service.port, REST_PORT(w), `${rel(f)} service.port`);
      seen++;
    }
    if (v.managementPort !== undefined) {
      assert.equal(v.managementPort, METRICS_PORT, `${rel(f)} managementPort`);
      seen++;
    }
  }
  assert.ok(seen >= 2, 'ops-svc 배포 단위 값의 포트를 읽지 못했다');
});

test('MS-17 이름·라벨: 두 생성 파일의 모든 객체에 peaket.io/generated-by: mesh-policies와 peaket.io/workload가 있고 이름이 ADR-0285 결정 3 꼴, 네임스페이스가 네임스페이스 지도와 같으며 파일 머리에 생성 파일 표시가 있다', () => {
  const kinds = { AuthorizationPolicy: ['-ports', '-waypoint-callers'], Gateway: ['-waypoint'], Service: ['-grpc'], NetworkPolicy: ['-ports'] };
  for (const [file, objs, allowed] of [
    [POLICIES, meshObjects(), ['AuthorizationPolicy', 'Gateway', 'Service']],
    [MESHLESS, meshlessObjects(), ['NetworkPolicy']],
  ]) {
    const head = readFileSync(file, 'utf8').split('\n')[0];
    assert.match(head, /^# 생성 파일이다\. 손으로 고치지 않는다/, `${rel(file)} 첫 줄`);
    assert.ok(head.includes('node tools/ci/mesh-policies.mjs --write') && head.includes('deploy/platform/mesh/port-allow.yaml'), `${rel(file)} 첫 줄에 원천과 만드는 명령`);
    for (const o of objs) {
      const n = o.metadata?.name;
      assert.ok(allowed.includes(o.kind), `${rel(file)}: 다루지 않는 종류 ${o.kind}/${n}`);
      const w = o.metadata?.labels?.[WORKLOAD_LABEL];
      assert.equal(o.metadata?.labels?.[GENERATED_BY_LABEL], 'mesh-policies', `${n}: ${GENERATED_BY_LABEL}`);
      assert.ok(WORKLOADS.includes(w), `${n}: ${WORKLOAD_LABEL} ${w}`);
      assert.ok(kinds[o.kind].some((suffix) => n === `${w}${suffix}`), `${o.kind}/${n}: 이름이 <워크로드>${kinds[o.kind].join('|')}가 아니다`);
      assert.equal(o.metadata?.namespace, NAMESPACE_OF[w], `${n}의 네임스페이스`);
    }
  }
  // 게이트웨이 프록시 주체의 이름 규칙(docs/infra.md §9 예)을 이 시험이 바르게 옮겼나
  assert.equal(gatewayServiceAccount('gw-fan'), 'envoy-envoy-gateway-system-gw-fan-2f99f311');
});

test('MS-18 메시 없는 출처 칸의 꼴: 다른 네임스페이스의 부르는 쪽은 한 칸 안에 namespaceSelector와 podSelector가 함께 있고, podSelector만인 칸은 없으며, 네임스페이스만인 칸은 제어 포트의 비상 런북 Job뿐이다', () => {
  const meshless = meshlessObjects();
  let peers = 0;
  for (const np of meshless.filter((o) => o.kind === 'NetworkPolicy'))
    for (const r of np.spec?.ingress ?? [])
      for (const peer of r.from ?? []) {
        peers++;
        const where = `${np.metadata?.name} ${JSON.stringify(r.ports)} ${JSON.stringify(peer)}`;
        assert.equal(peer.ipBlock, undefined, `${where}: ipBlock`);
        assert.ok(peer.namespaceSelector, `${where}: namespaceSelector가 없다(podSelector만이면 같은 네임스페이스만 맞는다)`);
        assert.deepEqual(Object.keys(peer.namespaceSelector), ['matchLabels'], `${where}: namespaceSelector 꼴`);
        const ns = peer.namespaceSelector.matchLabels?.[NAME_LABEL];
        assert.deepEqual(Object.keys(peer.namespaceSelector.matchLabels ?? {}), [NAME_LABEL], `${where}: 네임스페이스는 ${NAME_LABEL} 하나로 고른다`);
        if (!peer.podSelector) {
          assert.equal(ns, 'ops-breakglass', `${where}: 네임스페이스만인 칸`);
          assert.deepEqual(r.ports.map((p) => p.port), [CONTROL_PORT], `${where}: 네임스페이스만인 칸은 제어 포트에만`);
        } else {
          assert.ok(Object.keys(peer.podSelector.matchLabels ?? {}).length > 0 && !peer.podSelector.matchExpressions, `${where}: 빈 podSelector(네임스페이스의 모든 파드)`);
          // 검증 V09: 출처 칸의 (네임스페이스, 파드 라벨)은 신원 표(ADR-0285 결정 7)의 한 부르는 쪽과 정확히 같다(라벨을 하나 빼면 릴레이·작업 파드까지 고른다)
          const who = Object.entries(IDENTITY).filter(([n, i]) => n !== 'ops-breakglass' && i.namespace === ns && JSON.stringify(sorted(Object.entries(i.podLabels).map(String))) === JSON.stringify(sorted(Object.entries(peer.podSelector.matchLabels).map(String))));
          assert.equal(who.length, 1, `${where}: 신원 표의 어느 부르는 쪽과도 (네임스페이스, 라벨)이 정확히 같지 않다`);
        }
      }
  assert.ok(peers > 50, `출처 칸이 너무 적다(${peers})`);
});

test('MS-19 내부 HTTP 부르는 쪽: ADR-0285 결정 9 표의 16쌍(2026-11-22 보충 포함)과 ADR-0288 결정 8·ADR-0353의 두 쌍(18쌍)마다 받는 쪽 REST 규칙에 부르는 쪽이 있고, 표에 없는 서비스 신원은 REST 규칙에 없다(게이트웨이 빼고)', () => {
  const mesh = meshObjects();
  const meshless = meshlessObjects();
  assert.equal(INTERNAL_HTTP.length, 18);
  for (const [from, to] of INTERNAL_HTTP) {
    assert.ok(allowedOn(meshNodeAllow(mesh, to), REST_PORT(to)).has(principalOf(from)), `policies.yaml ${to} REST에 ${from}가 없다`);
    assert.equal(meshlessAllows(meshless, to, REST_PORT(to), IDENTITY[from]), true, `meshless ${to} REST에 ${from}가 닿지 못한다`);
  }
  for (const w of REST_RECEIVERS) {
    const want = sorted(INTERNAL_HTTP.filter(([, to]) => to === w).map(([from]) => from));
    const got = [...allowedOn(meshNodeAllow(mesh, w), REST_PORT(w))].map((p) => nameOfPrincipal.get(p) ?? p).filter((n) => !GATEWAYS.includes(n));
    assert.deepEqual(sorted(got), want, `policies.yaml ${w} REST의 게이트웨이 밖 신원`);
    const gotNl = meshlessCallerNames(meshless, w, REST_PORT(w)).filter((n) => !GATEWAYS.includes(n));
    assert.deepEqual(sorted(gotNl), want, `meshless ${w} REST의 게이트웨이 밖 신원`);
  }
});

// ===================== BAT-057 S7(계획 §6): purchase-svc → queue-svc 입장 토큰 공개키 묶음 =====================

test('PRF-050 PRF-137 ADR-0288 결정 8 생성 정책이 purchase-svc의 queue-svc 앱 포트(8080) 호출을 메시·메시 없는 둘 다 허용하고, 업무 gRPC·제어·지표 포트는 허용하지 않는다', () => {
  const mesh = meshObjects();
  const meshless = meshlessObjects();
  const allow = meshNodeAllow(mesh, 'queue-svc');
  assert.ok(allowedOn(allow, REST_PORT('queue-svc')).has(principalOf('purchase-svc')), 'policies.yaml queue-svc REST에 purchase-svc가 없다');
  assert.equal(meshlessAllows(meshless, 'queue-svc', REST_PORT('queue-svc'), IDENTITY['purchase-svc']), true, 'meshless queue-svc REST에 purchase-svc가 닿지 못한다');
  for (const port of [GRPC_PORT('queue-svc'), CONTROL_PORT, METRICS_PORT]) {
    assert.ok(!allowedOn(allow, port).has(principalOf('purchase-svc')), `policies.yaml queue-svc ${port}에 purchase-svc가 닿는다`);
    assert.equal(meshlessAllows(meshless, 'queue-svc', port, IDENTITY['purchase-svc']), false, `meshless queue-svc ${port}에 purchase-svc가 닿는다`);
  }
});

// ===================== W12M-01 배상 송금 메서드 단위·purchase-svc → payment-svc REST(계획 docs/review/plans/W12-mesh.md §3) =====================

const COMP_SVC = 'peaket.payment.v1.CompensationTransferService';

test('W12M-01 ① 배상 송금은 메서드 단위다: payment-svc 웨이포인트의 RequestCompensationTransfer는 purchase-svc 주체 하나뿐(ops-svc·core-svc·web·게이트웨이 다섯 없음), GetCompensationTransfer는 받는 주체 0이고, 어느 규칙에도 서비스 통째 경로가 없다(ADR-0317 결정 1, docs/api/proto/README.md §3)', () => {
  const mesh = meshObjects();
  // 정본 proto의 메서드 둘(새 메서드가 생기면 정본에서 부르는 쪽을 찾아 이 시험을 고친다)
  assert.deepEqual(sorted(protos().get(COMP_SVC)?.methods ?? []), ['GetCompensationTransfer', 'RequestCompensationTransfer'], `${COMP_SVC}의 proto 메서드`);
  const req = waypointAllowed(mesh, 'payment-svc', `/${COMP_SVC}/RequestCompensationTransfer`);
  assert.deepEqual(sorted(req), [principalOf('purchase-svc')], 'RequestCompensationTransfer의 주체');
  for (const n of ['ops-svc', 'core-svc', 'web', 'payment-svc', 'identity-svc', ...GATEWAYS]) assert.ok(!req.has(principalOf(n)) && !req.has(ALL), `RequestCompensationTransfer에 ${n}`);
  assert.deepEqual(sorted(waypointAllowed(mesh, 'payment-svc', `/${COMP_SVC}/GetCompensationTransfer`)), [], 'GetCompensationTransfer를 받는 주체가 있다(부르는 쪽 없음)');
  const wide = [];
  for (const p of mesh.filter((o) => o.kind === 'AuthorizationPolicy'))
    for (const r of p.spec?.rules ?? []) for (const t of r.to ?? []) for (const pat of t.operation?.paths ?? []) if (pat === `/${COMP_SVC}/*`) wide.push(p.metadata?.name);
  assert.deepEqual(wide, [], `/${COMP_SVC}/* 경로 규칙이 있는 정책(서비스 통째로 열면 GetCompensationTransfer까지 열린다)`);
});

test('W12M-01 ② purchase-svc → payment-svc REST: purchase-svc는 payment-svc REST 8080에 메시·메시 없는 둘 다 닿고 제어 50061·지표 9464에는 둘 다 닿지 않으며, purchase-svc 릴레이 파드·이름 라벨만 단 파드는 메시 없는 판에서 payment-svc REST에 닿지 않는다(ADR-0285 결정 9 보충, docs/features/transfer-refund.md §5 \'서킷 연결\')', () => {
  const mesh = meshObjects();
  const meshless = meshlessObjects();
  const allow = meshNodeAllow(mesh, 'payment-svc');
  const rest = REST_PORT('payment-svc');
  assert.equal(rest, 8080);
  assert.ok(allowedOn(allow, rest).has(principalOf('purchase-svc')), 'policies.yaml payment-svc REST에 purchase-svc가 없다');
  assert.equal(meshlessAllows(meshless, 'payment-svc', rest, IDENTITY['purchase-svc']), true, 'meshless payment-svc REST에 purchase-svc가 닿지 못한다');
  for (const port of [CONTROL_PORT, METRICS_PORT]) {
    assert.ok(!allowedOn(allow, port).has(principalOf('purchase-svc')), `policies.yaml payment-svc ${port}에 purchase-svc가 닿는다`);
    assert.equal(meshlessAllows(meshless, 'payment-svc', port, IDENTITY['purchase-svc']), false, `meshless payment-svc ${port}에 purchase-svc가 닿는다`);
  }
  const relay = { namespace: 'purchase', podLabels: { 'app.kubernetes.io/name': 'purchase-svc', 'app.kubernetes.io/component': 'outbox-relay' } };
  const nameOnly = { namespace: 'purchase', podLabels: { 'app.kubernetes.io/name': 'purchase-svc' } };
  assert.equal(meshlessAllows(meshless, 'payment-svc', rest, relay), false, 'meshless payment-svc REST에 purchase-svc 릴레이 파드가 닿는다');
  assert.equal(meshlessAllows(meshless, 'payment-svc', rest, nameOnly), false, 'meshless payment-svc REST에 이름 라벨만 단 purchase-svc 파드가 닿는다');
});
