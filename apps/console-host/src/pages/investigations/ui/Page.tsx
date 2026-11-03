// SCR-070 부정 거래 조사 사건 목록(/investigations, d5 §7.18, docs/planning/04 SCR-070). 디자인 캔버스 보드가 없어 d5 그림과 키트 부품으로 그렸다.
// 배치마다 마크업을 따로 두지 않고 한 벌에서 열 수와 순서만 바꾼다(add-fraud-investigation-screens design.md 결정 2):
// 데스크톱 12열(왼쪽 8열 후보 묶음·사건 | 오른쪽 4열 외부 게시물), 태블릿 한 단(표는 가로 스크롤), 휴대폰 한 단 카드 목록(사건 만들기·게시물 등록은 안내 카드).
// 지정 부정 거래 조사관만 연다(메뉴 숨김은 화면 장치, 서버가 요청마다 지정을 본다, control-tower §9.2). 점수 원값·가중치는 어디에도 보이지 않는다(범주만).
// 게시물 주소는 누르는 링크로 만들지 않고 글자와 복사 단추로 보인다(forensic-replay §6.7.7). 데이터는 목업(entities/fraud-case)이다.
// 외부 게시물 등록은 최소한만 받는다(ADR-0173 결정 9, apply-legal-review-to-screens): 확인 칸 셋을 모두 체크해야 등록 단추가 켜지고, 캡처 위에서 가릴 자리를 고르며
// (글자 읽기 없음), 신고 출처는 문의 유형 '외부 되팔이 게시물 신고' 건만 받는다. 원천 만료는 그 회차 공연일 + 30일 [가정]이다(결정 7).
import { useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { previewHref } from '@peaket/ds/Preview';
import { CaseStatusBadge } from '@peaket/ds/CaseStatusBadge';
import {
  ERR_REPORT_SOURCE,
  MASK_NONE_HINT,
  POST_CHECKS,
  candidateRetryText,
  postRegisterEnabled,
  CancelDeadlineBadge,
  CASES,
  CLUSTERS,
  EVENT,
  EVENTS,
  EXTERNAL_POSTS,
  formatKst,
  getCase,
  LINK_KIND_LABEL,
  NOW,
  purchaseVsLimit,
  REASON_LABEL,
  remainingHoursText,
  ROUND_SUMMARY,
  SIGNAL_LABEL,
  SNAPSHOT,
  type Cluster,
  type FraudCaseFixture,
} from '@/entities/fraud-case';
import { DESIGNATED, isInvestigator } from '@/entities/operator';
import { useChosenRole, useHost, usePreviewHost } from '@/features/preview-host';
import { BigScreenNote, InvestigatorDenied } from '@/features/screen-access';
import { useBoardPage, type BoardGaps } from '@/shared/lib/board';
import { usePreviewKeep } from '@/shared/lib/preview';
import { Overlay } from '@/shared/ui/Overlay';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { DEFAULT, STATES, type State } from '../states';

const TITLE = '부정 거래 조사';

/** 휴대폰 배치에 없는 상태(사건 만들기는 태블릿·데스크톱에서만, d5 §3.9) */
const GAPS: BoardGaps<State> = { phone: { '사건 만들기': null, '게시물 파일 거절': null, '오류 · 신고 출처 아님': null } };

/** '후보 만들기 다시 시도 중' 그림의 남은 자동 다시 시도(openapi FraudClusterRun.autoRetriesLeft, 처음 셋 [가정]) */
const RETRIES_LEFT = 2;

/** 상태마다의 '지금'(취소 마감 단계 그림은 그 시각으로 본다) */
const NOW_OF: Partial<Record<State, string>> = {
  '취소 마감 12시간 전': '2026-10-24T04:00:00+09:00',
  '취소 마감 2시간 전': '2026-10-24T14:00:00+09:00',
  '취소 마감 지남': '2026-10-24T16:30:00+09:00',
  '원천 만료': '2026-11-25T10:00:00+09:00',
};

const timeOf = (iso: string) => `${formatKst(iso).split(' ')[1]}:05 KST`;
const shortHash = (h: string) => `${h.slice(0, 8)}…${h.slice(-8)}`;
const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => undefined);

