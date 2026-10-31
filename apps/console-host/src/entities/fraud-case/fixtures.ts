// 부정 거래 조사 목업(합성 값, ADR-0170 퍼블리싱). 회차는 기존 목업 LUMEN 1회차다(entities/event-run과 같은 이름).
// - 계정 ID·가명·사건 ID는 지어낸 값이다. IP는 서버가 주는 가린 값(IPv4 /24, IPv6 /48)만 둔다. 원문은 'IP 원문 열림' 상태 하나(REVEALED_IP)이고
//   문서용 대역(RFC 5737)이다. ASN은 문서용 번호(RFC 5398)다. 점수 원값·가중치는 두지 않는다(범주만, POL-046 ⑦).
// - 시각은 KST ISO 문자열이다. 기준 시각(지금)은 NOW다. 취소 마감은 model.cancelDeadlineAt(EVENT.startsAt)과 같아야 한다(model.test.mjs).
// - 이 파일은 실행 때 가져오는 것이 없다(타입만). 데이터 연결 단계(wbs 7.7)에서 조사 API 응답으로 바꾸고 걷어 낸다.
import type { AppealResult, FraudCaseStatus, FraudLinkKind, FraudReasonCategory, FraudSignal, GraphNodeKind, ScoreBand } from './model';

export const NOW = '2026-10-19T14:20:00+09:00';

export const EVENT = {
  eventId: 'evt-lumen-2026-r1',
  title: 'LUMEN 콘서트 2026 서울',
  round: '1회차',
  startsAt: '2026-10-25T18:00:00+09:00',
  saleStartsAt: '2026-10-14T20:00:00+09:00',
  saleEndsAt: '2026-10-24T18:00:00+09:00',
  entryOpensAt: '2026-10-25T16:00:00+09:00',
  limitPerPerson: 4,
} as const;

/** 회차 고르기 목록(다른 회차는 이름만) */
export const EVENTS = [
  { eventId: EVENT.eventId, label: 'LUMEN 콘서트 2026 서울 · 1회차 10/25(일) 18:00' },
  { eventId: 'evt-aurora-r2', label: 'AURORA 팬미팅 · 2회차 10/18(일) 19:30' },
] as const;

/** 기록 고정 판(fraud_snapshot). 해시는 64자리 16진수 */
export const SNAPSHOT = {
  version: 2,
  frozenAt: '2026-10-18T03:00:00+09:00',
  invHash: '3f9a6c21f5007a3d0ec63862df86bc087dfd5eced982ca27942bb5d09be0c21e',
  generation: 2,
  late: false,
};

export interface Cluster {
  clusterId: string;
  scoreBand: ScoreBand;
  accountCount: number;
  purchaseCount: number;
  sharedAttributes: FraudLinkKind[];
  signals: FraudSignal[];
  caseId: string | null;
  generation: number;
  createdAt: string;
}

