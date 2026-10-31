// SCR-071 사건 작업대(/investigations/:caseId, d5 §7.19, docs/planning/04 SCR-071). 디자인 캔버스 보드가 없어 d5 그림과 키트 부품으로 그렸다.
// 한 벌의 반응형 마크업이다(add-fraud-investigation-screens design.md 결정 2): 데스크톱 12열(왼쪽 8열 요약·그래프·증거·기록 | 오른쪽 4열 소명·조치·증거 묶음),
// 태블릿 한 단, 휴대폰 한 단(그래프 대신 연결 표, 보기만, 나머지 자리는 안내 카드, d5 §3.9).
// - IP는 가린 값만 보인다. 원문은 점을 골라 사유를 적고 연 뒤(IP 원문 열림) 이 화면 메모리에만 두고, 화면을 떠나면 지운다(authz-matrix §4.3 5, ASVS 14.3.1).
// - 점수 원값·가중치, 연락처·카드 원문은 어디에도 없다. 승인은 다른 사람이 승인 업무(SCR-046)에서 한다(POL-038 ⑪).
// - 상태는 사건의 단계 그림이다. 사건마다 기본 상태는 그 사건의 상태이고, 단계마다 그 단계의 시각을 '지금'으로 본다(목업).
// - 자체 법률 검토(ADR-0173, apply-legal-review-to-screens): 잠금에 최대 기한(소명 요청 + 14일), 받은 사람 안내와 진술, 이용 제한 끝은 요청 + 1년까지,
//   받은 사람이 가진 표는 조치 대상에서 기본으로 빠짐, 의견 칸의 행동 요약 규칙, 고소·고발용 요약(COMPLAINT). 묶음 계정의 행동 값을 나란히 견주는 보기는 두지 않는다(결정 5).
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { CaseStatusBadge } from '@peaket/ds/CaseStatusBadge';
import {
  APPEAL_LOCK_NOTICE,
  COMPLAINT_NOTE,
  EXPORT_KINDS,
  EXPORT_KIND_LABEL,
  HOLDER_NOTICE,
  OPINION_HINT,
  appealDueLeavesCancel,
  complaintFileName,
  holdersFor,
  lockReleasedNotice,
  restrictionEndError,
  restrictionEndMax,
  transferLockExpiresAt,
  CancelDeadlineBadge,
  CASE_EVENTS,
  CASES,
  cancelDeadlineNotice,
  defaultAppealDue,
  DEFAULT_CASE_ID,
  EVENT,
  EVIDENCE_BUNDLE,
  EXTERNAL_POSTS,
  formatKst,
  getCase,
  getCluster,
  graphFor,
  HOUR,
  LINK_KIND_LABEL,
  membersFor,
  NODE_KIND_LABEL,
  NOW,
  purchaseVsLimit,
  REASON_LABEL,
  remainingHoursText,
  REVEALED_IP,
  SIGNAL_LABEL,
  SNAPSHOT,
  type AppealResult,
  type FraudCaseFixture,
  type FraudCaseStatus,
  type GraphNode,
} from '@/entities/fraud-case';
import { DESIGNATED, isInvestigator } from '@/entities/operator';
import { useChosenRole, useHost, usePreviewHost } from '@/features/preview-host';
import { BigScreenNote, InvestigatorDenied } from '@/features/screen-access';
import { investigationReplayHref } from '@/shared/config/origins';
import { useBoardPage, type BoardGaps } from '@/shared/lib/board';
import { Overlay } from '@/shared/ui/Overlay';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { STATES, type State } from '../states';
import { LegendShape, LinkGraph, LinkTable } from './LinkGraph';

const TITLE = '사건 작업대';

/** 휴대폰 배치에 없는 상태(그래프·원문 열기·계정 바꾸기·소명 요청은 태블릿·데스크톱에서만, d5 §3.9) */
const GAPS: BoardGaps<State> = {
  phone: { '점 고름(IP)': null, 'IP 원문 열기': null, 'IP 원문 열림': null, '계정 빼기': null, '소명 요청 확인': null, '이용 제한이 너무 김': null, '고소·고발용 요약 받음': null },
};

/** '양도 잠금 최대 기한 지남' 그림에서 잠금이 풀린 계정 수(일부만 지난 그림, d5 §7.19) */
const LOCK_RELEASED_ACCOUNTS = 3;

type Phase = 'investigating' | 'appeal' | 'decision' | 'actioned' | 'objected' | 'cleared' | 'deadline-passed';

const PHASE: Partial<Record<State, Phase>> = {
  '소명 대기': 'appeal',
  '결정 대기': 'decision',
  조치됨: 'actioned',
  '이의 접수': 'objected',
  '정상 종료': 'cleared',
  '취소 마감 지남': 'deadline-passed',
  // 이용 제한이 너무 김: 취소 마감 뒤 이용 제한을 요청하는 그림 · 잠금 최대 기한 지남: 소명 대기 중 · 고소·고발용 요약 받음: 조치됨의 내보내기 뒤
  '이용 제한이 너무 김': 'deadline-passed',
  '양도 잠금 최대 기한 지남': 'appeal',
  '고소·고발용 요약 받음': 'actioned',
};

const STATUS_OF: Record<Phase, FraudCaseStatus> = {
  investigating: 'INVESTIGATING',
  appeal: 'APPEAL_PENDING',
  decision: 'DECISION_PENDING',
  actioned: 'ACTIONED',
  objected: 'OBJECTED',
  cleared: 'CLEARED',
  'deadline-passed': 'APPEAL_PENDING',
};

const STATE_OF_STATUS: Record<FraudCaseStatus, State> = {
  INVESTIGATING: '조사 중',
  APPEAL_PENDING: '소명 대기',
  DECISION_PENDING: '결정 대기',
  ACTIONED: '조치됨',
  OBJECTED: '이의 접수',
  CLEARED: '정상 종료',
  REVERSED: '이의 접수',
};

const later = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b);
const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
const timeOf = (iso: string) => `${formatKst(iso).split(' ')[1]}:05 KST`;
const shortHash = (h: string) => `${h.slice(0, 8)}…${h.slice(-8)}`;
const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => undefined);

/** 단계의 '지금'(목업): 그 단계가 시작된 뒤의 시각 */
function nowOf(phase: Phase, c: FraudCaseFixture): string {
  switch (phase) {
    case 'appeal':
      return later(NOW, c.timeline.appealRequestedAt);
    case 'decision':
      return later(NOW, plus(c.timeline.actionRequestedAt, HOUR / 2));
    case 'actioned':
    case 'objected':
      return later(NOW, plus(c.timeline.actionedAt, 24 * HOUR));
    case 'deadline-passed':
      return '2026-10-24T16:30:00+09:00';
    default:
      return NOW;
  }
}

