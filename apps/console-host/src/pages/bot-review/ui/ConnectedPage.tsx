// SCR-067 봇 판정 표본 검토 연결 화면(FR-049, BAT-197 BOT-080, d5 §7.15).
// 회차는 ?event=, 표본 종류는 ?reviewKind=(기본 PASSED_SAMPLE)로 받는다. 디자인 보드(ui/Page.tsx)는 ?state= 미리보기에 남긴다.
// 서버가 섞은 순서를 그대로 쓰고(sampleId로 다시 정렬하지 않는다), 표본마다 한 번만 기록한다.
// 세션 가명·범주·타임라인은 글자 노드로만 그린다(ASVS 3.2.2). 판정·표본을 localStorage·sessionStorage에 두지 않는다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ApiError } from '@peaket/api-client';
import { BOARD_PEOPLE, NoAccess } from '@/features/screen-access';
import { useChosenRole, usePreviewHost } from '@/features/preview-host';
import { ensureConsoleApi } from '@/shared/api';
import {
  canSubmit,
  EVIDENCE_KINDS,
  formatKst,
  formatPercent,
  formatRate,
  formatRateRange,
  mapReview,
  mapSamples,
  needsEvidence,
  parseReviewKind,
  REVIEW_KINDS,
  reviewKindHint,
  reviewKindIntro,
  reviewKindLabel,
  stepLabel,
  submitBlockReason,
  VERDICTS,
  verdictLabel,
  type EvidenceKind,
  type ReviewKind,
  type ReviewProgress,
  type SampleRow,
  type Verdict,
} from '../model/review';

const TITLE = '봇 판정 표본 검토';

type Load =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; progress: ReviewProgress; samples: SampleRow[] }
  | { kind: 'empty' }
  | { kind: 'expired' }
  | { kind: 'config' }
  | { kind: 'no-access' }
  | { kind: 'error'; message: string };