export const CLUSTERS: readonly Cluster[] = [
  { clusterId: 'cl-2610-a', scoreBand: 'HIGH', accountCount: 9, purchaseCount: 27, sharedAttributes: ['PAYMENT_METHOD', 'DEVICE', 'CONTACT'], signals: ['LINK_GRAPH', 'VELOCITY'], caseId: 'CASE-2610-0007', generation: 2, createdAt: '2026-10-18T03:20:00+09:00' },
  { clusterId: 'cl-2610-b', scoreBand: 'HIGH', accountCount: 4, purchaseCount: 14, sharedAttributes: ['DEVICE', 'IP'], signals: ['LINK_GRAPH', 'SYNC_STEPS', 'POST_MATCH'], caseId: 'CASE-2610-0004', generation: 2, createdAt: '2026-10-18T03:20:00+09:00' },
  { clusterId: 'cl-2610-f', scoreBand: 'HIGH', accountCount: 6, purchaseCount: 18, sharedAttributes: ['DEVICE', 'PAYMENT_METHOD'], signals: ['LINK_GRAPH', 'VELOCITY'], caseId: 'CASE-2610-0005', generation: 1, createdAt: '2026-10-14T22:40:00+09:00' },
  { clusterId: 'cl-2610-h', scoreBand: 'MEDIUM', accountCount: 3, purchaseCount: 8, sharedAttributes: ['CONTACT', 'ASN'], signals: ['LINK_GRAPH', 'TIMING_BASELINE'], caseId: 'CASE-2610-0003', generation: 1, createdAt: '2026-10-14T22:40:00+09:00' },
  { clusterId: 'cl-2610-c', scoreBand: 'MEDIUM', accountCount: 3, purchaseCount: 10, sharedAttributes: ['IP', 'ASN'], signals: ['LINK_GRAPH', 'SYNC_STEPS'], caseId: null, generation: 2, createdAt: '2026-10-18T03:20:00+09:00' },
  { clusterId: 'cl-2610-g', scoreBand: 'MEDIUM', accountCount: 3, purchaseCount: 9, sharedAttributes: ['IDENTITY_CONFLICT'], signals: ['LINK_GRAPH'], caseId: 'CASE-2610-0001', generation: 1, createdAt: '2026-10-14T22:40:00+09:00' },
  { clusterId: 'cl-2610-e', scoreBand: 'LOW', accountCount: 2, purchaseCount: 6, sharedAttributes: ['IP', 'PAYMENT_METHOD'], signals: ['LINK_GRAPH'], caseId: 'CASE-2610-0002', generation: 1, createdAt: '2026-10-14T22:40:00+09:00' },
  { clusterId: 'cl-2610-d', scoreBand: 'LOW', accountCount: 1, purchaseCount: 2, sharedAttributes: [], signals: ['BYPASS_TRACE'], caseId: null, generation: 2, createdAt: '2026-10-18T03:20:00+09:00' },
];

export interface CaseTimeline {
  /** 소명 요청을 보낸 때(소명 대기 상태 그림의 '지금') */
  appealRequestedAt: string;
  appealDueAt: string;
  actionRequestedAt: string;
  actionedAt: string;
  objectionDueAt: string;
}

export interface FraudCaseFixture {
  caseId: string;
  clusterId: string;
  status: FraudCaseStatus;
  reasonCategory: FraudReasonCategory;
  assignee: string;
  accountCount: number;
  ticketCount: number;
  cancelDeadlineAt: string;
  version: number;
  createdAt: string;
  /** 이 사건의 상태 그림에 쓰는 시각. 사건의 지금 상태보다 뒤의 단계는 목업으로 정한 가상의 시각이다 */
  timeline: CaseTimeline;
  /** 계정별 소명 결과의 수(승인자 사건 요약 appealCounts와 같은 칸) */
  appealCounts: { accepted: number; rejected: number; expired: number; submitted: number; pending: number };
  investigatorOpinion: string;
  /** 사건 메모(지난 메모는 고치지 않는다). 사건 기록에도 남는다 */
  memos: { at: string; who: string; text: string }[];
  /** 외부 게시물마다 이 묶음의 표와 맞은 좌석 수(R6 근거 신호, forensic-replay §6.7.7). 없으면 0 */
  postMatches: Partial<Record<string, number>>;
}

const CANCEL_DEADLINE = '2026-10-24T16:00:00+09:00';