export function Page() {
  const chosen = useChosenRole();
  const { state, boardStates, layout, close, go } = useBoardPage(TITLE, STATES, DEFAULT, GAPS);
  const now = NOW_OF[state] ?? NOW;
  usePreviewHost(
    {
      scope: { stage: '종료 후' },
      control: { kind: 'ok' },
      clock: timeOf(now),
      ...(chosen ? {} : { session: { ...DESIGNATED.investigator, designations: DESIGNATED.investigator.designations ?? [] } }),
    },
    [state, chosen],
  );
  const host = useHost();
  // 사건 만들기 대화상자는 누른 줄의 묶음을 보인다(주소의 ?cluster=, 퍼블리싱 상태라 주소에 둔다)
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const keep = usePreviewKeep();
  const openCreate = (clusterId: string) => navigate(previewHref(pathname, '사건 만들기', { ...keep, cluster: clusterId }));
  const createFor = CLUSTERS.find((c) => c.clusterId === params.get('cluster') && c.caseId === null) ?? CLUSTERS.find((c) => c.caseId === null)!;
  const allowed = isInvestigator(host.session.role, host.session.designations) && state !== '권한 없음(지정 없음)';

  if (!allowed) {
    return (
      <>
        <InvestigatorDenied />
        <PreviewSwitcher states={boardStates} current={state} />
      </>
    );
  }

  const phone = layout === 'phone';
  const desktop = layout === 'desktop';
  const empty = state === '후보 아직 없음';
  const expired = state === '원천 만료';
  const loading = state === '불러오는 중';
  const deadlineTone = state === '취소 마감 지남' || expired;

  const main = (
    <>
      <ClusterSection state={state} phone={phone} go={go} openCreate={openCreate} />
      <CaseSection state={state} phone={phone} now={now} />
    </>
  );
  // 상태를 바꾸면(화면 안 이동) 확인 칸·신고 건 칸을 그 상태의 처음 값으로 다시 그린다(FRN-090 리뷰 결함 4)
  const side = <PostSection key={state} state={state} phone={phone} />;

  return (
    <>
      <div className="page-head">
        <div className="col" style={{ gap: 4 }}>
          <h1>{TITLE}</h1>
          <p className="t-sm muted">판매가 끝난 뒤 실제 기록으로 부정 예매 후보를 묶어 보고, 사건을 만들어 조사합니다.</p>
        </div>
      </div>

      <RunBar state={state} now={now} phone={phone} />

      {!empty ? (
        <div className="banner banner-info" role="note">
          <i className="ic ic-info" aria-hidden="true" />
          <div className="banner-body">후보 묶음은 조치가 아닙니다. 사건을 만들어 조사하세요</div>
        </div>
      ) : null}
      {deadlineTone ? (
        <div className="banner banner-info" role="status">
          <i className="ic ic-clock" aria-hidden="true" />
          <div className="banner-body">표 취소는 더 요청할 수 없습니다. 이용 제한만 요청할 수 있습니다</div>
        </div>
      ) : null}

      <Summary state={state} phone={phone} />

      {desktop ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12,minmax(0,1fr))', gap: 16, alignItems: 'start' }}>
          <div className="col" style={{ gridColumn: 'span 8', gap: 16, minWidth: 0 }}>
            {main}
          </div>
          <div className="col" style={{ gridColumn: 'span 4', gap: 16, minWidth: 0 }}>
            {side}
          </div>
        </div>
      ) : (
        <div className="col" style={{ gap: phone ? 12 : 16, minWidth: 0 }}>
          {main}
          {side}
        </div>
      )}

      {state === '사건 만들기' && !phone ? <CreateCaseDialog close={close} cl={createFor} /> : null}
      {loading ? <span className="sr-only" role="status">불러오는 중입니다</span> : null}
      <PreviewSwitcher states={boardStates} current={state} />
    </>
  );
}