/** 단계마다 계정의 소명 결과(사건 상세 members[].appealResult) */
function resultsOf(phase: Phase, c: FraudCaseFixture): (i: number) => AppealResult {
  const n = c.accountCount;
  if (phase === 'investigating') return () => 'NOT_REQUESTED';
  if (phase === 'appeal') {
    const submitted = c.status === 'APPEAL_PENDING' ? c.appealCounts.submitted : Math.min(2, n);
    return (i) => (i < submitted ? 'SUBMITTED' : 'PENDING');
  }
  if (phase === 'cleared') return () => (c.appealCounts.accepted === n ? 'ACCEPTED' : 'NOT_REQUESTED');
  const order: AppealResult[] = [
    ...Array<AppealResult>(c.appealCounts.rejected).fill('REJECTED'),
    ...Array<AppealResult>(c.appealCounts.expired).fill('EXPIRED'),
    ...Array<AppealResult>(c.appealCounts.accepted).fill('ACCEPTED'),
  ];
  return (i) => order[i] ?? 'REJECTED';
}

export function Page() {
  const { caseId = DEFAULT_CASE_ID } = useParams();
  const c = getCase(caseId);
  const chosen = useChosenRole();
  const def: State = c ? STATE_OF_STATUS[c.status] : '조사 중';
  const { state, boardStates, layout, close, go } = useBoardPage(TITLE, STATES, def, GAPS);
  const phase: Phase = PHASE[state] ?? 'investigating';
  const now = c ? nowOf(phase, c) : NOW;
  usePreviewHost(
    {
      scope: { stage: '종료 후' },
      control: { kind: 'ok' },
      clock: timeOf(now),
      ...(chosen ? {} : { session: { ...DESIGNATED.investigator, designations: DESIGNATED.investigator.designations ?? [] } }),
    },
    [state, chosen, caseId],
  );
  const host = useHost();
  const allowed = isInvestigator(host.session.role, host.session.designations) && state !== '권한 없음(지정 없음)';

  // 연 IP 원문은 화면 메모리에만 둔다(이 화면을 떠나거나 상태를 바꾸면 지운다, ASVS 14.3.1)
  const [revealed, setRevealed] = useState<string | null>(null);
  useEffect(() => {
    setRevealed(state === 'IP 원문 열림' ? REVEALED_IP.ip : null);
    return () => setRevealed(null);
  }, [state]);

  if (!allowed) {
    return (
      <>
        <InvestigatorDenied />
        <PreviewSwitcher states={boardStates} current={state} />
      </>
    );
  }
  if (!c) {
    return (
      <section className="widget" aria-label="없는 사건">
        <div className="state" style={{ padding: '64px 16px' }}>
          <h1 className="t-lg">사건을 찾을 수 없습니다</h1>
          <Link className="btn btn-outline" to="/investigations">
            부정 거래 조사로 가기
          </Link>
        </div>
      </section>
    );
  }

  const phone = layout === 'phone';
  const desktop = layout === 'desktop';
  const status = c.status === STATUS_OF[phase] || state === '불러오는 중' ? c.status : STATUS_OF[phase];
  const v: View = { state, phase, status, now, c, phone, go, close, revealed };

  // 정상 종료(CLEARED)에는 소명·조치 자리가 없다(d5 §7.19). 그 자리에 종료 결과 칸 하나를 둔다
  const cleared = phase === 'cleared';
  const decision = cleared ? (
    <ClearedSection v={v} />
  ) : (
    <>
      <AppealRequestSection v={v} />
      <AppealResultSection v={v} />
      <ActionSection v={v} />
    </>
  );

  const lockNotice = state === '양도 잠금 최대 기한 지남' ? lockReleasedNotice(LOCK_RELEASED_ACCOUNTS, c.accountCount) : null;

  return (
    <>
      <Header v={v} />
      {lockNotice ? (
        <div className="banner banner-info" role="status">
          <i className="ic ic-info" aria-hidden="true" />
          <div className="banner-body">{lockNotice}</div>
        </div>
      ) : null}
      {desktop ? (
        // 데스크톱: 왼쪽 8열 ① ② ③ ⑧ | 오른쪽 4열 ④ ⑤ ⑥ ⑦
        // key: 상태를 바꾸면(화면 안 이동) 칸의 처음 값(이용 제한 끝·내보내기 종류 등)을 그 상태로 다시 정한다(FRN-090 리뷰 결함 2)
        <div key={state} style={{ display: 'grid', gridTemplateColumns: 'repeat(12,minmax(0,1fr))', gap: 16, alignItems: 'start' }}>
          <div className="col" style={{ gridColumn: 'span 8', gap: 16, minWidth: 0 }}>
            <SummaryTiles v={v} />
            <GraphSection v={v} />
            <EvidenceSection v={v} />
            <CaseLog v={v} />
          </div>
          <div className="col" style={{ gridColumn: 'span 4', gap: 16, minWidth: 0 }}>
            {decision}
            <BundleSection v={v} />
          </div>
        </div>
      ) : (
        // 태블릿·휴대폰: 한 단 ① ② ④ ⑤ ⑥ ③ ⑦ ⑧(d5 §7.19, d3 SCR-071). 휴대폰은 ②가 연결 표이고 숨긴 단추 자리는 안내 카드다
        <div key={state} className="col" style={{ gap: phone ? 12 : 16, minWidth: 0 }}>
          <SummaryTiles v={v} />
          <GraphSection v={v} />
          {decision}
          <EvidenceSection v={v} />
          <BundleSection v={v} />
          <CaseLog v={v} />
        </div>
      )}
      {state === 'IP 원문 열기' ? <IpRevealDialog close={close} go={go} /> : null}
      {state === '계정 빼기' ? <RemoveAccountDialog close={close} account={graphFor(c.caseId).nodes.find((n) => n.kind === 'ACCOUNT')!} /> : null}
      {state === '소명 요청 확인' ? <AppealConfirmDialog close={close} go={go} c={c} /> : null}
      {state === '불러오는 중' ? (
        <span className="sr-only" role="status">
          불러오는 중입니다
        </span>
      ) : null}
      <PreviewSwitcher states={boardStates} current={state} />
    </>
  );
}

interface View {
  state: State;
  phase: Phase;
  status: FraudCaseStatus;
  now: string;
  c: FraudCaseFixture;
  phone: boolean;
  go: (s: string) => void;
  close: () => void;
  revealed: string | null;
}

function Widget({ id, title, actions, children }: { id: string; title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="widget" aria-labelledby={id}>
      <div className="widget-head wrap">
        <h2 className="t-sm fw-b" id={id}>
          {title}
        </h2>
        {actions ? <div className="actions">{actions}</div> : null}
      </div>
      <div className="widget-body" style={{ gap: 12 }}>
        {children}
      </div>
    </section>
  );
}