export const CASES: readonly FraudCaseFixture[] = [
  {
    caseId: 'CASE-2610-0007', clusterId: 'cl-2610-a', status: 'INVESTIGATING', reasonCategory: 'LIMIT_EVASION', assignee: '도윤',
    accountCount: 9, ticketCount: 27, cancelDeadlineAt: CANCEL_DEADLINE, version: 3, createdAt: '2026-10-19T14:05:00+09:00',
    timeline: { appealRequestedAt: '2026-10-19T14:20:00+09:00', appealDueAt: '2026-10-22T14:20:00+09:00', actionRequestedAt: '2026-10-22T15:10:00+09:00', actionedAt: '2026-10-23T11:00:00+09:00', objectionDueAt: '2026-11-22T11:00:00+09:00' },
    appealCounts: { accepted: 0, rejected: 6, expired: 3, submitted: 0, pending: 0 },
    investigatorOpinion: '같은 결제 수단 연결값 하나로 9계정이 27장을 샀고, 같은 기기 둘에서 계정을 빠르게 오갔습니다. 소명에서 대리 예매 근거를 찾지 못했습니다.',
    memos: [{ at: '2026-10-19T14:12:00+09:00', who: '도윤', text: '결제 수단 연결값 하나에 9계정이 이어짐. 기기 둘을 번갈아 씀' }],
    postMatches: {},
  },
  {
    caseId: 'CASE-2610-0005', clusterId: 'cl-2610-f', status: 'DECISION_PENDING', reasonCategory: 'MACRO_BOT', assignee: '도윤',
    accountCount: 6, ticketCount: 18, cancelDeadlineAt: CANCEL_DEADLINE, version: 6, createdAt: '2026-10-15T09:40:00+09:00',
    timeline: { appealRequestedAt: '2026-10-15T11:00:00+09:00', appealDueAt: '2026-10-18T11:00:00+09:00', actionRequestedAt: '2026-10-18T13:30:00+09:00', actionedAt: '2026-10-20T10:00:00+09:00', objectionDueAt: '2026-11-19T10:00:00+09:00' },
    appealCounts: { accepted: 0, rejected: 4, expired: 2, submitted: 0, pending: 0 },
    investigatorOpinion: '같은 기기 가명으로 6계정이 판매 시작 1초 안에 입장했고, 소명 넷은 근거가 없어 불인정, 둘은 기한까지 내지 않았습니다.',
    memos: [{ at: '2026-10-15T10:20:00+09:00', who: '도윤', text: '같은 기기 가명으로 6계정이 판매 시작 1초 안에 입장함' }],
    postMatches: {},
  },
  {
    caseId: 'CASE-2610-0004', clusterId: 'cl-2610-b', status: 'APPEAL_PENDING', reasonCategory: 'ACCOUNT_LENDING', assignee: '예린',
    accountCount: 4, ticketCount: 14, cancelDeadlineAt: CANCEL_DEADLINE, version: 4, createdAt: '2026-10-18T10:10:00+09:00',
    timeline: { appealRequestedAt: '2026-10-18T16:00:00+09:00', appealDueAt: '2026-10-21T16:00:00+09:00', actionRequestedAt: '2026-10-21T17:00:00+09:00', actionedAt: '2026-10-22T10:00:00+09:00', objectionDueAt: '2026-11-21T10:00:00+09:00' },
    appealCounts: { accepted: 0, rejected: 0, expired: 0, submitted: 1, pending: 3 },
    investigatorOpinion: '외부 게시물 좌석 2개가 이 묶음의 표와 맞았습니다.',
    memos: [{ at: '2026-10-18T11:05:00+09:00', who: '예린', text: '신고된 게시물(resale.example)의 좌석 2개가 이 묶음 표와 맞음' }],
    postMatches: { 'post-58213': 2 },
  },
  {
    caseId: 'CASE-2610-0003', clusterId: 'cl-2610-h', status: 'OBJECTED', reasonCategory: 'LIMIT_EVASION', assignee: '예린',
    accountCount: 3, ticketCount: 8, cancelDeadlineAt: CANCEL_DEADLINE, version: 9, createdAt: '2026-10-15T08:30:00+09:00',
    timeline: { appealRequestedAt: '2026-10-15T09:00:00+09:00', appealDueAt: '2026-10-16T09:00:00+09:00', actionRequestedAt: '2026-10-16T10:00:00+09:00', actionedAt: '2026-10-16T18:00:00+09:00', objectionDueAt: '2026-11-15T18:00:00+09:00' },
    appealCounts: { accepted: 0, rejected: 3, expired: 0, submitted: 0, pending: 0 },
    investigatorOpinion: '같은 연락처로 3계정이 8장을 샀습니다.',
    memos: [{ at: '2026-10-15T08:45:00+09:00', who: '예린', text: '같은 연락처 가명으로 3계정이 8장을 삼' }],
    postMatches: {},
  },
  {
    caseId: 'CASE-2610-0002', clusterId: 'cl-2610-e', status: 'CLEARED', reasonCategory: 'MACRO_BOT', assignee: '도윤',
    accountCount: 2, ticketCount: 6, cancelDeadlineAt: CANCEL_DEADLINE, version: 5, createdAt: '2026-10-15T08:10:00+09:00',
    timeline: { appealRequestedAt: '2026-10-15T08:30:00+09:00', appealDueAt: '2026-10-16T08:30:00+09:00', actionRequestedAt: '2026-10-16T09:00:00+09:00', actionedAt: '2026-10-16T15:00:00+09:00', objectionDueAt: '2026-11-15T15:00:00+09:00' },
    appealCounts: { accepted: 2, rejected: 0, expired: 0, submitted: 0, pending: 0 },
    investigatorOpinion: '같은 집 공유기 IP를 쓴 가족 둘이 각자 결제했습니다.',
    memos: [],
    postMatches: {},
  },
  {
    caseId: 'CASE-2610-0001', clusterId: 'cl-2610-g', status: 'ACTIONED', reasonCategory: 'ACCOUNT_LENDING', assignee: '예린',
    accountCount: 3, ticketCount: 9, cancelDeadlineAt: CANCEL_DEADLINE, version: 8, createdAt: '2026-10-14T23:00:00+09:00',
    timeline: { appealRequestedAt: '2026-10-15T07:00:00+09:00', appealDueAt: '2026-10-16T07:00:00+09:00', actionRequestedAt: '2026-10-16T08:00:00+09:00', actionedAt: '2026-10-16T10:30:00+09:00', objectionDueAt: '2026-11-15T10:30:00+09:00' },
    appealCounts: { accepted: 0, rejected: 2, expired: 1, submitted: 0, pending: 0 },
    investigatorOpinion: '같은 본인확인으로 다른 계정에서 시도한 기록이 셋 있습니다.',
    memos: [{ at: '2026-10-14T23:20:00+09:00', who: '예린', text: '같은 본인확인으로 다른 계정에서 시도한 기록 셋' }],
    postMatches: {},
  },
];

