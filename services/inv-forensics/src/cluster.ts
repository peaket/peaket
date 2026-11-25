// 부정 예매 후보 묶음 R1~R6·구매 수 대 한도·점수 범주·결과 지문(docs/features/forensic-replay.md §6.7.3,
// FX-T11, F-04-11). 규칙은 입력만 보는 순수 함수다. 난수·지금 시각·저장소를 쓰지 않는다.
// - R1 강한 연결(기기·연락처·본인확인 충돌 2계정 이상, 결제 수단 3계정 이상)과
//   서로 다른 종류의 약한 연결 둘 이상이 계정을 잇는다.
// - R2~R6은 묶음을 잇지 않고 근거 신호로 붙는다.
// - 후보: R5(입장 토큰 없는 홀드)는 계정 하나도, R3의 다시 쓴 입장 링크·R6은 계정 둘 이상일 때,
//   그 밖에는 계정 둘 이상이고 구매 수 > 1인 한도일 때다.
import { canonicalize, sha256Hex } from './canonical.js';

export type FraudSignalName = 'LINK_GRAPH' | 'SYNC_STEPS' | 'VELOCITY' | 'TIMING_BASELINE' | 'BYPASS_TRACE' | 'POST_MATCH';
export type ScoreBand = 'HIGH' | 'MEDIUM' | 'LOW';

export const RULE_VERSION = 'fraud-rules-v1';
export const SIGNAL_ORDER: readonly FraudSignalName[] = [
  'LINK_GRAPH',
  'SYNC_STEPS',
  'VELOCITY',
  'TIMING_BASELINE',
  'BYPASS_TRACE',
  'POST_MATCH',
];

/** §6.7.3의 [가정] 점수. 묶음에 나타난 신호마다 가장 큰 점수를 더한다 */
export const RULE_SCORES = { LINK_GRAPH: 3, SYNC_STEPS: 2, VELOCITY: 2, TIMING_BASELINE: 1, BYPASS_TRACE: 4, POST_MATCH: 4 } as const;
export const VELOCITY_REUSE_SCORE = 3;
export const PURCHASE_SCORE = { ABOVE_LIMIT: 3, TRIPLE_LIMIT: 5 } as const;
export const SCORE_BANDS = { HIGH: 8, MEDIUM: 5 } as const;

export const SYNC_WINDOW_MS = 200;
export const SYNC_MIN_STEPS = 3;
export const VELOCITY_WINDOW_MS = 10 * 60_000;
export const VELOCITY_MIN_ACCOUNTS = 5;
export const IP_WINDOW_MS = 10 * 60_000;
export const WEAK_GROUP_MAX_ACCOUNTS = 20;
export const PAYMENT_STRONG_MIN_ACCOUNTS = 3;
export const TIMING_PERCENTILE = 0.001;
export const TIMING_MIN_SAMPLES = 100;
export const TIMING_MIN_STEPS = 2;

export interface ClusterLink {
  kind: 'PID' | 'ACCOUNT' | 'DEVICE' | 'CONTACT' | 'PAYMENT_METHOD' | 'IDENTITY_CONFLICT';
  value: string;
  accountId: string;
  journeyId?: string;
  firstSeenAt: number;
}

export interface ClusterRequest {
  accountId: string;
  ip: string;
  netClass: string;
  asn: number;
  ts: number;
}

export interface ClusterStep {
  accountId: string;
  journeyId: string;
  step: string;
  ts: number;
  queueEntryId?: string;
  seatIds?: readonly string[];
}

export interface ExternalPost {
  postId: string;
  seatIds: readonly string[];
}

export interface ClusterInput {
  eventId: string;
  snapshotVersion: number;
  ruleVersion?: string;
  limitPerPerson: number;
  saleStartMs: number;
  links: readonly ClusterLink[];
  requests: readonly ClusterRequest[];
  steps: readonly ClusterStep[];
  posts?: readonly ExternalPost[];
}