function Header({ v }: { v: View }) {
  const { c, now } = v;
  const passed = cancelDeadlineNotice(now, c.cancelDeadlineAt).tone === 'passed';
  return (
    <div className="col" style={{ gap: 8 }}>
      <Link className="link-more t-sm" to="/investigations" style={{ alignSelf: 'flex-start' }}>
        <i className="ic ic-chevron-left" aria-hidden="true" />
        부정 거래 조사
      </Link>
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div className="col" style={{ gap: 6, minWidth: 0 }}>
          <h1 className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
            <span>사건 {c.caseId}</span>
            <CaseStatusBadge variant="case" value={v.status} />
          </h1>
          <p className="row wrap t-sm" style={{ gap: '4px 12px' }}>
            <span>
              사유 범주 <span className="badge badge-outline">{REASON_LABEL[c.reasonCategory]}</span>
            </span>
            <span>담당 {c.assignee}</span>
            <span>사건 판 {c.version}</span>
            <span className="row" style={{ gap: 4, alignItems: 'center' }}>
              기록 고정 판 {SNAPSHOT.version}
              <span className="hash">{shortHash(SNAPSHOT.invHash)}</span>
              <button className="icon-btn icon-btn-sm" type="button" aria-label="기록 고정 해시 복사" onClick={() => copy(SNAPSHOT.invHash)}>
                <i className="ic ic-copy" aria-hidden="true" />
              </button>
            </span>
          </p>
          <p className="row wrap t-sm" style={{ gap: 6, alignItems: 'center' }}>
            <span>
              {EVENT.title} · {EVENT.round} {formatKst(EVENT.startsAt)}
            </span>
            <span className="muted">·</span>
            <span>취소 마감 {formatKst(c.cancelDeadlineAt)} KST</span>
            <CancelDeadlineBadge now={now} deadline={c.cancelDeadlineAt} long={passed} />
          </p>
        </div>
      </div>
    </div>
  );
}