export const DEFAULT_CASE_ID = 'CASE-2610-0007';

export function getCase(caseId: string): FraudCaseFixture | undefined {
  return CASES.find((c) => c.caseId === caseId);
}

export function getCluster(clusterId: string): Cluster | undefined {
  return CLUSTERS.find((c) => c.clusterId === clusterId);
}

/** 회차 요약(SCR-070 ⑤). 경로가 아직 없어(d5 §1.6 39번) 목업에서 센다 */
export const ROUND_SUMMARY = {
  clusters: CLUSTERS.length,
  cases: CASES.length,
  /** 조치한 표: 조치됨·이의 접수 사건의 표 */
  actionedTickets: 17,
  appealAccepted: 2,
  appealRequested: 18,
};

export interface ExternalPost {
  postId: string;
  url: string;
  site: string;
  capturedAt: string;
  source: 'REPORT' | 'MANUAL';
  reportCaseId?: string;
  claimedSeats: string;
  captureSha256: string;
  scanStatus: 'PENDING' | 'CLEAN' | 'THREAT';
  matchedTicketCount: number;
  registeredBy: string;
}

export const EXTERNAL_POSTS: readonly ExternalPost[] = [
  { postId: 'post-58213', url: 'https://resale.example/post/58213', site: 'resale.example', capturedAt: '2026-10-17T21:40:00+09:00', source: 'REPORT', reportCaseId: 'CS-2610-0418', claimedSeats: 'A구역 3열 14·15번 2연석', captureSha256: '1135d948e5a1115d985989ca2dbe740a39b175c5c13694be937a794796201a16', scanStatus: 'CLEAN', matchedTicketCount: 2, registeredBy: '예린' },
  { postId: 'post-9917', url: 'https://market.example/item/9917', site: 'market.example', capturedAt: '2026-10-19T09:15:00+09:00', source: 'MANUAL', claimedSeats: 'R석 2연석(구역 적지 않음)', captureSha256: '627114179590252736771dd6e6a6c00dd579279f61949256882b7fc6dd3b4d7c', scanStatus: 'PENDING', matchedTicketCount: 0, registeredBy: '도윤' },
];

// ── 연결 그래프(CMP-080 목업) ──

export interface GraphNode {
  /** 사건마다 서버가 만든 무작위 값이라고 보고 지어낸 불투명한 값이다(값에서 계산하지 않는다) */
  nodeId: string;
  kind: GraphNodeKind;
  /** 계정 ID, 가명 앞 8글자, IP의 가린 값, ASN 번호 */
  label: string;
  /** ACCOUNT만: 지금 묶음에 든 계정인지 */
  inCluster?: boolean;
  /** 점 정보 칸에 보이는 덧말(망 분류 등) */
  note?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: FraudLinkKind;
  firstSeenAt: string;
  lastSeenAt: string;
  count: number;
}