export function ConnectedPage() {
  const chosen = useChosenRole();
  const [sp, setSp] = useSearchParams();
  const eventId = (sp.get('event') ?? '').trim();
  const reviewKind = parseReviewKind(sp.get('reviewKind'));
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [evidence, setEvidence] = useState<readonly EvidenceKind[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** 503 재시도는 같은 Idempotency-Key로 보낸다(B15). 표본이 바뀌면 새 키다 */
  const idempotency = useRef<{ sampleId: string; key: string } | null>(null);

  usePreviewHost(
    {
      scope: { stage: '종료 후' },
      control: { kind: 'ok' },
      clock: '14:20:05 KST',
      ...(chosen ? {} : { session: BOARD_PEOPLE.cs_lead }),
    },
    [chosen, reviewKind, eventId],
  );

  const refresh = useCallback(async () => {
    if (eventId === '') {
      setLoad({ kind: 'idle' });
      return;
    }
    if (!ensureConsoleApi()) {
      setLoad({ kind: 'config' });
      return;
    }
    setLoad((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }));
    try {
      const [{ getOpsEventBotReview, listOpsEventBotReviewSamples }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      const [progressResponse, samplesResponse] = await Promise.all([
        getOpsEventBotReview(eventId, { reviewKind }),
        listOpsEventBotReviewSamples(eventId, { reviewKind, status: 'PENDING', limit: 100 }),
      ]);
      const progress = mapReview(progressResponse.data, reviewKind);
      const samples = mapSamples(samplesResponse.data);
      if (progress.targetCount === 0) {
        setLoad({ kind: 'empty' });
        return;
      }
      setLoad({ kind: 'ready', progress, samples });
    } catch (e) {
      setLoad(loadFailure(e));
    }
  }, [eventId, reviewKind]);

  useEffect(() => {
    setVerdict(null);
    setEvidence([]);
    idempotency.current = null;
    void refresh();
  }, [refresh]);

  /** 첫 표본 ID. 수동 새로 고침·409 뒤 refresh로 표본이 바뀌면 아래 효과가 앞 표본의 입력을 지운다 */
  const currentSampleId = load.kind === 'ready' ? (load.samples[0]?.sampleId ?? null) : null;

  useEffect(() => {
    // 표본이 바뀌었는데 판정·근거를 남겨 두면 다른 표본에 그대로 기록하게 된다
    setVerdict(null);
    setEvidence([]);
    idempotency.current = null;
  }, [currentSampleId]);

  const samples = load.kind === 'ready' ? load.samples : [];
  const sample = samples[0] ?? null;
  const progress = load.kind === 'ready' ? load.progress : null;
  const blockReason = submitBlockReason(reviewKind, verdict, evidence);

  const toggleEvidence = (kind: EvidenceKind) => {
    setEvidence((prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]));
  };

  const submit = async () => {
    if (!sample || busy || !canSubmit(reviewKind, verdict, evidence)) return;
    setBusy(true);
    setNotice(null);
    const reused = idempotency.current?.sampleId === sample.sampleId ? idempotency.current : null;
    const key = reused?.key ?? crypto.randomUUID();
    idempotency.current = { sampleId: sample.sampleId, key };
    try {
      const [{ createOpsBotReviewSampleJudgement }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      await createOpsBotReviewSampleJudgement(
        sample.sampleId,
        {
          verdict: verdict!,
          ...(evidence.length > 0 ? { evidenceKinds: [...evidence] } : {}),
        },
        { headers: { 'Idempotency-Key': key } },
      );
      idempotency.current = null;
      setVerdict(null);
      setEvidence([]);
      setNotice(`${verdictLabel(verdict!)}로 기록했습니다. 다음 표본을 불러옵니다.`);
      await refresh();
    } catch (e) {
      const failure = judgementFailure(e);
      if (failure.clearKey) idempotency.current = null;
      if (failure.kind === 'expired') setLoad({ kind: 'expired' });
      else if (failure.kind === 'no-access') setLoad({ kind: 'no-access' });
      else setNotice(failure.message);
      if (failure.refresh) await refresh();
    } finally {
      setBusy(false);
    }
  };

  const changeKind = (kind: ReviewKind) => {
    const next = new URLSearchParams(sp);
    next.set('reviewKind', kind);
    setSp(next, { replace: true });
  };

  if (chosen && chosen !== 'cs_agent' && chosen !== 'cs_lead') {
    return <NoAccess title={TITLE} role={chosen} who="CS 담당자(cs_agent·cs_lead)" />;
  }
  if (load.kind === 'no-access') {
    return <NoAccess title={TITLE} role={chosen ?? 'viewer'} who="CS 담당자(cs_agent·cs_lead)" />;
  }

  return (
    <>
      <div className="page-head">
        <div className="col" style={{ gap: 4 }}>
          <h1>{TITLE}</h1>
          <p className="t-sm muted">{reviewKindIntro(reviewKind)}</p>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          {REVIEW_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              className={reviewKind === kind ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm'}
              aria-pressed={reviewKind === kind}
              onClick={() => changeKind(kind)}
            >
              {reviewKindLabel(kind)}
            </button>
          ))}
          <button className="btn btn-outline" type="button" onClick={() => void refresh()} disabled={busy}>
            <i className="ic ic-refresh" aria-hidden="true" /> 새로 고침
          </button>
        </div>
      </div>

      {load.kind === 'idle' ? <section className="widget"><div className="state" role="status"><h2 className="t-lg">회차를 고르세요</h2><p className="t-sm muted">주소에 <code>?event=&lt;회차 ID&gt;</code>를 붙이면 그 회차의 표본을 검토합니다.</p></div></section> : null}
      {load.kind === 'config' ? <section className="widget" role="alert"><div className="widget-body t-sm">관제 API 주소가 설정되지 않아 표본을 부를 수 없습니다. 빌드의 <code>PEAKET_OPS_API_ORIGIN</code>을 확인해 주세요.</div></section> : null}
      {load.kind === 'loading' ? <p className="t-sm muted" style={{ marginTop: 16 }}>표본을 불러오는 중…</p> : null}
      {load.kind === 'empty' ? (
        <section className="widget" style={{ marginTop: 16 }}>
          <div className="state" role="status">
            <span className="state-icon"><i className="ic ic-bot" aria-hidden="true" /></span>
            <h2 className="t-lg">검토할 표본이 없습니다</h2>
            <p className="t-sm muted">표본 배정 전이거나 이 회차·종류에 아직 표본이 없습니다. 다른 회차나 표본 종류를 골라 주세요.</p>
          </div>
        </section>
      ) : null}
      {load.kind === 'expired' ? (
        <section className="widget" style={{ marginTop: 16 }} role="alert">
          <div className="state">
            <h2 className="t-lg">검토 기한이 지났습니다</h2>
            <p className="t-sm muted">행동 신호는 오픈 30일 뒤 지워져 그 뒤에는 표본을 검토할 수 없습니다. 남은 결과는 종료 후 탭의 하한 추정치로 봅니다.</p>
          </div>
        </section>
      ) : null}
      {load.kind === 'error' ? (
        <section className="widget" style={{ marginTop: 16 }} role="alert">
          <div className="widget-body col" style={{ padding: 16, gap: 8 }}>
            <p className="t-sm">{load.message}</p>
            <div><button className="btn btn-outline" type="button" onClick={() => void refresh()}>다시 시도</button></div>
          </div>
        </section>
      ) : null}

      {progress ? (
        <section className="widget" aria-label="검토 대상과 진행" style={{ marginTop: 16 }}>
          <div className="widget-body" style={{ padding: 16, gap: 14 }}>
            <div className="grid-12" style={{ rowGap: 16, alignItems: 'end' }}>
              <div className="span-4 col" style={{ gap: 6 }}>
                <span className="eyebrow">회차</span>
                <span className="mono t-sm">{progress.eventId || eventId}</span>
                <span className="t-xs muted">{reviewKindLabel(progress.reviewKind)}</span>
              </div>
              <div className="span-4 col" style={{ gap: 6 }}>
                <div className="row between t-sm">
                  <span className="fw-b" id="bot-review-progress">검토 진행</span>
                  <span className="num"><strong>{progress.reviewedCount}</strong> / {progress.targetCount}건</span>
                </div>
                <div
                  className="progress"
                  role="progressbar"
                  aria-labelledby="bot-review-progress"
                  aria-valuemin={0}
                  aria-valuemax={progress.targetCount}
                  aria-valuenow={progress.reviewedCount}
                  aria-valuetext={`표본 ${progress.targetCount}건 중 ${progress.reviewedCount}건 검토`}
                >
                  <span style={{ width: formatPercent(progress.percent) }} />
                </div>
                <span className="t-xs muted">남은 표본 {progress.remaining}건 · 표본 크기 {progress.targetCount}건</span>
              </div>
              <div className="span-4 col" style={{ gap: 6 }}>
                <span className="eyebrow">기한</span>
                <span className="badge" style={{ alignSelf: 'flex-start' }}>
                  <i className="ic ic-clock" aria-hidden="true" /> R2 마감 {formatKst(progress.r2DueAt)}
                </span>
                <span className="badge" style={{ alignSelf: 'flex-start' }}>
                  <i className="ic ic-clock" aria-hidden="true" /> 행동 신호 삭제 {formatKst(progress.deadlineAt)}
                </span>
              </div>
            </div>
            <p className="t-xs muted">{reviewKindHint(progress.reviewKind)}</p>
            {progress.interim ? (
              <p className="t-sm">
                <span className="badge badge-outline">잠정</span> 놓친 봇 비율 추정 <strong className="num">{formatRate(progress.interim.missedBotRate)}</strong>
                <span className="muted num"> · 95% 구간 {formatRateRange(progress.interim.ci95Low, progress.interim.ci95High)}</span>
                <span className="t-xs muted"> (판단 불가는 분모에서 뺍니다)</span>
              </p>
            ) : null}
          </div>
        </section>
      ) : null}

      {load.kind === 'ready' && !sample && progress && progress.targetCount > 0 ? (
        <section className="widget" style={{ marginTop: 16 }}>
          <div className="state" role="status">
            <h2 className="t-lg">이 회차의 표본 검토를 마쳤습니다</h2>
            <p className="t-sm muted">{progress.reviewedCount}건을 기록했습니다. 결과는 종료 후 탭의 하한 추정치로 보입니다.</p>
          </div>
        </section>
      ) : null}

      {sample ? (
        <div className="grid-12" style={{ rowGap: 16, alignItems: 'start', marginTop: 16 }}>
          <section className="widget span-8" aria-labelledby="bot-review-card">
            <div className="widget-head">
              <h2 className="t-sm fw-b" id="bot-review-card">세션 카드</h2>
              <span className="actions"><span className="badge badge-outline">가명 참조값만 표시</span></span>
            </div>
            <div className="widget-body col" style={{ padding: 16, gap: 16 }}>
              <dl className="row wrap" style={{ gap: '12px 32px', alignItems: 'flex-start', margin: 0 }}>
                <div className="col" style={{ gap: 4 }}>
                  <dt className="eyebrow">세션 가명</dt>
                  <dd className="mono t-md fw-b" style={{ margin: 0 }}>{sample.sessionRef}</dd>
                </div>
                {sample.riskBand !== null ? (
                  <div className="col" style={{ gap: 4 }}>
                    <dt className="eyebrow">위험 점수 범주</dt>
                    <dd style={{ margin: 0 }}><span className="badge">{sample.riskBand}</span></dd>
                  </div>
                ) : null}
                {sample.behaviorSummaryBand !== null ? (
                  <div className="col" style={{ gap: 4 }}>
                    <dt className="eyebrow">행동 신호 요약 범주</dt>
                    <dd style={{ margin: 0 }}>{sample.behaviorSummaryBand}</dd>
                  </div>
                ) : null}
              </dl>
              <div className="divider" />
              <div className="col" style={{ gap: 8 }}>
                <h3 className="eyebrow">세션 타임라인</h3>
                {sample.timeline.length === 0 ? (
                  <p className="t-sm muted">기록된 타임라인이 없습니다.</p>
                ) : (
                  <ol className="timeline">
                    {sample.timeline.map((t, i) => (
                      <li className="tl-item" key={`${t.step}-${i}`}>
                        <span className="tl-dot info" aria-hidden="true" />
                        <div className="row" style={{ gap: 10, alignItems: 'baseline' }}>
                          <span className="mono t-xs muted" style={{ width: 72, flex: 'none' }}>{formatKst(t.at)}</span>
                          <span className="t-sm">{stepLabel(t.step)}</span>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
              {sample.evidenceAvailable.length > 0 ? (
                <div className="col" style={{ gap: 6 }}>
                  <h3 className="eyebrow">행동 요약 밖의 근거(있는 것만)</h3>
                  <p className="t-sm">{sample.evidenceAvailable.map((e) => EVIDENCE_KINDS.find((x) => x.kind === e)?.label ?? e).join(' · ')}</p>
                </div>
              ) : null}
              <p className="t-xs muted">원시 신호 값, 위험 점수, 판정 기준의 세부 가중치는 보이지 않습니다.</p>
            </div>
          </section>

          <section className="widget span-4" aria-labelledby="bot-review-verdict">
            <div className="widget-head"><h2 className="t-sm fw-b" id="bot-review-verdict">판정</h2></div>
            <div className="widget-body col" style={{ padding: 16, gap: 14 }}>
              <fieldset className="col" style={{ gap: 10, border: 0, margin: 0, padding: 0 }} role="radiogroup" aria-labelledby="bot-review-verdict-legend">
                <legend className="label" id="bot-review-verdict-legend" style={{ marginBottom: 6 }}>이 세션의 판정 (필수)</legend>
                {VERDICTS.map((value) => (
                  <label className="check-row" key={value} htmlFor={`judgement-${sample.sampleId}-${value}`}>
                    <input
                      className="rd"
                      type="radio"
                      name={`judgement-${sample.sampleId}`}
                      id={`judgement-${sample.sampleId}-${value}`}
                      checked={verdict === value}
                      disabled={busy}
                      onChange={() => {
                        setVerdict(value);
                        if (value !== 'BOT') setEvidence([]);
                      }}
                    />
                    <span className="col">
                      <strong className="fw-b">{verdictLabel(value)}</strong>
                      <span className="t-sm muted">
                        {value === 'HUMAN' ? '사람이 조작한 것으로 봅니다' : value === 'BOT' ? '자동화 도구가 조작한 것으로 봅니다' : '근거가 부족해 정하지 않습니다'}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>

              {needsEvidence(reviewKind, verdict) ? (
                <fieldset className="col" style={{ gap: 8, border: 0, margin: 0, padding: 0 }}>
                  <legend className="label">행동 요약 밖의 근거 (하나 이상 필수)</legend>
                  {EVIDENCE_KINDS.map((e) => (
                    <label className="check-row" key={e.kind} htmlFor={`evidence-${e.kind}`}>
                      <input
                        type="checkbox"
                        id={`evidence-${e.kind}`}
                        checked={evidence.includes(e.kind)}
                        disabled={busy}
                        onChange={() => toggleEvidence(e.kind)}
                      />
                      <span className="t-sm">{e.label}</span>
                    </label>
                  ))}
                  <p className="t-xs muted">행동 요약만으로는 봇으로 기록하지 않습니다.</p>
                </fieldset>
              ) : null}

              <button className="btn btn-primary btn-block" type="button" disabled={busy || blockReason !== null} aria-describedby="bot-review-why" onClick={() => void submit()}>
                {busy ? '기록하는 중…' : '기록하고 다음 표본으로'}
                <i className="ic ic-arrow-right" aria-hidden="true" />
              </button>
              <p className="hint" id="bot-review-why">{blockReason ?? '기록에는 세션 가명과 판정 결과·근거 종류만 남습니다.'}</p>
              <p className="t-xs muted">판정은 표본마다 한 번입니다. 새로고침하면 서버에서 다시 읽고, 기록한 표본은 목록에서 사라집니다.</p>
            </div>
          </section>
        </div>
      ) : null}

      {notice ? <div className="toast" role="status" style={{ position: 'fixed', right: 24, bottom: 24, zIndex: 20 }}>{notice}</div> : null}
    </>
  );
}

function loadFailure(e: unknown): Load {
  if (e instanceof ApiError) {
    if (e.status === 403) return { kind: 'no-access' };
    if (e.status === 404) return { kind: 'empty' };
    if (e.status === 410) return { kind: 'expired' };
    if (e.status === 503) return { kind: 'error', message: '표본 원장에 닿지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
    return { kind: 'error', message: `표본을 불러오지 못했습니다(HTTP ${e.status}). 잠시 뒤 다시 시도해 주세요.` };
  }
  return { kind: 'error', message: '표본을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
}

function judgementFailure(e: unknown): { kind: 'notice' | 'expired' | 'no-access'; message: string; clearKey: boolean; refresh: boolean } {
  if (e instanceof ApiError) {
    if (e.status === 409) return { kind: 'notice', message: '이미 기록한 표본입니다. 목록을 새로 고칩니다.', clearKey: true, refresh: true };
    if (e.status === 410) return { kind: 'expired', message: '검토 기한이 지났습니다.', clearKey: true, refresh: false };
    if (e.status === 403) return { kind: 'no-access', message: '이 화면을 쓸 권한이 없습니다.', clearKey: true, refresh: false };
    if (e.status === 422) return { kind: 'notice', message: '사람 기준 표본을 봇으로 기록하려면 근거를 하나 이상 골라야 합니다.', clearKey: true, refresh: false };
    if (e.status === 503) return { kind: 'notice', message: '봇 라벨을 반영하지 못했습니다. 같은 요청을 다시 보내 주세요.', clearKey: false, refresh: false };
    return { kind: 'notice', message: `기록하지 못했습니다(HTTP ${e.status}). 다시 시도해 주세요.`, clearKey: true, refresh: false };
  }
  return { kind: 'notice', message: '기록하지 못했습니다. 다시 시도해 주세요.', clearKey: true, refresh: false };
}