/** ① 회차 고르기와 기록 고정 상태, 취소 마감 */
function RunBar({ state, now, phone }: { state: State; now: string; phone: boolean }) {
  const before = state === '후보 아직 없음';
  const late = state === '늦은 적재';
  return (
    <section className="widget" aria-labelledby="run-h">
      <div className="widget-body" style={{ gap: 10 }}>
        <h2 className="sr-only" id="run-h">
          회차와 기록 고정
        </h2>
        <div className="row wrap" style={{ gap: '8px 16px', alignItems: 'center' }}>
          <label className="row" style={{ gap: 8 }} htmlFor="run-sel">
            <span className="t-xs muted">회차</span>
            <select className="input input-sm" id="run-sel" defaultValue={EVENT.eventId} style={{ maxWidth: phone ? 260 : 380 }}>
              {EVENTS.map((e) => (
                <option key={e.eventId} value={e.eventId}>
                  {e.label}
                </option>
              ))}
            </select>
          </label>
          <span className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
            <span className="t-xs muted">기록 고정</span>
            {before ? (
              <span className="badge badge-outline">고정 전</span>
            ) : late ? (
              <span className="badge badge-warning">
                <i className="ic ic-alert" aria-hidden="true" />
                늦은 적재 · 판 {SNAPSHOT.version}
              </span>
            ) : (
              <span className="badge badge-success">
                <i className="ic ic-lock" aria-hidden="true" />
                고정됨 · 판 {SNAPSHOT.version}
              </span>
            )}
            {!before ? <span className="t-sm">{formatKst(SNAPSHOT.frozenAt)} KST</span> : <span className="t-sm muted">온세일 윈도우가 끝나면(T+60분) 고정합니다</span>}
          </span>
          {!before ? (
            <span className="row" style={{ gap: 4, alignItems: 'center' }}>
              <span className="t-xs muted">해시</span>
              <span className="hash">{shortHash(SNAPSHOT.invHash)}</span>
              <button className="icon-btn icon-btn-sm" type="button" aria-label="기록 고정 해시 복사" onClick={() => copy(SNAPSHOT.invHash)}>
                <i className="ic ic-copy" aria-hidden="true" />
              </button>
            </span>
          ) : null}
          {!before ? <span className="t-xs muted">후보 계산 판 {SNAPSHOT.generation}</span> : null}
        </div>
        <div className="row wrap" style={{ gap: '6px 12px', alignItems: 'center' }}>
          <span className="t-sm">취소 마감 {formatKst(CASES[0]!.cancelDeadlineAt)} KST</span>
          <CancelDeadlineBadge now={now} deadline={CASES[0]!.cancelDeadlineAt} long />
        </div>
        {late ? <p className="t-xs tx-warning">적재가 30분 안에 끝나지 않아 그대로 고정했습니다. 늦게 들어온 기록은 다음 판에 들어갑니다</p> : null}
      </div>
    </section>
  );
}