export interface CaseGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

// 불투명한 점 ID 목록(지어낸 16진수). 순서대로 나눠 준다
const IDS = ['7c2e91a0', 'b41f0d37', '0e9a6c52', 'f3d17b88', '5a20e4c9', '9be6013f', 'd84c2a71', '26f9b5e3', 'c07d3e1a', '4e81a9f6', 'a19c0b54', '68d2f7e0', 'e5b3416c', '13fa8d29', '8c6e02b7', 'f0a7d5c3', '3b95e81d', 'bd4c7092', '71e0f6a8', '0a3db94e'];

const T0 = '2026-10-14T20:00:01+09:00';
const T1 = '2026-10-14T20:12:40+09:00';

function accountLabel(caseIndex: number, i: number): string {
  const hex = ['3f21', '8a07', 'c19e', '52d4', 'e6b0', '0d7a', '9b35', '4c8f', 'a2e1', '71f6'];
  return `acc-${caseIndex}${hex[i % hex.length]}`;
}

/** 사건 CASE-2610-0007의 그래프: 결제 수단 연결값 1(9계정)·기기 2(4·3계정)·연락처 1(5계정)·IP 2·ASN 1, 묶음 밖 계정 1(새로 이어진 계정) */
function graph0007(): CaseGraph {
  let k = 0;
  const id = () => `n-${IDS[k++ % IDS.length]}`;
  const acc: GraphNode[] = Array.from({ length: 9 }, (_, i) => ({ nodeId: id(), kind: 'ACCOUNT' as const, label: accountLabel(7, i), inCluster: true }));
  const outside: GraphNode = { nodeId: id(), kind: 'ACCOUNT', label: 'acc-7d6e02', inCluster: false, note: '새 후보 계산(판 3)에서 이어진 계정' };
  const pm: GraphNode = { nodeId: id(), kind: 'PAYMENT_METHOD', label: '5a0e2b91', note: '결제 수단 연결값(BIN·끝자리로 만든 약한 값, 9계정이라 강한 연결)' };
  const d1: GraphNode = { nodeId: id(), kind: 'DEVICE', label: 'd7c19e04' };
  const d2: GraphNode = { nodeId: id(), kind: 'DEVICE', label: '2b8f60ac' };
  const ct: GraphNode = { nodeId: id(), kind: 'CONTACT', label: '9c41f7d2', note: '연락처·수령 정보 가명' };
  const ip1: GraphNode = { nodeId: id(), kind: 'IP', label: '203.0.113.0/24', note: '망 분류 그 밖' };
  const ip2: GraphNode = { nodeId: id(), kind: 'IP', label: '198.51.100.0/24', note: '망 분류 호스팅' };
  const asn: GraphNode = { nodeId: id(), kind: 'ASN', label: 'AS64500', note: '호스팅' };
  const nodes = [...acc, outside, pm, d1, d2, ct, ip1, ip2, asn];
  const edges: GraphEdge[] = [];
  const link = (a: GraphNode, b: GraphNode, kind: FraudLinkKind, count = 1) => edges.push({ from: a.nodeId, to: b.nodeId, kind, firstSeenAt: T0, lastSeenAt: T1, count });
  acc.forEach((a) => link(a, pm, 'PAYMENT_METHOD', 3));
  acc.slice(0, 4).forEach((a) => link(a, d1, 'DEVICE', 2));
  acc.slice(4, 7).forEach((a) => link(a, d2, 'DEVICE', 2));
  [0, 1, 2, 5, 7].forEach((i) => link(acc[i]!, ct, 'CONTACT'));
  acc.slice(0, 6).forEach((a) => link(a, ip1, 'IP', 4));
  [6, 7].forEach((i) => link(acc[i]!, ip2, 'IP', 2));
  [1, 3, 5, 8].forEach((i) => link(acc[i]!, asn, 'ASN'));
  link(outside, d2, 'DEVICE');
  link(outside, ip2, 'IP');
  return { nodes, edges, truncated: false };
}