/** ① 묶음 요약 */
function SummaryTiles({ v }: { v: View }) {
  const cl = getCluster(v.c.clusterId)!;
  const loading = v.state === '불러오는 중';
  const tiles: { label: string; value: ReactNode; meta?: ReactNode }[] = [
    { label: '계정', value: `${v.c.accountCount}`, meta: `대상 표 ${v.c.ticketCount}장` },
    { label: '구매 대 한도', value: purchaseVsLimit(cl.purchaseCount, EVENT.limitPerPerson), meta: '묶음이 한 사람이면 한도를 넘게 산 셈' },
    { label: '점수 범주', value: <CaseStatusBadge variant="score" value={cl.scoreBand} />, meta: '점수 원값·가중치는 보이지 않습니다' },
    {
      label: '공유 속성 · 근거 신호',
      value: <span className="t-sm fw-b">{cl.sharedAttributes.map((k) => LINK_KIND_LABEL[k]).join('·') || '없음'}</span>,
      meta: cl.signals.map((s) => SIGNAL_LABEL[s]).join('·'),
    },
  ];
  return (
    <section aria-labelledby="sum-h">
      <h2 className="sr-only" id="sum-h">
        묶음 요약
      </h2>
      <div style={{ display: 'grid', gridTemplateColumns: v.phone ? 'repeat(2,minmax(0,1fr))' : 'repeat(4,minmax(0,1fr))', gap: v.phone ? 8 : 12 }}>
        {tiles.map((t) => (
          <div className="stat" key={t.label}>
            <span className="stat-label">{t.label}</span>
            {loading ? (
              <span className="skel" style={{ height: 24, width: '70%' }} />
            ) : (
              <span className="stat-value" style={{ fontSize: v.phone ? 18 : 22, lineHeight: v.phone ? '24px' : '28px' }}>
                {t.value}
              </span>
            )}
            {t.meta ? <span className="stat-meta">{t.meta}</span> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

/** ② 연결 그래프(CMP-080) */
function GraphSection({ v }: { v: View }) {
  const graph0 = graphFor(v.c.caseId);
  const graph = v.state === '그래프가 너무 큼' ? { ...graph0, truncated: true } : graph0;
  const ipNode = graph.nodes.find((n) => n.kind === 'IP') ?? null;
  const outside = graph.nodes.find((n) => n.kind === 'ACCOUNT' && n.inCluster === false) ?? null;
  const initial =
    v.state === '점 고름(IP)' || v.state === 'IP 원문 열기' || v.state === 'IP 원문 열림'
      ? (ipNode?.nodeId ?? null)
      : v.state === '새로 이어진 계정'
        ? (outside?.nodeId ?? null)
        : v.state === '계정 빼기'
          ? (graph.nodes[0]?.nodeId ?? null)
          : null;
  const [selected, setSelected] = useState<string | null>(initial);
  const [table, setTable] = useState(false);
  useEffect(() => setSelected(initial), [initial]);
  const node = graph.nodes.find((n) => n.nodeId === selected) ?? null;
  const loading = v.state === '불러오는 중';
  const canEdit = v.phase === 'investigating' || v.phase === 'appeal';

  if (v.phone) {
    return (
      <Widget id="gr-h" title="연결 표">
        <p className="t-xs muted">휴대폰에서는 그래프 대신 연결 값 표를 봅니다. IP는 앞부분만 보입니다.</p>
        <LinkTable graph={graph} selectedId={null} onSelect={() => undefined} interactive={false} />
        <BigScreenNote what="연결 그래프, IP 원문 열기, 계정 빼기·더하기는 태블릿이나 데스크톱에서 합니다" />
      </Widget>
    );
  }
  return (
    <Widget
      id="gr-h"
      title="연결 그래프"
      actions={
        <button className="btn btn-text btn-sm" type="button" aria-pressed={table} onClick={() => setTable((t) => !t)}>
          {table ? '그림으로 보기' : '표로 보기'}
        </button>
      }
    >
      {graph.truncated ? (
        <div className="banner banner-warning" role="status">
          <i className="ic ic-alert" aria-hidden="true" />
          <div className="banner-body">연결이 너무 많아 앞부분만 그렸습니다(점 2,000개). 묶음을 나눠 보세요</div>
        </div>
      ) : null}
      {v.state === '새로 이어진 계정' && outside ? (
        <div className="banner banner-info" role="status">
          <i className="ic ic-info" aria-hidden="true" />
          <div className="banner-body">새 후보 계산(판 3)에서 이 묶음에 이어진 계정 1개가 있습니다. 확인하고 더할 수 있습니다</div>
        </div>
      ) : null}
      <ul className="legend" aria-label="점 종류">
        {(['ACCOUNT', 'DEVICE', 'PAYMENT_METHOD', 'CONTACT', 'IP', 'ASN'] as const).map((k) => (
          <li className="legend-item" key={k}>
            <LegendShape kind={k} />
            {NODE_KIND_LABEL[k]}
          </li>
        ))}
        <li className="legend-item">
          <LegendShape kind="ACCOUNT" dashed />
          묶음 밖 계정(점선 테두리)
        </li>
      </ul>
      {loading ? (
        <div className="skel" style={{ height: 300 }} />
      ) : table ? (
        <LinkTable graph={graph} selectedId={selected} onSelect={setSelected} interactive />
      ) : (
        <LinkGraph graph={graph} selectedId={selected} onSelect={setSelected} />
      )}
      <p className="t-xs muted">IP는 앞부분만 보입니다. 원문은 사유를 적고 열 때만 보이고, 연 기록은 접속기록에 남습니다</p>
      <NodeInfo v={v} node={node} graph={graph} canEdit={canEdit} />
    </Widget>
  );
}

function NodeInfo({ v, node, graph, canEdit }: { v: View; node: GraphNode | null; graph: ReturnType<typeof graphFor>; canEdit: boolean }) {
  if (!node) return <p className="t-sm muted">점을 고르면 자세히 봅니다. 표로 보기에서도 고를 수 있습니다.</p>;
  const edges = graph.edges.filter((e) => e.from === node.nodeId || e.to === node.nodeId);
  const first = edges.map((e) => e.firstSeenAt).sort()[0];
  const last = edges.map((e) => e.lastSeenAt).sort().at(-1);
  const isIp = node.kind === 'IP';
  const raw = isIp && v.revealed && node.nodeId === REVEALED_IP.nodeId ? v.revealed : null;
  return (
    <div className="card-flat pad col" style={{ gap: 8 }} aria-live="polite">
      <h3 className="eyebrow">점 정보</h3>
      <dl className="kv">
        <dt>종류</dt>
        <dd>{node.kind === 'ACCOUNT' ? (node.inCluster === false ? '계정(묶음 밖)' : '계정') : NODE_KIND_LABEL[node.kind]}</dd>
        <dt>표시값</dt>
        <dd className="mono">{node.label}</dd>
        {raw ? (
          <>
            <dt>원문 IP</dt>
            <dd className="mono">{raw}</dd>
          </>
        ) : null}
        <dt>이어진 점</dt>
        <dd>{edges.length}</dd>
        {first ? (
          <>
            <dt>처음·마지막</dt>
            <dd className="t-xs">
              {formatKst(first)} ~ {formatKst(last ?? first)}
            </dd>
          </>
        ) : null}
        {node.note ? (
          <>
            <dt>덧말</dt>
            <dd className="t-xs">{node.note}</dd>
          </>
        ) : null}
      </dl>
      {raw ? <p className="t-xs tx-warning">이 화면을 떠나면 지웁니다. 원문은 저장하지 않았고, 연 기록과 사유는 접속기록에 남았습니다</p> : null}
      <div className="row wrap" style={{ gap: 8 }}>
        {isIp && !raw ? (
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => v.go('IP 원문 열기')}>
            <i className="ic ic-eye" aria-hidden="true" />
            원문 열기
          </button>
        ) : null}
        {raw ? (
          <button className="btn btn-outline btn-sm" type="button" onClick={() => v.go('점 고름(IP)')}>
            <i className="ic ic-eye-off" aria-hidden="true" />
            원문 숨기기
          </button>
        ) : null}
        {node.kind === 'ACCOUNT' && node.inCluster !== false && canEdit ? (
          <button className="btn btn-outline btn-sm" type="button" onClick={() => v.go('계정 빼기')}>
            묶음에서 빼기
          </button>
        ) : null}
        {node.kind === 'ACCOUNT' && node.inCluster === false && canEdit ? (
          <button className="btn btn-secondary btn-sm" type="button">
            묶음에 더하기(이유 필수)
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** ③ 증거 */
function EvidenceSection({ v }: { v: View }) {
  const none = v.state === '증거 없음';
  const replay = (
    <a className="btn btn-secondary btn-sm" href={investigationReplayHref(EVENT.eventId, v.c.caseId)} target="_blank" rel="noopener noreferrer">
      <i className="ic ic-external" aria-hidden="true" />
      리플레이 열기
      <span className="sr-only">(새 탭, 조사 원천)</span>
    </a>
  );
  return (
    <Widget id="ev-h" title="증거" actions={v.phone ? undefined : replay}>
      {v.phone ? <BigScreenNote what="리플레이 열기와 메모는 태블릿이나 데스크톱에서 합니다" /> : null}
      {none ? (
        <div className="state" style={{ padding: '24px 12px' }}>
          <span className="state-icon">
            <i className="ic ic-doc" aria-hidden="true" />
          </span>
          <p className="t-sm">아직 증거가 없습니다. 리플레이를 열어 보거나 외부 게시물을 등록하고 메모를 남기세요</p>
        </div>
      ) : (
        <>
          <div className="col" style={{ gap: 6 }}>
            <h3 className="eyebrow">외부 게시물(이 회차)</h3>
            <ul className="col" style={{ gap: 6 }}>
              {EXTERNAL_POSTS.map((p) => (
                <li key={p.postId} className="row wrap" style={{ gap: '4px 8px', alignItems: 'center' }}>
                  <span className="mono t-xs">{p.url.replace(/^https?:\/\//, '')}</span>
                  <button className="icon-btn icon-btn-sm" type="button" aria-label={`게시물 주소 ${p.site} 복사`} onClick={() => copy(p.url)}>
                    <i className="ic ic-copy" aria-hidden="true" />
                  </button>
                  <span className="t-xs muted">
                    맞은 티켓 {p.matchedTicketCount}(이 묶음과 맞은 좌석 {v.c.postMatches[p.postId] ?? 0})
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="col" style={{ gap: 6 }}>
            <h3 className="eyebrow">메모 {v.c.memos.length}</h3>
            {v.c.memos.length === 0 ? <p className="t-sm muted">아직 메모가 없습니다</p> : null}
            {v.c.memos.map((m) => (
              <p className="t-sm card-flat pad" key={m.at}>
                {m.text} · {m.who} {formatKst(m.at)}
              </p>
            ))}
          </div>
        </>
      )}
      {!v.phone ? (
        <form className="col" style={{ gap: 6 }} aria-label="메모 더하기" onSubmit={(e) => e.preventDefault()}>
          <label className="label" htmlFor="memo">
            새 메모
          </label>
          <textarea className="textarea" id="memo" style={{ minHeight: 64 }} placeholder="본 것과 판단을 적습니다. 연락처·IP 원문은 적지 마세요" aria-describedby="memo-h" />
          <span className="hint" id="memo-h">
            지난 메모는 고치지 않고, 누가·언제 적었는지 사건 기록에 남습니다
          </span>
          <button className="btn btn-outline btn-sm" type="submit" style={{ alignSelf: 'flex-start' }}>
            메모 더하기
          </button>
        </form>
      ) : null}
    </Widget>
  );
}

/** ⑧ 사건 기록 */
function CaseLog({ v }: { v: View }) {
  const { c, phase } = v;
  const base = c.caseId === 'CASE-2610-0007' ? [...CASE_EVENTS] : [{ at: c.createdAt, who: c.assignee, what: `후보 묶음 ${c.clusterId}로 사건을 만들었습니다` }];
  const more: { at: string; who: string; what: string }[] = c.memos.map((m) => ({ at: m.at, who: m.who, what: `메모: ${m.text}` }));
  // 정상 종료는 두 길이다: 근거가 없어 닫음(C2, 소명 요청 없음) · 모든 계정의 소명 인정(C4)
  const allAccepted = c.appealCounts.accepted === c.accountCount;
  if (phase !== 'investigating' && (phase !== 'cleared' || allAccepted)) more.push({ at: c.timeline.appealRequestedAt, who: c.assignee, what: `소명 요청 ${c.accountCount}계정 · 기한 ${formatKst(c.timeline.appealDueAt)} · 양도 잠금 ${c.ticketCount}장` });
  if (phase === 'decision' || phase === 'actioned' || phase === 'objected') more.push({ at: c.timeline.actionRequestedAt, who: c.assignee, what: '조치 요청(표 취소와 환급) → 승인 업무' });
  if (phase === 'actioned' || phase === 'objected') more.push({ at: c.timeline.actionedAt, who: '시스템', what: '승인(수진) 뒤 실행 끝 · 증거 묶음 봉인' });
  if (phase === 'objected') more.push({ at: plus(c.timeline.actionedAt, 20 * HOUR), who: '팬', what: '이의 2건 접수' });
  if (phase === 'cleared')
    more.push(
      allAccepted
        ? { at: plus(c.timeline.appealDueAt, HOUR), who: c.assignee, what: '모든 계정의 소명 인정 · 정상 종료 · 정답 라벨 사람 · 양도 잠금 모두 풂' }
        : { at: NOW, who: c.assignee, what: '근거가 없어 정상 종료 · 정답 라벨 사람' },
    );
  const items = [...base, ...more].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return (
    <Widget id="log-h" title="사건 기록">
      <ol className="timeline">
        {items.map((e, i) => (
          <li className="tl-item" key={i}>
            <span className="tl-dot" />
            <span className="col" style={{ gap: 2 }}>
              <span className="t-sm">{e.what}</span>
              <span className="t-xs muted">
                {formatKst(e.at)} KST · {e.who}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </Widget>
  );
}

/** ④ 소명 요청 */
function AppealRequestSection({ v }: { v: View }) {
  const { c, phase, now } = v;
  if (phase !== 'investigating') {
    return (
      <Widget id="ap-h" title="소명 요청">
        <dl className="kv">
          <dt>보낸 때</dt>
          <dd>{formatKst(c.timeline.appealRequestedAt)}</dd>
          <dt>기한</dt>
          <dd>{formatKst(c.timeline.appealDueAt)}</dd>
          <dt>대상</dt>
          <dd>
            {c.accountCount}계정 · 양도 잠금 {c.ticketCount}장
          </dd>
          {/* 계정마다 그 계정의 첫 소명 요청 + 14일(연장 없음, ADR-0173 결정 3). 입장이 먼저 시작되면 그때 풀린다(추천 적용 2026-10-31) */}
          <dt>잠금 최대 기한</dt>
          <dd>
            {/* '양도 잠금 최대 기한 지남'은 그림 상태다. 목업 회차는 입장 시작(10/25)이 첫 후보 묶음(10/14) + 14일보다 먼저 와서
                이 회차의 날짜로는 14일 상한이 먼저 올 수 없다. 그래서 이 상태에서는 날짜 대신 규칙(계정마다 이 사건의 첫 소명 요청 + 14일,
                늘지 않음)과 지난 계정 수만 적어, 아직 오지 않은 날짜와 '지남'이 한 화면에 함께 보이지 않게 한다
                (ADR-0173 결정 3, docs/data.md 잠금 행, FRN-090 리뷰 결함 5, 추천 적용 2026-10-31) */}
            {v.state === '양도 잠금 최대 기한 지남'
              ? `계정마다 첫 소명 요청 + 14일 · 계정 ${LOCK_RELEASED_ACCOUNTS}개 지남`
              : formatKst(transferLockExpiresAt(c.timeline.appealRequestedAt))}
          </dd>
        </dl>
        {phase === 'appeal' ? (
          <span className="badge badge-warning" style={{ alignSelf: 'flex-start' }}>
            <i className="ic ic-clock" aria-hidden="true" />
            {remainingHoursText(now, c.timeline.appealDueAt)}
          </span>
        ) : null}
        {phase === 'appeal' ? <p className="t-xs muted">묶음에 더한 계정에는 따로 소명 요청을 보냅니다.</p> : null}
      </Widget>
    );
  }
  if (v.phone) {
    return (
      <Widget id="ap-h" title="소명 요청">
        <p className="t-sm muted">아직 소명을 요청하지 않았습니다.</p>
        <BigScreenNote what="소명 요청은 태블릿이나 데스크톱에서 합니다" />
      </Widget>
    );
  }
  const due = defaultAppealDue(now, c.cancelDeadlineAt);
  const keepCancel = appealDueLeavesCancel(due, c.cancelDeadlineAt);
  const members = membersFor(c.caseId, () => 'NOT_REQUESTED');
  return (
    <Widget id="ap-h" title="소명 요청">
      <form className="col" style={{ gap: 10 }} aria-label="소명 요청" onSubmit={(e) => e.preventDefault()}>
        <fieldset className="col" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
          <legend className="label" style={{ marginBottom: 6 }}>
            보낼 계정 {members.length}
          </legend>
          <label className="check-row" htmlFor="ap-all">
            <input className="cb" type="checkbox" id="ap-all" defaultChecked />
            모두 고르기
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: '4px 8px' }}>
            {members.map((m) => (
              <label className="check-row t-xs mono" key={m.accountId} htmlFor={`ap-${m.accountId}`}>
                <input className="cb" type="checkbox" id={`ap-${m.accountId}`} defaultChecked />
                {m.accountId}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="col" style={{ gap: 4, border: 0, padding: 0, margin: 0 }}>
          <legend className="label" style={{ marginBottom: 6 }}>
            사유 범주(하나 이상)
          </legend>
          {Object.entries(REASON_LABEL).map(([k, label]) => (
            <label className="check-row t-sm" key={k} htmlFor={`rc-${k}`}>
              <input className="cb" type="checkbox" id={`rc-${k}`} defaultChecked={k === c.reasonCategory} />
              {label}
            </label>
          ))}
        </fieldset>
        <div className="field">
          <label className="label" htmlFor="ap-due">
            기한
          </label>
          <input className="input" id="ap-due" defaultValue={`${formatKst(due)} KST`} aria-describedby="ap-due-h" />
          <span className="hint" id="ap-due-h">
            기본값은 요청 + 3일과 취소 마감 − 6시간 가운데 이른 쪽이고, 요청 + 24시간보다 짧지 않습니다
          </span>
        </div>
        {!keepCancel ? (
          <p className="t-xs tx-warning">기한이 취소 마감 6시간 전보다 늦어, 이 사건은 표 취소를 고를 수 없고 이용 제한만 남을 수 있습니다</p>
        ) : null}
        <div className="banner banner-warning">
          <i className="ic ic-lock" aria-hidden="true" />
          <div className="banner-body">{APPEAL_LOCK_NOTICE}</div>
        </div>
        <div className="banner banner-info">
          <i className="ic ic-users" aria-hidden="true" />
          <div className="banner-body">돈이 오가지 않은 가족 대리 예매는 부정 예매가 아닙니다</div>
        </div>
        <p className="t-xs muted">{HOLDER_NOTICE}</p>
        <button className="btn btn-primary" type="button" onClick={() => v.go('소명 요청 확인')}>
          소명 요청 보내기
        </button>
      </form>
    </Widget>
  );
}

/** ⑤ 소명 결과와 판단(이의 접수에서는 이의 판단) */
function AppealResultSection({ v }: { v: View }) {
  const { c, phase } = v;
  const members = membersFor(c.caseId, resultsOf(phase, c));
  if (phase === 'objected') {
    const objectors = members.slice(0, 2);
    return (
      <Widget id="ar-h" title="이의 판단">
        <p className="t-sm">이의 {objectors.length}건 · 계정마다 인정·기각과 이유를 적으세요</p>
        <ul className="col" style={{ gap: 8 }}>
          {objectors.map((m) => (
            <li key={m.accountId} className="card-flat pad col" style={{ gap: 6 }}>
              <span className="row between">
                <span className="mono t-xs">{m.accountId}</span>
                <span className="badge badge-warning">이의 접수</span>
              </span>
              {v.phone ? null : (
                <span className="row wrap" style={{ gap: 6 }}>
                  <button className="btn btn-secondary btn-sm" type="button">
                    이의 인정
                  </button>
                  <button className="btn btn-outline btn-sm" type="button">
                    이의 기각
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
        <p className="t-xs muted">이의를 인정하면 이용 제한은 풀기 승인을 요청하고, 취소한 표는 우선 구매나 보상으로 되돌립니다</p>
        {v.phone ? <BigScreenNote what="이의 판단은 태블릿이나 데스크톱에서 합니다" /> : null}
      </Widget>
    );
  }
  // 양도 잠금 최대 기한 지남(일부): 앞 계정 셋의 잠금이 풀린 그림(d5 §7.19, ADR-0173 결정 3)
  const released = v.state === '양도 잠금 최대 기한 지남' ? LOCK_RELEASED_ACCOUNTS : 0;
  // 받은 사람의 진술은 소명을 요청한 뒤에 생긴다(같은 기한, ADR-0173 결정 4)
  const holders = phase === 'investigating' ? [] : holdersFor(c.caseId);
  return (
    <Widget id="ar-h" title="소명 결과와 판단">
      <ul className="col" style={{ gap: 6 }} aria-label="계정별 소명 결과">
        {members.map((m, i) => (
          <li key={m.accountId} className="row between" style={{ gap: 8, alignItems: 'center' }}>
            <span className="mono t-xs">
              {m.accountId} · {m.ticketCount}장
            </span>
            <span className="row" style={{ gap: 6, alignItems: 'center' }}>
              {i < released ? <span className="badge badge-outline">잠금 풀림</span> : null}
              <CaseStatusBadge variant="appeal" value={m.appealResult} />
              {m.appealResult === 'SUBMITTED' && !v.phone ? (
                <>
                  <button className="btn btn-secondary btn-sm" type="button" aria-label={`${m.accountId} 소명 인정`}>
                    인정
                  </button>
                  <button className="btn btn-outline btn-sm" type="button" aria-label={`${m.accountId} 소명 불인정`}>
                    불인정
                  </button>
                </>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {members.some((m) => m.appealResult === 'SUBMITTED') ? <p className="t-xs muted">판단에는 이유가 필요합니다. 인정한 계정의 양도 잠금은 바로 풀립니다</p> : null}
      {v.phone && members.some((m) => m.appealResult === 'SUBMITTED') ? <BigScreenNote what="소명 판단은 태블릿이나 데스크톱에서 합니다" /> : null}
      {holders.length > 0 ? (
        <div className="col" style={{ gap: 6 }}>
          <h3 className="eyebrow">받은 사람의 진술</h3>
          <ul className="col" style={{ gap: 6 }} aria-label="받은 사람의 진술">
            {holders.map((h) => (
              <li key={h.seatLabel} className="row between" style={{ gap: 8, alignItems: 'center' }}>
                <span className="t-xs">{h.seatLabel} · 보유자 진술</span>
                <span className="row" style={{ gap: 6, alignItems: 'center' }}>
                  {h.statement === 'SUBMITTED' ? <span className="badge badge-primary">냄</span> : <span className="badge">기다림</span>}
                  {h.statement === 'SUBMITTED' && !v.phone ? (
                    <button className="btn btn-text btn-sm" type="button" aria-label={`${h.seatLabel} 보유자 진술 본문 보기`}>
                      본문 보기
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
          <p className="t-xs muted">판단은 조치 요청에서 그 표를 대상에 넣을지로 합니다</p>
        </div>
      ) : null}
    </Widget>
  );
}

/** 정상 종료(CLEARED): 소명·조치 자리 대신 종료 결과만(d5 §7.19). 근거 없음(C2)과 모든 계정 소명 인정(C4) 두 길이다 */
function ClearedSection({ v }: { v: View }) {
  const allAccepted = v.c.appealCounts.accepted === v.c.accountCount;
  return (
    <Widget id="cl-h" title="정상 종료">
      <p className="t-sm">
        {allAccepted ? '모든 계정의 소명이 인정되어 정상 종료했습니다. 양도 잠금을 모두 풀었습니다' : '근거가 없어 정상 종료했습니다. 양도 잠금을 모두 풀었습니다'}
      </p>
      <p className="row" style={{ gap: 6, alignItems: 'center' }}>
        <span className="t-xs muted">정답 라벨</span>
        <span className="badge badge-success">사람</span>
      </p>
    </Widget>
  );
}

/** ⑥ 조치 요청 */
function ActionSection({ v }: { v: View }) {
  const { c, phase, now } = v;
  if (phase === 'decision') {
    return (
      <Widget id="ac-h" title="조치 요청">
        <div className="banner banner-info" role="status">
          <i className="ic ic-users" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">승인 업무에서 다른 승인자가 확인하고 있습니다</span>
            표 취소와 환급 · {c.accountCount}계정 {c.ticketCount}장 · 요청 {formatKst(c.timeline.actionRequestedAt)}
          </div>
        </div>
        <p className="t-xs muted">조치는 다른 승인자가 확인해야 실행됩니다</p>
        <div className="row wrap" style={{ gap: 8 }}>
          <Link className="link-more" to="/cs/approvals">
            승인 업무
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </Link>
          {v.phone ? null : (
            <button className="btn btn-outline btn-sm" type="button">
              요청 철회(사유 필수)
            </button>
          )}
        </div>
        {v.phone ? <BigScreenNote what="요청 철회는 태블릿이나 데스크톱에서 합니다" /> : null}
      </Widget>
    );
  }
  if (phase === 'actioned' || phase === 'objected') {
    return (
      <Widget id="ac-h" title="조치">
        <p className="t-sm">표 {c.ticketCount}장을 취소하고 환급을 접수했습니다. 취소한 좌석은 정가 재판매로 돌렸습니다</p>
        <dl className="kv">
          <dt>실행</dt>
          <dd>{formatKst(c.timeline.actionedAt)}</dd>
          <dt>이의 창 끝</dt>
          <dd>{formatKst(c.timeline.objectionDueAt)}</dd>
        </dl>
      </Widget>
    );
  }
  if (v.phone) {
    return (
      <Widget id="ac-h" title="조치 요청">
        <p className="t-xs muted">조치는 다른 승인자가 확인해야 실행됩니다</p>
        <BigScreenNote what="조치 요청은 태블릿이나 데스크톱에서 합니다" />
      </Widget>
    );
  }
  const ready = phase === 'deadline-passed';
  const passed = cancelDeadlineNotice(now, c.cancelDeadlineAt).tone === 'passed';
  const reason = phase === 'investigating' ? '소명을 요청하고 기한이 지난 뒤에 요청할 수 있습니다' : '소명 기한이 지난 뒤에 요청할 수 있습니다';
  // 받은 사람이 가진 표는 진술을 받은 뒤(소명 요청 뒤)에 알 수 있다(ADR-0173 결정 4)
  const holders = phase === 'investigating' ? [] : holdersFor(c.caseId);
  return (
    <Widget id="ac-h" title="조치 요청">
      <form className="col" style={{ gap: 10 }} aria-label="조치 요청" onSubmit={(e) => e.preventDefault()}>
        <fieldset className="col" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
          <legend className="label" style={{ marginBottom: 6 }}>
            조치 종류
          </legend>
          <label className="check-row" htmlFor="act-cancel">
            <input className="rd" type="radio" name="act" id="act-cancel" defaultChecked={!passed} disabled={passed} aria-describedby={passed ? 'act-cancel-why' : undefined} />
            표 취소와 환급
          </label>
          {passed ? (
            <span className="t-xs tx-warning" id="act-cancel-why">
              취소 마감({formatKst(c.cancelDeadlineAt)} KST)이 지나 표 취소는 고를 수 없습니다. 이용 제한만 요청할 수 있습니다
            </span>
          ) : null}
          <label className="check-row" htmlFor="act-restrict">
            <input className="rd" type="radio" name="act" id="act-restrict" defaultChecked={passed} />
            이용 제한
          </label>
        </fieldset>
        <RestrictionEnd now={now} tooLong={v.state === '이용 제한이 너무 김'} />
        <fieldset className="col" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
          <legend className="label" style={{ marginBottom: 6 }}>
            대상 계정·표
          </legend>
          <p className="t-sm">
            {c.accountCount}계정 · 결제 표 {c.ticketCount}장
          </p>
          {holders.length > 0 ? (
            <>
              {holders.map((h, i) => (
                <label className="check-row t-sm" key={h.seatLabel} htmlFor={`act-h-${i}`}>
                  <input className="cb" type="checkbox" id={`act-h-${i}`} aria-describedby="act-h-hint" />
                  받은 사람이 가진 표 {h.seatLabel}(진술 {h.statement === 'SUBMITTED' ? '냄' : '기다림'})
                </label>
              ))}
              <span className="hint" id="act-h-hint">
                받은 사람이 가진 표는 기본으로 빠져 있습니다. 진술을 본 뒤 표마다 넣습니다
              </span>
            </>
          ) : null}
        </fieldset>
        <div className="field">
          <label className="label" htmlFor="act-basis">
            근거
          </label>
          <textarea className="textarea" id="act-basis" style={{ minHeight: 56 }} placeholder="소명 결과와 근거 신호를 적습니다" />
        </div>
        <div className="field">
          <label className="label" htmlFor="act-op">
            조사관 의견
          </label>
          <textarea className="textarea" id="act-op" style={{ minHeight: 56 }} defaultValue={c.investigatorOpinion} aria-describedby="act-op-h act-op-rule" />
          <span className="hint" id="act-op-h">
            승인자가 승인 업무의 사건 요약에서 읽습니다
          </span>
          <span className="hint" id="act-op-rule">
            {OPINION_HINT}
          </span>
        </div>
        <p className="t-xs muted">조치는 다른 승인자가 확인해야 실행됩니다</p>
        {ready ? (
          <button className="btn btn-primary" type="button">
            {passed ? '이용 제한 승인을 요청합니다' : '조치 승인을 요청합니다'}
          </button>
        ) : (
          <>
            <button className="btn btn-primary" type="button" aria-disabled="true" aria-describedby="act-why" onClick={(e) => e.preventDefault()}>
              조치 요청
            </button>
            <span className="t-xs muted" id="act-why">
              {reason}
            </span>
          </>
        )}
      </form>
    </Widget>
  );
}

/** KST 'YYYY-MM-DDTHH:mm'(datetime-local 칸 값) */
const kstInput = (iso: string) => new Date(Date.parse(iso) + 9 * HOUR).toISOString().slice(0, 16);

/** 이용 제한 끝(요청 + 1년 [가정]까지, ADR-0173 결정 7). 너무 길면 칸 오류(서버 422 restriction-too-long) */
function RestrictionEnd({ now, tooLong }: { now: string; tooLong: boolean }) {
  const max = restrictionEndMax(now);
  // '이용 제한이 너무 김' 그림: 1년을 두 달 넘긴 끝을 고른 칸(추천 적용 2026-10-31)
  const [value, setValue] = useState(kstInput(tooLong ? new Date(Date.parse(max) + 68 * 24 * HOUR).toISOString() : max));
  const err = restrictionEndError(now, `${value}:00+09:00`);
  return (
    <div className={`field ${err ? 'is-error' : ''}`.trim()}>
      <label className="label" htmlFor="act-end">
        이용 제한 끝
      </label>
      <input
        className="input"
        id="act-end"
        type="datetime-local"
        value={value}
        max={kstInput(max)}
        onChange={(e) => setValue(e.target.value)}
        aria-invalid={err ? 'true' : undefined}
        aria-describedby={err ? 'act-end-e act-end-h' : 'act-end-h'}
      />
      {err ? (
        <span className="error-msg" id="act-end-e" role="alert">
          {err}
        </span>
      ) : null}
      <span className="hint" id="act-end-h">
        요청한 날부터 1년({new Date(Date.parse(max) + 9 * HOUR).getUTCFullYear()}년 {formatKst(max)} KST)까지 고를 수 있습니다
      </span>
    </div>
  );
}

/** ⑦ 증거 묶음 */
function BundleSection({ v }: { v: View }) {
  const { phase } = v;
  const sealed = phase === 'actioned' || phase === 'objected';
  if (!sealed) {
    return (
      <Widget id="bd-h" title="증거 묶음">
        <p className="t-sm muted">{phase === 'cleared' ? '정상 종료한 사건은 증거 묶음을 만들지 않습니다' : '조치한 뒤에 만들 수 있습니다'}</p>
        <p className="t-xs muted">기관 제출은 접수된 자료 요청에 묶어서만, 기획사 보고는 회차 집계만 냅니다</p>
      </Widget>
    );
  }
  const b = EVIDENCE_BUNDLE;
  const complaint = v.state === '고소·고발용 요약 받음';
  return (
    <Widget id="bd-h" title="증거 묶음">
      <span className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
        <span className="badge badge-success">
          <i className="ic ic-lock" aria-hidden="true" />
          봉인
        </span>
        <span className="t-xs muted">보존 이유 {b.holdReason}</span>
      </span>
      <span className="row" style={{ gap: 4, alignItems: 'center' }}>
        <span className="t-xs muted">묶음 해시</span>
        <span className="hash">{shortHash(b.manifestSha256)}</span>
        <button className="icon-btn icon-btn-sm" type="button" aria-label="증거 묶음 해시 복사" onClick={() => copy(b.manifestSha256)}>
          <i className="ic ic-copy" aria-hidden="true" />
        </button>
      </span>
      <div className="table-wrap table-scroll">
        <table className="table">
          <caption className="sr-only">증거 묶음 파일</caption>
          <thead>
            <tr>
              <th scope="col">파일</th>
              <th scope="col" className="num">
                크기
              </th>
              <th scope="col">SHA-256</th>
            </tr>
          </thead>
          <tbody>
            {b.files.map((f) => (
              <tr key={f.name}>
                <td className="mono t-xs">{f.name}</td>
                <td className="num t-xs">{new Intl.NumberFormat('ko-KR').format(f.sizeBytes)}</td>
                <td className="hash">{shortHash(f.sha256)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 className="eyebrow">관리 연속성 기록</h3>
      <ol className="timeline">
        {b.custody.map((e, i) => (
          <li className="tl-item" key={i}>
            <span className="tl-dot ok" />
            <span className="col" style={{ gap: 2 }}>
              <span className="t-sm">{e.what}</span>
              <span className="t-xs muted">
                {formatKst(e.at)} KST · {e.who}
              </span>
            </span>
          </li>
        ))}
      </ol>
      {v.phone ? (
        <BigScreenNote what="증거 묶음 내보내기는 태블릿이나 데스크톱에서 합니다" />
      ) : (
        <form className="col" style={{ gap: 8 }} aria-label="증거 묶음 내보내기" onSubmit={(e) => e.preventDefault()}>
          <label className="label" htmlFor="ex-kind">
            내보내기
          </label>
          {/* 종류 셋(openapi EvidenceExport.kind). 고소·고발용 요약은 개인정보 없이 사유를 적고 받는다(ADR-0173 결정 6) */}
          <select className="input input-sm" id="ex-kind" defaultValue={complaint ? 'COMPLAINT' : 'PROMOTER'}>
            {EXPORT_KINDS.map((k) => (
              <option key={k} value={k}>
                {EXPORT_KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <input className="input input-sm" aria-label="자료 요청 번호(기관 제출일 때)" placeholder="자료 요청 번호(기관 제출일 때)" />
          <input className="input input-sm" aria-label="내보내기 사유(필수)" placeholder="내보내기 사유(필수)" />
          <button className="btn btn-outline btn-sm" type="submit" style={{ alignSelf: 'flex-start' }}>
            <i className="ic ic-download" aria-hidden="true" />
            내보내기
          </button>
          {complaint ? (
            // 고소·고발용 요약 받음(내보내기 COMPLAINT 200, d5 §7.19)
            <div className="card-flat pad col" style={{ gap: 4 }} role="status">
              <span className="row" style={{ gap: 6, alignItems: 'center' }}>
                <i className="ic ic-check" aria-hidden="true" />
                <span className="t-sm">
                  내려받음 <span className="mono">{complaintFileName(v.c.caseId)}</span>
                </span>
              </span>
              <span className="t-xs muted">{COMPLAINT_NOTE}</span>
            </div>
          ) : null}
        </form>
      )}
    </Widget>
  );
}

function IpRevealDialog({ close, go }: { close: () => void; go: (s: string) => void }) {
  return (
    <Overlay onClose={close}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="ipr-t" aria-describedby="ipr-d" style={{ maxWidth: 460 }}>
        <h2 className="dialog-title" id="ipr-t">
          IP 원문 열기
        </h2>
        <p className="t-sm" id="ipr-d">
          고른 IP 점 1개의 원문을 엽니다. 원문은 이 화면에만 잠깐 보이고 저장되지 않습니다. 연 기록과 사유는 접속기록에 남습니다
        </p>
        <div className="field">
          <label className="label" htmlFor="ipr-why">
            열람 사유
          </label>
          <textarea className="textarea" id="ipr-why" minLength={5} maxLength={500} style={{ minHeight: 72 }} aria-describedby="ipr-h" placeholder="예: 같은 IP를 쓴 계정이 같은 사람인지 확인" />
          <span className="hint" id="ipr-h">
            5~500자. 개인정보를 적지 마세요. 한 번에 50개, 하루 200개까지 열 수 있습니다
          </span>
        </div>
        <div className="dialog-actions">
          <button className="btn btn-ghost" type="button" onClick={close}>
            닫기
          </button>
          <button className="btn btn-primary" type="button" onClick={() => go('IP 원문 열림')}>
            사유를 남기고 원문을 엽니다
          </button>
        </div>
      </div>
    </Overlay>
  );
}

function RemoveAccountDialog({ close, account }: { close: () => void; account: GraphNode }) {
  return (
    <Overlay onClose={close}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="rm-t" aria-describedby="rm-d" style={{ maxWidth: 460 }}>
        <h2 className="dialog-title" id="rm-t">
          묶음에서 계정 빼기
        </h2>
        <p className="t-sm">
          <span className="mono">{account.label}</span>
        </p>
        <div className="field">
          <label className="label" htmlFor="rm-why">
            뺄 이유(필수)
          </label>
          <textarea className="textarea" id="rm-why" style={{ minHeight: 72 }} aria-describedby="rm-d" />
        </div>
        <p className="t-sm" id="rm-d">
          사건 기록에 남습니다. 뺀 계정에 걸린 양도 잠금은 바로 풀립니다
        </p>
        <div className="dialog-actions">
          <button className="btn btn-ghost" type="button" onClick={close}>
            닫기
          </button>
          <button className="btn btn-danger" type="button" onClick={close}>
            이유를 남기고 묶음에서 뺍니다
          </button>
        </div>
      </div>
    </Overlay>
  );
}

function AppealConfirmDialog({ close, go, c }: { close: () => void; go: (s: string) => void; c: FraudCaseFixture }) {
  const due = defaultAppealDue(NOW, c.cancelDeadlineAt);
  const keepCancel = appealDueLeavesCancel(due, c.cancelDeadlineAt);
  // 잠금 최대 기한은 이 요청으로 처음 잠기는 계정의 기한(지금 + 14일)이고, 받은 사람에게도 같은 기한으로 알린다(ADR-0173 결정 3·4)
  const lockUntil = transferLockExpiresAt(NOW);
  const holders = holdersFor(c.caseId);
  return (
    <Overlay onClose={close}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="apc-t" aria-describedby="apc-d" style={{ maxWidth: 480 }}>
        <h2 className="dialog-title" id="apc-t">
          소명 요청 보내기
        </h2>
        <dl className="kv" id="apc-d">
          <dt>보낼 계정</dt>
          <dd>{c.accountCount}</dd>
          <dt>잠기는 표</dt>
          <dd>
            {c.ticketCount}장(늦어도 14일 뒤 {formatKst(lockUntil)}에 풀림)
          </dd>
          <dt>진행 중인 양도 요청</dt>
          <dd>1건은 시스템이 철회합니다</dd>
          {holders.length > 0 ? (
            <>
              <dt>받은 사람</dt>
              <dd>표를 받아 가진 분 {holders.length}명에게도 알립니다</dd>
            </>
          ) : null}
          <dt>사유 범주</dt>
          <dd>{REASON_LABEL[c.reasonCategory]}</dd>
          <dt>기한</dt>
          <dd>{formatKst(due)} KST</dd>
        </dl>
        {!keepCancel ? (
          <p className="t-xs tx-warning">기한이 취소 마감 6시간 전({formatKst(new Date(Date.parse(c.cancelDeadlineAt) - 6 * HOUR).toISOString())} KST)보다 늦어, 이 사건은 표 취소를 고를 수 없고 이용 제한만 남을 수 있습니다</p>
        ) : null}
        <p className="t-sm">{APPEAL_LOCK_NOTICE}. 입장은 막지 않습니다.</p>
        <div className="dialog-actions">
          <button className="btn btn-ghost" type="button" onClick={close}>
            닫기
          </button>
          <button className="btn btn-primary" type="button" onClick={() => go('소명 대기')}>
            {c.accountCount}계정에 소명 요청을 보내고 양도를 잠급니다
          </button>
        </div>
      </div>
    </Overlay>
  );
}

// 다른 사건 목록(회차 요약)은 SCR-070이 쓴다
void CASES;