export interface ClusterMember {
  accountId: string;
  signals: FraudSignalName[];
  ticketCount: number;
}

export interface CandidateCluster {
  accounts: string[];
  accountCount: number;
  purchaseCount: number;
  limitPerPerson: number;
  scoreBand: ScoreBand;
  sharedAttributes: string[];
  signals: FraudSignalName[];
  members: ClusterMember[];
  candidate: boolean;
}

export interface ClusterResult {
  eventId: string;
  snapshotVersion: number;
  ruleVersion: string;
  clusters: CandidateCluster[];
  candidateCount: number;
  resultFingerprint: string;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortAccounts = (xs: Iterable<string>): string[] => [...xs].sort(cmp);
const sortSignals = (xs: Iterable<FraudSignalName>): FraudSignalName[] => [...new Set(xs)].sort((a, b) => SIGNAL_ORDER.indexOf(a) - SIGNAL_ORDER.indexOf(b));
const seats = (s: ClusterStep | undefined): number => Math.max(1, s?.seatIds?.length ?? 0);

function assertInt(name: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min) throw new Error(`${name}은 ${min} 이상 정수여야 한다(${value})`);
}
function assertTime(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new Error(`${name} 시각이 유한한 밀리초가 아니다`);
}

/** SALE 좌석 수 합에서 CANCEL 좌석 수 합을 뺀 계정별 구매 수 */
export function purchasesOfSteps(steps: readonly ClusterStep[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of steps) {
    if (!s.accountId) continue;
    if (s.step === 'SALE') out.set(s.accountId, (out.get(s.accountId) ?? 0) + seats(s));
    else if (s.step === 'CANCEL') out.set(s.accountId, Math.max(0, (out.get(s.accountId) ?? 0) - seats(s)));
  }
  return out;
}