/** 그 밖의 사건: 묶음의 공유 속성마다 점 하나를 두고 묶음 계정 모두와 잇는다 */
function graphGeneric(caseIndex: number, cl: Cluster): CaseGraph {
  let k = caseIndex;
  const id = () => `n-${IDS[k++ % IDS.length]}${caseIndex}`;
  const acc: GraphNode[] = Array.from({ length: cl.accountCount }, (_, i) => ({ nodeId: id(), kind: 'ACCOUNT' as const, label: accountLabel(caseIndex, i), inCluster: true }));
  const nodes: GraphNode[] = [...acc];
  const edges: GraphEdge[] = [];
  const label: Record<string, string> = { DEVICE: 'e3a91c50', PAYMENT_METHOD: '64bd0f2e', CONTACT: '1f7c8a93', IP: '198.51.100.0/24', ASN: 'AS64511' };
  for (const kind of cl.sharedAttributes) {
    if (kind === 'IDENTITY_CONFLICT') {
      // 같은 본인확인을 다른 계정에서 시도한 기록은 계정끼리 잇는 선이다
      for (let i = 1; i < acc.length; i++) edges.push({ from: acc[0]!.nodeId, to: acc[i]!.nodeId, kind, firstSeenAt: T0, lastSeenAt: T1, count: 1 });
      continue;
    }
    const n: GraphNode = { nodeId: id(), kind, label: label[kind]! };
    nodes.push(n);
    acc.forEach((a) => edges.push({ from: a.nodeId, to: n.nodeId, kind, firstSeenAt: T0, lastSeenAt: T1, count: 1 }));
  }
  return { nodes, edges, truncated: false };
}

export function graphFor(caseId: string): CaseGraph {
  if (caseId === 'CASE-2610-0007') return graph0007();
  const i = CASES.findIndex((c) => c.caseId === caseId);
  const c = CASES[i];
  const cl = c ? getCluster(c.clusterId) : undefined;
  return cl ? graphGeneric(i + 1, cl) : { nodes: [], edges: [], truncated: false };
}

/** 'IP 원문 열림' 상태의 원문 하나(문서용 대역). ip-reveals 응답은 no-store이고 화면 메모리에만 둔다 */
export const REVEALED_IP = { nodeId: graph0007().nodes.find((n) => n.label === '203.0.113.0/24')!.nodeId, ip: '203.0.113.47' };

// ── 계정·사건 기록·증거 묶음 ──

export interface Member {
  accountId: string;
  ticketCount: number;
  signals: FraudSignal[];
  appealResult: AppealResult;
}

/** 묶음 계정(사건 상세 members). 소명 결과는 화면 상태가 정한다 */
export function membersFor(caseId: string, results: (i: number) => AppealResult): Member[] {
  const i = CASES.findIndex((c) => c.caseId === caseId);
  const c = CASES[i];
  if (!c) return [];
  const per = Math.floor(c.ticketCount / c.accountCount);
  const extra = c.ticketCount - per * c.accountCount;
  const cl = getCluster(c.clusterId);
  return Array.from({ length: c.accountCount }, (_, j) => ({
    accountId: c.caseId === 'CASE-2610-0007' ? accountLabel(7, j) : accountLabel(i + 1, j),
    ticketCount: per + (j < extra ? 1 : 0),
    signals: j % 3 === 0 && cl?.signals.includes('VELOCITY') ? ['LINK_GRAPH', 'VELOCITY'] : ['LINK_GRAPH'],
    appealResult: results(j),
  }));
}

export interface CaseEvent {
  at: string;
  who: string;
  what: string;
}

export const CASE_EVENTS: readonly CaseEvent[] = [
  { at: '2026-10-19T14:05:00+09:00', who: '도윤', what: '후보 묶음 cl-2610-a로 사건을 만들었습니다(사유 범주 1인 매수 제한 회피)' },
  { at: '2026-10-19T14:16:00+09:00', who: '도윤', what: '조사 원천 리플레이를 열었습니다(시간창 T−10:00 ~ T+20:00)' },
];