/** ⑤ 회차 요약 */
function Summary({ state, phone }: { state: State; phone: boolean }) {
  const empty = state === '후보 아직 없음';
  const loading = state === '불러오는 중';
  const byStatus = CASES.reduce<Record<string, number>>((m, c) => ({ ...m, [c.status]: (m[c.status] ?? 0) + 1 }), {});
  const tiles: { label: string; value: ReactNode; meta?: ReactNode }[] = [
    { label: '후보 묶음', value: empty ? '0' : String(ROUND_SUMMARY.clusters), meta: empty ? '후보 계산 전' : `후보 계산 판 ${SNAPSHOT.generation}` },
    {
      label: '사건',
      value: empty ? '0' : String(ROUND_SUMMARY.cases),
      meta: empty ? '—' : `조사 중 ${byStatus.INVESTIGATING ?? 0} · 소명 대기 ${byStatus.APPEAL_PENDING ?? 0} · 결정 대기 ${byStatus.DECISION_PENDING ?? 0} · 이의 접수 ${byStatus.OBJECTED ?? 0} · 조치됨 ${byStatus.ACTIONED ?? 0} · 정상 종료 ${byStatus.CLEARED ?? 0}`,
    },
    { label: '조치한 표', value: empty ? '0장' : `${ROUND_SUMMARY.actionedTickets}장`, meta: '취소한 좌석은 정가 재판매로 돌림' },
    { label: '소명 인정', value: empty ? '—' : `${ROUND_SUMMARY.appealAccepted} / ${ROUND_SUMMARY.appealRequested}계정`, meta: '소명을 요청한 계정 가운데 인정' },
  ];
  return (
    <section aria-labelledby="sum-h">
      <h2 className="sr-only" id="sum-h">
        회차 요약
      </h2>
      <div style={{ display: 'grid', gridTemplateColumns: phone ? 'repeat(2,minmax(0,1fr))' : 'repeat(4,minmax(0,1fr))', gap: phone ? 8 : 12 }}>
        {tiles.map((t) => (
          <div className="stat" key={t.label}>
            <span className="stat-label">{t.label}</span>
            {loading ? <span className="skel" style={{ height: 28, width: '60%' }} /> : <span className="stat-value" style={phone ? { fontSize: 22, lineHeight: '28px' } : undefined}>{t.value}</span>}
            {t.meta ? <span className="stat-meta">{t.meta}</span> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function attrs(cl: Cluster): string {
  return cl.sharedAttributes.length ? cl.sharedAttributes.map((k) => LINK_KIND_LABEL[k]).join('·') : '없음(근거 신호만)';
}
function signals(cl: Cluster): string {
  return cl.signals.map((s) => SIGNAL_LABEL[s]).join('·');
}

/** ② 후보 묶음 */
function ClusterSection({ state, phone, go, openCreate }: { state: State; phone: boolean; go: (s: string) => void; openCreate: (clusterId: string) => void }) {
  const empty = state === '후보 아직 없음';
  const failed = state === '후보 만들기 실패';
  const retrying = state === '후보 만들기 다시 시도 중';
  const expired = state === '원천 만료';
  const loading = state === '불러오는 중';
  return (
    <section className="widget" aria-labelledby="cl-h">
      <div className="widget-head wrap">
        <h2 className="t-sm fw-b" id="cl-h">
          후보 묶음
        </h2>
        {!phone && !empty && !failed && !retrying && !expired ? (
          <div className="actions">
            <label className="row" style={{ gap: 6 }} htmlFor="cl-sort">
              <span className="t-xs muted">정렬</span>
              <select className="input input-sm" id="cl-sort" defaultValue="SCORE_DESC">
                <option value="SCORE_DESC">점수 범주 높은 순</option>
                <option value="PURCHASE_RATIO_DESC">구매 수 대 한도 큰 순</option>
                <option value="LATEST">최신 순</option>
              </select>
            </label>
          </div>
        ) : null}
      </div>
      <div className="widget-body" style={{ gap: 10 }}>
        {empty ? (
          <div className="state" style={{ padding: '32px 12px' }}>
            <span className="state-icon">
              <i className="ic ic-clock" aria-hidden="true" />
            </span>
            <p className="t-md fw-b">아직 후보 묶음이 없습니다</p>
            <p className="t-sm muted">이 회차의 후보 묶음은 온세일 윈도우가 끝난 뒤 2시간 안에 나옵니다</p>
          </div>
        ) : retrying ? (
          // 자동 다시 시도가 남았다(autoRetriesLeft > 0). [ 다시 돌리기 ]는 보이지 않는다(rerunAllowed 거짓, d5 §7.18)
          <div className="banner banner-info" role="status">
            <i className="ic ic-refresh" aria-hidden="true" />
            <div className="banner-body">{candidateRetryText(RETRIES_LEFT)}</div>
          </div>
        ) : failed ? (
          <div className="state" style={{ padding: '32px 12px' }} role="alert">
            <span className="state-icon">
              <i className="ic ic-alert-circle" aria-hidden="true" />
            </span>
            <p className="t-md fw-b">후보 묶음을 만들지 못했습니다</p>
            <p className="t-sm muted">자동으로 세 번 다시 했지만 실패해 운영 경보로 알렸습니다</p>
            {phone ? (
              <BigScreenNote what="다시 돌리기는 태블릿이나 데스크톱에서 합니다" />
            ) : (
              <button className="btn btn-primary btn-sm" type="button" onClick={() => go(DEFAULT)}>
                <i className="ic ic-refresh" aria-hidden="true" />
                다시 돌리기
              </button>
            )}
          </div>
        ) : expired ? (
          <div className="state" style={{ padding: '32px 12px' }}>
            <span className="state-icon">
              <i className="ic ic-history" aria-hidden="true" />
            </span>
            <p className="t-sm">이 회차의 조사용 기록은 보존 기간이 지났습니다. 증거 묶음만 볼 수 있습니다</p>
          </div>
        ) : phone ? (
          <ul className="col" style={{ gap: 8 }} aria-label="후보 묶음">
            {CLUSTERS.map((cl) => (
              <li key={cl.clusterId} className="card" style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="row between" style={{ gap: 8 }}>
                  <span className="t-sm fw-b mono">{cl.clusterId}</span>
                  <CaseStatusBadge variant="score" value={cl.scoreBand} />
                </span>
                <span className="t-sm">
                  계정 {cl.accountCount} · {purchaseVsLimit(cl.purchaseCount, EVENT.limitPerPerson)}
                </span>
                <span className="t-xs muted">공유 속성 {attrs(cl)}</span>
                {cl.caseId ? (
                  <Link className="link-more" to={`/investigations/${cl.caseId}`}>
                    {cl.caseId}
                    <i className="ic ic-chevron-right" aria-hidden="true" />
                  </Link>
                ) : (
                  <span className="t-xs muted">사건 없음 · 사건 만들기는 태블릿이나 데스크톱에서 합니다</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <div className="table-wrap table-scroll">
            <table className="table" style={{ minWidth: 720 }}>
              <caption className="sr-only">후보 묶음. 점수 원값과 가중치는 싣지 않고 범주만 보입니다</caption>
              <thead>
                <tr>
                  <th scope="col">점수 범주</th>
                  <th scope="col">묶음</th>
                  <th scope="col" className="num">
                    계정
                  </th>
                  <th scope="col">구매 대 한도</th>
                  <th scope="col">공유 속성</th>
                  <th scope="col">근거 신호</th>
                  <th scope="col">사건</th>
                </tr>
              </thead>
              <tbody>
                {CLUSTERS.map((cl) => (
                  <tr key={cl.clusterId}>
                    <td>{loading ? <span className="skel" style={{ width: 48, height: 16 }} /> : <CaseStatusBadge variant="score" value={cl.scoreBand} />}</td>
                    <td className="mono t-xs nowrap">{cl.clusterId}</td>
                    <td className="num">{cl.accountCount}</td>
                    <td className="t-sm nowrap">{purchaseVsLimit(cl.purchaseCount, EVENT.limitPerPerson)}</td>
                    <td className="t-sm">{attrs(cl)}</td>
                    <td className="t-sm">{signals(cl)}</td>
                    <td>
                      {cl.caseId ? (
                        <Link className="link-more" to={`/investigations/${cl.caseId}`}>
                          {cl.caseId}
                          <i className="ic ic-chevron-right" aria-hidden="true" />
                        </Link>
                      ) : (
                        <button className="btn btn-secondary btn-sm" type="button" onClick={() => openCreate(cl.clusterId)} aria-label={`${cl.clusterId}로 사건 만들기`}>
                          사건 만들기
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!empty && !failed && !retrying && !expired ? <p className="t-xs muted">점수 원값과 가중치는 보이지 않습니다. 범주는 묶음에 나타난 근거 신호와 구매 수 대 한도로 정합니다.</p> : null}
      </div>
    </section>
  );
}

const STATUS_FILTER = ['전체', '조사 중', '소명 대기', '결정 대기', '이의 접수', '조치됨', '정상 종료'] as const;

function appealDueText(c: FraudCaseFixture, now: string): string {
  if (c.status === 'APPEAL_PENDING') return `${formatKst(c.timeline.appealDueAt)} · ${remainingHoursText(now, c.timeline.appealDueAt)}`;
  if (c.status === 'INVESTIGATING') return '요청 전';
  return `${formatKst(c.timeline.appealDueAt)} 지남`;
}

/** ③ 사건 목록 */
function CaseSection({ state, phone, now }: { state: State; phone: boolean; now: string }) {
  const empty = state === '후보 아직 없음';
  const expired = state === '원천 만료';
  const loading = state === '불러오는 중';
  const [filter, setFilter] = useState<(typeof STATUS_FILTER)[number]>('전체');
  const closeToDeadline = state === '취소 마감 2시간 전';
  const rows = (expired ? CASES.filter((c) => c.status === 'ACTIONED' || c.status === 'OBJECTED') : empty ? [] : CASES).filter(
    (c) => filter === '전체' || caseLabel(c) === filter,
  );
  return (
    <section className="widget" aria-labelledby="cs-h">
      <div className="widget-head wrap">
        <h2 className="t-sm fw-b" id="cs-h">
          사건
        </h2>
      </div>
      <div className="widget-body" style={{ gap: 10 }}>
        {!empty ? (
          <div className="row wrap" style={{ gap: 6 }} role="group" aria-label="사건 상태로 거르기">
            {STATUS_FILTER.map((f) => (
              <button key={f} className="chip chip-sm" type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {f}
                {f === '전체' ? ` ${expired ? 2 : CASES.length}` : ''}
              </button>
            ))}
          </div>
        ) : null}
        {empty ? (
          <p className="t-sm muted">아직 사건이 없습니다. 후보 묶음이 나오면 사건을 만들 수 있습니다.</p>
        ) : phone ? (
          <ul className="col" style={{ gap: 8 }} aria-label="사건">
            {rows.map((c) => (
              <li key={c.caseId}>
                <Link to={`/investigations/${c.caseId}`} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 14px', color: 'inherit' }}>
                  <span className="row between" style={{ gap: 8 }}>
                    <span className="t-sm fw-b">{c.caseId}</span>
                    <CaseStatusBadge variant="case" value={c.status} />
                  </span>
                  <span className="t-sm">
                    {c.accountCount}계정 · {c.ticketCount}장 · 담당 {c.assignee}
                  </span>
                  <span className="row" style={{ gap: 6 }}>
                    <span className="t-xs muted">취소 마감</span>
                    <CancelDeadlineBadge now={now} deadline={c.cancelDeadlineAt} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div className="table-wrap table-scroll">
            <table className="table" style={{ minWidth: 720 }}>
              <caption className="sr-only">사건 목록</caption>
              <thead>
                <tr>
                  <th scope="col">사건</th>
                  <th scope="col">상태</th>
                  <th scope="col">사유 범주</th>
                  <th scope="col">계정·표</th>
                  <th scope="col">담당 조사관</th>
                  <th scope="col">소명 기한</th>
                  <th scope="col">취소 마감까지</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const open = c.status === 'INVESTIGATING' || c.status === 'APPEAL_PENDING' || c.status === 'DECISION_PENDING';
                  return (
                    <tr key={c.caseId}>
                      <td>
                        {closeToDeadline && open ? (
                          <>
                            <i className="ic ic-alert tx-danger" aria-hidden="true" style={{ marginRight: 4 }} />
                            <span className="sr-only">결정되지 않은 사건 · </span>
                          </>
                        ) : null}
                        <Link className="link-more" to={`/investigations/${c.caseId}`}>
                          {c.caseId}
                        </Link>
                        {expired ? (
                          <>
                            {' '}
                            <Link className="t-xs" to={`/investigations/${c.caseId}?state=${encodeURIComponent('조치됨')}`}>
                              증거 묶음
                            </Link>
                          </>
                        ) : null}
                      </td>
                      <td>{loading ? <span className="skel" style={{ width: 56, height: 16 }} /> : <CaseStatusBadge variant="case" value={c.status} />}</td>
                      <td className="t-sm">{REASON_LABEL[c.reasonCategory]}</td>
                      <td className="t-sm nowrap">
                        {c.accountCount} · {c.ticketCount}장
                      </td>
                      <td className="t-sm">{c.assignee}</td>
                      <td className="t-xs">{appealDueText(c, now)}</td>
                      <td>{c.status !== 'CLEARED' && !expired ? <CancelDeadlineBadge now={now} deadline={c.cancelDeadlineAt} /> : <span className="t-xs muted">— 닫힘</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function caseLabel(c: FraudCaseFixture): string {
  return { INVESTIGATING: '조사 중', APPEAL_PENDING: '소명 대기', DECISION_PENDING: '결정 대기', OBJECTED: '이의 접수', ACTIONED: '조치됨', CLEARED: '정상 종료', REVERSED: '이의 인정' }[c.status];
}

/** ④ 외부 게시물 등록·목록 */
function PostSection({ state, phone }: { state: State; phone: boolean }) {
  const reject = state === '게시물 파일 거절';
  const badSource = state === '오류 · 신고 출처 아님';
  const expired = state === '원천 만료';
  // 확인 칸 셋(ADR-0173 결정 9). 모두 체크해야 [게시물 등록]이 켜진다. 거절 그림 둘은 보낸 뒤라 체크한 채로 그린다
  const [checks, setChecks] = useState<boolean[]>(() => POST_CHECKS.map(() => reject || badSource));
  const ready = postRegisterEnabled(checks);
  return (
    <section className="widget" aria-labelledby="po-h">
      <div className="widget-head">
        <h2 className="t-sm fw-b" id="po-h">
          외부 게시물
        </h2>
      </div>
      <div className="widget-body" style={{ gap: 12 }}>
        {phone ? (
          <BigScreenNote what="외부 게시물 등록은 태블릿이나 데스크톱에서 합니다" />
        ) : expired ? null : (
          <form className="col" style={{ gap: 10 }} aria-label="외부 게시물 등록" onSubmit={(e) => e.preventDefault()}>
            <div className="field">
              <label className="label" htmlFor="po-url">
                게시물 주소
              </label>
              <input className="input" id="po-url" type="url" inputMode="url" placeholder="https://" aria-describedby="po-url-h" />
              <span className="hint" id="po-url-h">
                http·https 주소만 받습니다. 주소는 누르는 링크로 만들지 않습니다
              </span>
            </div>
            <div className="field">
              <label className="label" htmlFor="po-at">
                수집 시각
              </label>
              <input className="input" id="po-at" type="datetime-local" defaultValue="2026-10-19T14:10" />
            </div>
            {/* 게시 시각은 게시물 화면에 보일 때만 적는다(openapi ExternalPostCreate.postedAt, d5 §7.18 ④, ADR-0173 결정 9, FRN-090 리뷰 결함 3) */}
            <div className="field">
              <label className="label" htmlFor="po-posted">
                게시 시각
              </label>
              <input className="input" id="po-posted" type="datetime-local" aria-describedby="po-posted-h" />
              <span className="hint" id="po-posted-h">
                게시물에 보일 때만 적습니다
              </span>
            </div>
            <fieldset className="col" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
              <legend className="label" style={{ marginBottom: 6 }}>
                출처
              </legend>
              <label className="check-row" htmlFor="po-src-r">
                <input className="rd" type="radio" name="po-src" id="po-src-r" defaultChecked />
                신고(CS 처리함 건)
              </label>
              <div className={`field ${badSource ? 'is-error' : ''}`.trim()}>
                <input
                  className="input input-sm"
                  aria-label="신고 CS 처리함 건 ID"
                  placeholder="CS-2610-0000"
                  defaultValue={badSource ? 'CS-2610-0377' : undefined}
                  aria-invalid={badSource}
                  aria-describedby={badSource ? 'po-src-e po-src-h' : 'po-src-h'}
                />
                {badSource ? (
                  <span className="error-msg" id="po-src-e" role="alert">
                    {ERR_REPORT_SOURCE}
                  </span>
                ) : null}
                <span className="hint" id="po-src-h">
                  문의 유형이 '외부 되팔이 게시물 신고'인 건만 받습니다. 신고한 분의 정보는 수집본에 넣지 않습니다
                </span>
              </div>
              <label className="check-row" htmlFor="po-src-m">
                <input className="rd" type="radio" name="po-src" id="po-src-m" />
                직접 찾음
              </label>
            </fieldset>
            <div className="field">
              <label className="label" htmlFor="po-seat">
                게시물이 말하는 좌석
              </label>
              <textarea className="textarea" id="po-seat" style={{ minHeight: 64 }} placeholder="적힌 그대로 옮겨 적습니다" />
            </div>
            <div className={`field ${reject ? 'is-error' : ''}`.trim()}>
              <label className="label" htmlFor="po-cap">
                화면 캡처
              </label>
              <input className="input" id="po-cap" type="file" accept=".png,.jpg,.jpeg,.pdf" aria-invalid={reject} aria-describedby={reject ? 'po-cap-e po-cap-h' : 'po-cap-h'} />
              <span className="hint" id="po-cap-h">
                PNG·JPEG·PDF, 10MB까지 한 장. 원본은 바꾸지 않고 해시를 남깁니다
              </span>
              {reject ? (
                <span className="error-msg" id="po-cap-e" role="alert">
                  PNG·JPEG·PDF 파일만 올릴 수 있습니다
                </span>
              ) : null}
            </div>
            {/* 가릴 자리(maskRegions): 캡처 미리보기 위에 상자를 그린다. 글자 읽기(OCR)는 없고 서버가 칠한 보기용 사본을 만든다(원본은 그대로) */}
            <div className="col" style={{ gap: 6 }}>
              <button className="btn btn-outline btn-sm" type="button" aria-disabled="true" aria-describedby="po-mask-h" style={{ alignSelf: 'flex-start' }}>
                <i className="ic ic-edit" aria-hidden="true" />
                가릴 자리 고르기
              </button>
              <span className="hint" id="po-mask-h">
                캡처를 고르면 미리보기 위에서 연락처·계좌·채팅 링크에 상자를 그립니다(여러 개, 키보드로는 좌표를 넣습니다). 화면 글자는 읽지 않습니다
              </span>
              <p className="t-xs muted">{MASK_NONE_HINT}</p>
            </div>
            <fieldset className="col" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
              <legend className="label" style={{ marginBottom: 6 }}>
                등록 전 확인(모두 체크)
              </legend>
              {POST_CHECKS.map((text, i) => (
                <label className="check-row t-sm" key={text} htmlFor={`po-chk-${i}`} style={{ alignItems: 'flex-start' }}>
                  <input
                    className="cb"
                    type="checkbox"
                    id={`po-chk-${i}`}
                    checked={checks[i] ?? false}
                    onChange={(e) => setChecks((xs) => xs.map((x, j) => (j === i ? e.target.checked : x)))}
                  />
                  {text}
                </label>
              ))}
            </fieldset>
            <button className="btn btn-primary" type="submit" {...(ready ? {} : { 'aria-disabled': 'true' as const, 'aria-describedby': 'po-reg-why', onClick: (e: { preventDefault(): void }) => e.preventDefault() })}>
              게시물 등록
            </button>
            {!ready ? (
              <span className="t-xs muted" id="po-reg-why">
                확인 칸 셋을 모두 체크하면 등록할 수 있습니다
              </span>
            ) : null}
            <p className="t-xs muted">게시물 주소는 누르는 링크로 만들지 않습니다. 실수로 열어 상대 사이트에 조사관의 접속 흔적이 남지 않게 하려는 것입니다</p>
          </form>
        )}
        <div className="col" style={{ gap: 8 }}>
          <h3 className="eyebrow">등록한 게시물</h3>
          <ul className="col" style={{ gap: 8 }}>
            {EXTERNAL_POSTS.map((p) => (
              <li key={p.postId} className="card-flat pad col" style={{ gap: 4 }}>
                <span className="row" style={{ gap: 4, alignItems: 'center', minWidth: 0 }}>
                  <span className="mono t-xs ellipsis" style={{ minWidth: 0 }}>
                    {p.url.replace(/^https?:\/\//, '')}
                  </span>
                  <button className="icon-btn icon-btn-sm" type="button" aria-label={`게시물 주소 ${p.site} 복사`} onClick={() => copy(p.url)}>
                    <i className="ic ic-copy" aria-hidden="true" />
                  </button>
                </span>
                <span className="row wrap" style={{ gap: 6 }}>
                  <span className="badge badge-outline">{p.source === 'REPORT' ? '신고' : '직접 찾음'}</span>
                  {p.scanStatus === 'CLEAN' ? <span className="badge badge-success">검사 · 위협 없음</span> : p.scanStatus === 'PENDING' ? <span className="badge">검사 중</span> : <span className="badge badge-danger">검사 · 위협</span>}
                  <span className="t-xs">맞은 티켓 {p.matchedTicketCount}</span>
                </span>
                <span className="t-xs muted">
                  {formatKst(p.capturedAt)} 수집 · {p.claimedSeats} · 등록 {p.registeredBy}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/** 사건 만들기 대화상자(CMP-019) */
function CreateCaseDialog({ close, cl }: { close: () => void; cl: Cluster }) {
  return (
    <Overlay onClose={close}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="cc-t" aria-describedby="cc-d" style={{ maxWidth: 480 }}>
        <h2 className="dialog-title" id="cc-t">
          사건 만들기
        </h2>
        <dl className="kv">
          <dt>묶음</dt>
          <dd className="mono">{cl.clusterId}</dd>
          <dt>점수 범주</dt>
          <dd>
            <CaseStatusBadge variant="score" value={cl.scoreBand} />
          </dd>
          <dt>계정</dt>
          <dd>
            {cl.accountCount} · {purchaseVsLimit(cl.purchaseCount, EVENT.limitPerPerson)}
          </dd>
          <dt>근거 신호</dt>
          <dd>{signals(cl)}</dd>
        </dl>
        <div className="field">
          <label className="label" htmlFor="cc-reason">
            사유 범주
          </label>
          <select className="input" id="cc-reason" defaultValue="LIMIT_EVASION">
            {Object.entries(REASON_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <p className="t-sm" id="cc-d">
          사건을 만들어도 팬 계정·티켓은 바뀌지 않습니다. 양도 잠금은 소명을 요청할 때 겁니다. 만든 조사관이 담당이 됩니다.
        </p>
        <div className="dialog-actions">
          <button className="btn btn-ghost" type="button" onClick={close}>
            닫기
          </button>
          <Link className="btn btn-primary" to={`/investigations/${CASES[0]!.caseId}`}>
            사건을 만들고 조사를 시작합니다
          </Link>
        </div>
      </div>
    </Overlay>
  );
}

// getCase는 다른 화면이 쓴다(이 화면은 목록 전체를 쓴다)
void getCase;