function unionFind(accounts: Iterable<string>) {
  const parent = new Map<string, string>();
  for (const a of accounts) parent.set(a, a);
  const find = (a: string): string => {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = a;
    while (parent.get(c) !== c) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  return { find, union };
}

function weakPairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

export function computeClusters(input: ClusterInput): ClusterResult {
  if (!input.eventId) throw new Error('후보: 회차 ID가 필요하다');
  assertInt('후보 판(snapshotVersion)', input.snapshotVersion, 1);
  assertInt('1인 한도(limitPerPerson)', input.limitPerPerson, 1);
  assertTime('판매 시작', input.saleStartMs);
  const ruleVersion = input.ruleVersion ?? RULE_VERSION;
  if (!ruleVersion) throw new Error('후보: 규칙 판이 필요하다');
  for (const l of input.links) {
    if (!l.accountId) throw new Error('후보: 연결의 계정 ID가 필요하다');
    assertTime('연결 본 시각', l.firstSeenAt);
  }
  for (const r of input.requests) {
    if (!r.accountId || !r.ip) throw new Error('후보: 요청의 계정·IP가 필요하다');
    assertInt('ASN', r.asn, 0);
    assertTime('요청 시각', r.ts);
  }
  for (const s of input.steps) {
    if (!s.step) throw new Error('후보: 단계 이름이 필요하다');
    assertTime('단계 시각', s.ts);
  }

  const purchases = purchasesOfSteps(input.steps);
  const targets = new Set<string>();
  for (const s of input.steps) {
    if (s.accountId && (s.step === 'HOLD_TRY' || s.step === 'ORDER')) targets.add(s.accountId);
  }
  for (const [a, n] of purchases) if (n > 0) targets.add(a);

  const uf = unionFind(targets);
  const linkAccounts = new Set<string>();
  const strongGroups: { kind: string; accounts: string[] }[] = [];
  const weakPairs = new Map<string, { a: string; b: string; kinds: Set<string> }>();
  const addWeak = (kind: string, a: string, b: string): void => {
    if (a === b || !targets.has(a) || !targets.has(b)) return;
    const key = weakPairKey(a, b);
    const cur = weakPairs.get(key) ?? { a: a < b ? a : b, b: a < b ? b : a, kinds: new Set<string>() };
    cur.kinds.add(kind);
    weakPairs.set(key, cur);
  };

  // R1 강한 연결과 결제 수단 약한 연결
  const groups = new Map<string, Map<string, Set<string>>>();
  for (const kind of ['DEVICE', 'CONTACT', 'IDENTITY_CONFLICT', 'PAYMENT_METHOD']) groups.set(kind, new Map());
  for (const l of input.links) {
    const byValue = groups.get(l.kind);
    if (!byValue || !targets.has(l.accountId)) continue;
    const set = byValue.get(l.value) ?? new Set<string>();
    set.add(l.accountId);
    byValue.set(l.value, set);
  }
  for (const [kind, byValue] of groups) {
    for (const accounts of byValue.values()) {
      const list = sortAccounts(accounts);
      if (kind === 'PAYMENT_METHOD') {
        if (list.length >= PAYMENT_STRONG_MIN_ACCOUNTS) {
          strongGroups.push({ kind, accounts: list });
          for (const a of list) linkAccounts.add(a);
          for (let i = 1; i < list.length; i += 1) uf.union(list[0]!, list[i]!);
        } else if (list.length === 2) {
          for (const a of list) linkAccounts.add(a);
          addWeak('PAYMENT_METHOD', list[0]!, list[1]!);
        }
        continue;
      }
      if (list.length >= 2) {
        strongGroups.push({ kind, accounts: list });
        for (const a of list) linkAccounts.add(a);
        for (let i = 1; i < list.length; i += 1) uf.union(list[0]!, list[i]!);
      }
    }
  }

  // R1 약한 연결: 10분 창의 같은 IP(20계정 이하), 호스팅·프록시 같은 ASN(20계정 이하)
  const byIp = new Map<string, ClusterRequest[]>();
  for (const r of input.requests) {
    const list = byIp.get(r.ip) ?? [];
    list.push(r);
    byIp.set(r.ip, list);
  }
  for (const list of byIp.values()) {
    list.sort((a, b) => a.ts - b.ts || cmp(a.accountId, b.accountId));
    for (let right = 0; right < list.length; right += 1) {
      let left = right;
      while (left > 0 && list[right]!.ts - list[left - 1]!.ts <= IP_WINDOW_MS) left -= 1;
      const accounts = sortAccounts(new Set(list.slice(left, right + 1).map((r) => r.accountId)));
      if (accounts.length < 2 || accounts.length > WEAK_GROUP_MAX_ACCOUNTS) continue;
      for (const a of accounts) linkAccounts.add(a);
      for (let i = 0; i < accounts.length; i += 1) {
        for (let j = i + 1; j < accounts.length; j += 1) addWeak('IP', accounts[i]!, accounts[j]!);
      }
    }
  }
  const byAsn = new Map<number, Set<string>>();
  for (const r of input.requests) {
    if (r.asn <= 0 || (r.netClass !== 'HOSTING' && r.netClass !== 'PROXY')) continue;
    const set = byAsn.get(r.asn) ?? new Set<string>();
    set.add(r.accountId);
    byAsn.set(r.asn, set);
  }
  for (const accounts of byAsn.values()) {
    const list = sortAccounts(accounts);
    if (list.length < 2 || list.length > WEAK_GROUP_MAX_ACCOUNTS) continue;
    for (const a of list) linkAccounts.add(a);
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) addWeak('ASN', list[i]!, list[j]!);
    }
  }
  for (const p of weakPairs.values()) if (p.kinds.size >= 2) uf.union(p.a, p.b);

  // R2 여러 계정이 같은 단계를 200ms 안에 밟은 일이 세 단계 이상
  const syncParticipants = new Set<string>();
  let syncStepCount = 0;
  const byStep = new Map<string, ClusterStep[]>();
  for (const s of input.steps) {
    if (!s.accountId) continue;
    const list = byStep.get(s.step) ?? [];
    list.push(s);
    byStep.set(s.step, list);
  }
  for (const list of byStep.values()) {
    list.sort((a, b) => a.ts - b.ts || cmp(a.accountId, b.accountId));
    let burst = false;
    for (let right = 0; right < list.length; right += 1) {
      let left = right;
      while (left > 0 && list[right]!.ts - list[left - 1]!.ts <= SYNC_WINDOW_MS) left -= 1;
      const accounts = new Set(list.slice(left, right + 1).map((s) => s.accountId));
      if (accounts.size >= 2) {
        burst = true;
        for (const a of accounts) syncParticipants.add(a);
      }
    }
    if (burst) syncStepCount += 1;
  }
  const syncAccounts = syncStepCount >= SYNC_MIN_STEPS ? syncParticipants : new Set<string>();

  // R3 같은 IP·기기에서 10분 안 계정 5개 이상, 같은 입장 링크를 다른 기기에서 다시 씀
  const velocityAccounts = new Set<string>();
  const byVelocityIp = new Map<string, ClusterRequest[]>();
  for (const r of input.requests) {
    const list = byVelocityIp.get(r.ip) ?? [];
    list.push(r);
    byVelocityIp.set(r.ip, list);
  }
  for (const list of byVelocityIp.values()) {
    list.sort((a, b) => a.ts - b.ts);
    for (let right = 0; right < list.length; right += 1) {
      let left = right;
      while (left > 0 && list[right]!.ts - list[left - 1]!.ts <= VELOCITY_WINDOW_MS) left -= 1;
      const accounts = new Set(list.slice(left, right + 1).map((r) => r.accountId));
      if (accounts.size >= VELOCITY_MIN_ACCOUNTS) for (const a of accounts) velocityAccounts.add(a);
    }
  }
  const deviceLinks = input.links.filter((l) => l.kind === 'DEVICE' && l.journeyId);
  const byDevice = new Map<string, ClusterLink[]>();
  for (const l of deviceLinks) {
    const list = byDevice.get(l.value) ?? [];
    list.push(l);
    byDevice.set(l.value, list);
  }
  for (const list of byDevice.values()) {
    list.sort((a, b) => a.firstSeenAt - b.firstSeenAt);
    for (let right = 0; right < list.length; right += 1) {
      let left = right;
      while (left > 0 && list[right]!.firstSeenAt - list[left - 1]!.firstSeenAt <= VELOCITY_WINDOW_MS) left -= 1;
      const accounts = new Set(list.slice(left, right + 1).map((l) => l.accountId));
      if (accounts.size >= VELOCITY_MIN_ACCOUNTS) for (const a of accounts) velocityAccounts.add(a);
    }
  }
  const devicesByJourney = new Map<string, Set<string>>();
  for (const l of deviceLinks) {
    const set = devicesByJourney.get(l.journeyId!) ?? new Set<string>();
    set.add(l.value);
    devicesByJourney.set(l.journeyId!, set);
  }
  const admissionReuse = new Set<string>();
  const byQueueEntry = new Map<string, ClusterStep[]>();
  for (const s of input.steps) {
    if (s.step !== 'ADMIT' || !s.queueEntryId) continue;
    const list = byQueueEntry.get(s.queueEntryId) ?? [];
    list.push(s);
    byQueueEntry.set(s.queueEntryId, list);
  }
  for (const list of byQueueEntry.values()) {
    const devices = new Set<string>();
    for (const s of list) for (const d of devicesByJourney.get(s.journeyId) ?? []) devices.add(d);
    if (devices.size < 2) continue;
    for (const s of list) {
      if (s.accountId) {
        admissionReuse.add(s.accountId);
        velocityAccounts.add(s.accountId);
      }
    }
  }

  // R4 판매 시작부터 단계까지 하위 0.1%보다 빠른 단계 둘 이상
  const timingAccounts = new Set<string>();
  const firstByStepAccount = new Map<string, Map<string, number>>();
  for (const s of input.steps) {
    if (!s.accountId) continue;
    const byAccount = firstByStepAccount.get(s.step) ?? new Map<string, number>();
    const duration = s.ts - input.saleStartMs;
    if (!byAccount.has(s.accountId) || duration < byAccount.get(s.accountId)!) byAccount.set(s.accountId, duration);
    firstByStepAccount.set(s.step, byAccount);
  }
  const fastStepCount = new Map<string, number>();
  for (const byAccount of firstByStepAccount.values()) {
    const durations = [...byAccount.entries()].filter(([, d]) => d >= 0).sort((a, b) => a[1] - b[1]);
    if (durations.length < TIMING_MIN_SAMPLES) continue;
    const threshold = durations[Math.floor(TIMING_PERCENTILE * (durations.length - 1))]![1];
    for (const [a, d] of durations) {
      if (d < threshold) fastStepCount.set(a, (fastStepCount.get(a) ?? 0) + 1);
    }
  }
  for (const [a, n] of fastStepCount) if (n >= TIMING_MIN_STEPS) timingAccounts.add(a);

  // R5 입장 토큰 없는 홀드 시도(같은 여정에 ADMIT가 없다)
  const journeysWithAdmit = new Set(input.steps.filter((s) => s.step === 'ADMIT' && s.journeyId).map((s) => s.journeyId));
  const accountOfJourney = new Map<string, string>();
  for (const l of input.links) if (l.journeyId && l.accountId) accountOfJourney.set(l.journeyId, l.accountId);
  for (const s of input.steps) if (s.journeyId && s.accountId) accountOfJourney.set(s.journeyId, s.accountId);
  const bypassAccounts = new Set<string>();
  for (const s of input.steps) {
    if (s.step !== 'HOLD_TRY' || !s.journeyId || journeysWithAdmit.has(s.journeyId)) continue;
    const account = s.accountId || accountOfJourney.get(s.journeyId);
    if (account) bypassAccounts.add(account);
  }

  // 묶음(연결 요소) 만들기
  const components = new Map<string, string[]>();
  for (const a of targets) {
    const root = uf.find(a);
    const list = components.get(root) ?? [];
    list.push(a);
    components.set(root, list);
  }
  const saleSeatsByAccount = new Map<string, string[]>();
  for (const s of input.steps) {
    if (s.step !== 'SALE' || !s.accountId) continue;
    const list = saleSeatsByAccount.get(s.accountId) ?? [];
    for (const seat of s.seatIds ?? []) list.push(seat);
    saleSeatsByAccount.set(s.accountId, list);
  }
  const postSeats = new Set((input.posts ?? []).flatMap((p) => p.seatIds));

  const clusters: CandidateCluster[] = [];
  for (const raw of components.values()) {
    const accounts = sortAccounts(raw);
    const memberSignals = new Map<string, Set<FraudSignalName>>();
    for (const a of accounts) memberSignals.set(a, new Set());
    const add = (a: string, s: FraudSignalName) => memberSignals.get(a)?.add(s);
    for (const a of accounts) {
      if (linkAccounts.has(a)) add(a, 'LINK_GRAPH');
      if (syncAccounts.has(a)) add(a, 'SYNC_STEPS');
      if (velocityAccounts.has(a)) add(a, 'VELOCITY');
      if (timingAccounts.has(a)) add(a, 'TIMING_BASELINE');
      if (bypassAccounts.has(a)) add(a, 'BYPASS_TRACE');
    }
    let componentStrong = false;
    let componentWeak = false;
    const shared = new Set<string>();
    for (const g of strongGroups) {
      if (g.accounts.filter((a) => accounts.includes(a)).length >= 2) {
        componentStrong = true;
        shared.add(g.kind);
      }
    }
    for (const p of weakPairs.values()) {
      const inA = accounts.includes(p.a);
      const inB = accounts.includes(p.b);
      if (inA || inB) componentWeak = true;
      if (inA && inB) for (const k of p.kinds) shared.add(k);
    }
    const seatsOfCluster = accounts.flatMap((a) => saleSeatsByAccount.get(a) ?? []);
    let postMatch = false;
    for (const seat of seatsOfCluster) {
      if (!postSeats.has(seat)) continue;
      postMatch = true;
      for (const a of accounts) if ((saleSeatsByAccount.get(a) ?? []).includes(seat)) add(a, 'POST_MATCH');
    }
    const signals = sortSignals([...memberSignals.values()].flatMap((s) => [...s]));
    const purchaseCount = accounts.reduce((sum, a) => sum + (purchases.get(a) ?? 0), 0);
    const reuse = accounts.some((a) => admissionReuse.has(a));
    const candidate =
      signals.includes('BYPASS_TRACE') ||
      (accounts.length >= 2 &&
        (purchaseCount > input.limitPerPerson || signals.includes('POST_MATCH') || reuse));
    if (accounts.length < 2 && signals.length === 0) continue;

    let score = componentStrong ? RULE_SCORES.LINK_GRAPH : componentWeak ? 1 : 0;
    if (signals.includes('SYNC_STEPS')) score += RULE_SCORES.SYNC_STEPS;
    if (signals.includes('VELOCITY')) score += reuse ? VELOCITY_REUSE_SCORE : RULE_SCORES.VELOCITY;
    if (signals.includes('TIMING_BASELINE')) score += RULE_SCORES.TIMING_BASELINE;
    if (signals.includes('BYPASS_TRACE')) score += RULE_SCORES.BYPASS_TRACE;
    if (signals.includes('POST_MATCH')) score += RULE_SCORES.POST_MATCH;
    const purchaseScore =
      purchaseCount >= 3 * input.limitPerPerson
        ? PURCHASE_SCORE.TRIPLE_LIMIT
        : purchaseCount > input.limitPerPerson
          ? PURCHASE_SCORE.ABOVE_LIMIT
          : 0;
    score += purchaseScore;
    const band: ScoreBand = score >= SCORE_BANDS.HIGH ? 'HIGH' : score >= SCORE_BANDS.MEDIUM ? 'MEDIUM' : 'LOW';
    clusters.push({
      accounts,
      accountCount: accounts.length,
      purchaseCount,
      limitPerPerson: input.limitPerPerson,
      scoreBand: band,
      sharedAttributes: [...shared].sort(cmp),
      signals,
      members: accounts.map((a) => ({
        accountId: a,
        signals: sortSignals(memberSignals.get(a) ?? []),
        ticketCount: purchases.get(a) ?? 0,
      })),
      candidate,
    });
  }
  clusters.sort((a, b) => cmp(a.accounts[0]!, b.accounts[0]!));

  const body = {
    eventId: input.eventId,
    snapshotVersion: input.snapshotVersion,
    ruleVersion,
    clusters: clusters.map((c) => ({
      accounts: c.accounts,
      accountCount: c.accountCount,
      purchaseCount: c.purchaseCount,
      limitPerPerson: c.limitPerPerson,
      scoreBand: c.scoreBand,
      sharedAttributes: c.sharedAttributes,
      signals: c.signals,
      members: c.members.map((m) => ({ accountId: m.accountId, signals: m.signals, ticketCount: m.ticketCount })),
      candidate: c.candidate,
    })),
  };
  return {
    ...body,
    candidateCount: clusters.filter((c) => c.candidate).length,
    resultFingerprint: sha256Hex(canonicalize(body)),
  };
}