export const EVIDENCE_BUNDLE = {
  bundleId: 'evb-2610-0007',
  status: 'SEALED' as const,
  manifestSha256: '0f42621688a18fc5aae699203d79e524d92747bbba41432ed3ced0cae58d19f7',
  holdReason: '이의 기간',
  files: [
    { name: 'manifest.json', sizeBytes: 2_184, sha256: '7be79193515fe48ea189f4e9c4ee8aac8d16e4b58526c0c47cae277edeffc779' },
    { name: 'snapshots.json', sizeBytes: 912, sha256: '1344dd953d3b7e2b4ab124981571230bd70ba8fd8a6e5a7b0ab551c7f3ba018e' },
    { name: 'records/requests.arrow', sizeBytes: 418_560, sha256: 'a89975879bb9962b752c5cb7e24723605316160439611d64490d9a55c9c44e81' },
    { name: 'records/steps.arrow', sizeBytes: 1_206_272, sha256: 'a806c58e5693b7e726c65772da9a2e00c0bca7f70ad3b791aef8b6dac800ba99' },
    { name: 'records/links.arrow', sizeBytes: 64_512, sha256: 'a488b3b87e4322a5566491aeb23cb36636833731ae450a305e7b7452de14c37b' },
    { name: 'cluster.json', sizeBytes: 5_340, sha256: 'c5fa1cdcf316671222625ddea7a45f3317e483bde331e1150f750926000dd94a' },
    { name: 'case.json', sizeBytes: 8_902, sha256: '8325ad626ff2b17cde9950a425db7a28c407a822a4fc879ddb91b85c012ad606' },
  ],
  custody: [
    { at: '2026-10-23T11:00:00+09:00', who: '시스템', what: '만들기(CREATED)' },
    { at: '2026-10-23T11:04:00+09:00', who: '시스템', what: '봉인(SEALED) · 묶음 해시 확정' },
    { at: '2026-10-23T13:20:00+09:00', who: '도윤', what: '열람(VIEWED)' },
  ],
};

// ── 사후 포렌식 자체 법률 검토 반영(ADR-0173, OpenSpec apply-legal-review-to-screens) ──

/** 승인 대상 한 줄(openapi FraudCaseSummary.targets). 계정 ID·표 ID는 본문(excludeAccountIds·excludeTicketIds)에만 쓰고 화면에는 '계정 1·2…'로 보인다 */
export interface ApprovalTarget {
  accountId: string;
  ticketIds: string[];
  ticketCount: number;
  /** 그 가운데 받은 사람(사건 밖 계정)이 가진 표 수 */
  holderTicketCount: number;
  appealOutcome: AppealResult;
}

/** SCR-046 부정 예매 조치(사건 CASE-2610-0005, 6계정 18장)의 대상 줄. 소명 결과는 사건 요약의 수(불인정 4 · 기한까지 안 냄 2)와 같다 */
export const APPROVAL_TARGETS: readonly ApprovalTarget[] = Array.from({ length: 6 }, (_, j) => ({
  accountId: accountLabel(2, j),
  ticketIds: [1, 2, 3].map((k) => `tk-0005-${j + 1}${k}`),
  ticketCount: 3,
  holderTicketCount: j === 0 ? 1 : 0,
  appealOutcome: j < 4 ? ('REJECTED' as const) : ('EXPIRED' as const),
}));

/** 승인자 수진이 이 요청의 사건 요약을 처음 연 시각(ops DB approval_summary_view, 상세 응답의 summaryViewedAt) */
export const APPROVAL_SUMMARY_VIEWED_AT = '2026-10-19T09:12:00+09:00';

/** 사건 계정이 결제해 양도한 표를 지금 가진 사람(사건 밖 계정)의 진술. 좌석 글만 두고 받은 사람의 계정은 두지 않는다 */
export interface HolderStatement {
  seatLabel: string;
  /** SUBMITTED 냄 · PENDING 기다림 */
  statement: 'SUBMITTED' | 'PENDING';
}

const HOLDERS: Partial<Record<string, readonly HolderStatement[]>> = {
  'CASE-2610-0007': [
    { seatLabel: 'A구역 3열 16번', statement: 'SUBMITTED' },
    { seatLabel: 'B구역 7열 2번', statement: 'PENDING' },
  ],
};

/** 사건의 받은 사람 진술(없으면 빈 목록) */
export function holdersFor(caseId: string): readonly HolderStatement[] {
  return HOLDERS[caseId] ?? [];
}
