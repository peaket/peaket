'use client';
// SCR-021 새 공연 등록의 실제 위저드(/events/new, ADR-0245). ?state=가 있으면 퍼블리싱 화면을 그리고 이 부품은 쓰지 않는다.
// 입력은 브라우저에 임시저장하고(1초 뒤·단계를 옮길 때·페이지를 떠날 때), 4단계 끝에서 POST /v1/partner/productions 한 번으로 등록한다.
// 고른 이미지 파일은 탭 메모리에만 있고, 등록이 성공한 바로 뒤에 포스터부터 한 장씩 올린다(올리기 코드는 그때 늦게 싣는다, ADR-0257 결정 4).
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { routes } from '@/shared/config/routes';
import { DraftKeeper } from '../../model/draft-keeper';
import { clearFieldErrors, emptyDraft, problemToErrors, toCreateBody, validateStep, warningText, type FieldError, type InputStep, type WizardDraft } from '../../model/form';
import type { UploadOutcome } from '../../model/image-upload';
import { canRetry, imageErrors, runUploads, type ImageDraft } from '../../model/images';
import { createProduction, uploadProductionImage, type ProductionCreated } from '../../model/wizard-api';
import type { WizardStep } from '../../model/view';
import { WizardStepper } from '../parts/WizardStepper';
import { ErrorSummary } from './fields';
import { LiveStepBasic } from './LiveStepBasic';
import { LiveStepPolicy } from './LiveStepPolicy';
import { LiveStepRounds } from './LiveStepRounds';
import { fileState, type PickedImage, useImageFiles } from './image-files';
import { browserDraftStore, watchOtherTabs } from './storage';

type LiveStep = 1 | 2 | 3 | 4;

const AUTOSAVE_MS = 1000;
const BAR = 'card row sticky bottom-3 z-10 max-md:hidden max-lg:bottom-0 max-lg:rounded-none';
const BAR_STYLE = { padding: '12px 16px', gap: 8, boxShadow: 'var(--shadow-sm)' } as const;

/** 한국 시각 HH:MM:SS */
const kstClock = (t: number) => new Date(t + 9 * 3_600_000).toISOString().slice(11, 19);

const isUnauthorized = (e: unknown) => typeof e === 'object' && e !== null && (e as { status?: unknown }).status === 401;

function errorsFromFailure(e: unknown, draft: WizardDraft): FieldError[] {
  const p = typeof e === 'object' && e !== null ? (e as { status?: unknown; type?: unknown; extensions?: unknown }) : {};
  return problemToErrors(
    {
      status: typeof p.status === 'number' ? p.status : 0,
      type: typeof p.type === 'string' ? p.type : 'network',
      extensions: typeof p.extensions === 'object' && p.extensions !== null ? (p.extensions as Record<string, unknown>) : {},
    },
    draft,
  );
}

function SeatmapNotice() {
  return (
    <section className="card pad-lg col" style={{ gap: 12 }} aria-labelledby="h-seat">
      <div className="section-title">
        <h2 id="h-seat">좌석맵</h2>
      </div>
      <p className="t-sm">좌석맵은 공연을 등록한 뒤에 만듭니다. 4단계까지 입력해 등록하면 이어서 좌석맵과 가격 등급을 정할 수 있습니다.</p>
    </section>
  );
}

/** 등록 뒤 올리기의 줄마다 상태 */
type UploadRow = UploadOutcome | { key: string; status: 'uploading' };
interface Uploads {
  images: ImageDraft[];
  files: ReadonlyMap<string, PickedImage>;
  rows: ReadonlyMap<string, UploadRow>;
}

function ImageResults({ uploads, onRetry }: { uploads: Uploads; onRetry: (key: string) => void }) {
  // 서버가 준 다시 시도 하한이 지나면 [다시 올리기]를 다시 연다
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const waits = [...uploads.rows.values()].flatMap((r) => ('retryAt' in r && r.retryAt !== undefined && r.retryAt > now ? [r.retryAt - now] : []));
    if (waits.length === 0) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(...waits) + 50);
    return () => clearTimeout(timer);
  }, [uploads, now]);
  const poster = uploads.images[0];
  const posterRow = poster ? uploads.rows.get(poster.key) : undefined;
  const posterMissing = !poster || posterRow?.status === 'error';
  return (
    <div className="col" style={{ gap: 8 }}>
      <h3 className="t-md fw-b" id="h-images-done">
        포스터·상세 이미지
      </h3>
      {uploads.images.length > 0 ? (
        <ul className="col" style={{ gap: 6 }} aria-labelledby="h-images-done">
          {uploads.images.map((img, i) => {
            const row = uploads.rows.get(img.key);
            const name = uploads.files.get(img.key)?.file.name ?? '고른 파일 없음';
            return (
              <li key={img.key} className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <span className={i === 0 ? 'badge badge-primary' : 'badge'}>{i === 0 ? '포스터' : '상세'}</span>
                <span className="t-sm ellipsis grow">{name}</span>
                {row?.status === 'done' ? (
                  <span className="badge badge-success">
                    <i className="ic ic-check" aria-hidden="true" />
                    올림 완료
                  </span>
                ) : row?.status === 'error' ? (
                  <>
                    <span className="error-msg" role="alert">
                      <i className="ic ic-alert-circle" aria-hidden="true" />
                      {row.message}
                    </span>
                    {uploads.files.has(img.key) ? (
                      <button className="btn btn-outline btn-sm" type="button" disabled={!canRetry(row, now)} onClick={() => onRetry(img.key)}>
                        다시 올리기
                      </button>
                    ) : null}
                    {!canRetry(row, now) ? (
                      <span className="t-xs muted" role="status">
                        잠시 뒤 다시 올릴 수 있습니다
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="t-xs muted" role="status">
                    올리는 중
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {posterMissing ? (
        <div className="banner banner-warning" role="status">
          <i className="ic ic-alert" aria-hidden="true" />
          <div className="banner-body">판매 승인을 요청하려면 포스터가 있어야 합니다</div>
        </div>
      ) : null}
    </div>
  );
}

function DonePanel({ created, onAgain, uploads, onRetry }: { created: ProductionCreated; onAgain: () => void; uploads: Uploads; onRetry: (key: string) => void }) {
  return (
    <section className="card pad-lg col" style={{ gap: 16 }} aria-labelledby="h-done">
      <div className="section-title">
        <h2 id="h-done">공연을 초안으로 등록했습니다</h2>
        <span className="badge">초안</span>
      </div>
      <p className="t-sm">좌석맵·가격 등급과 판매 승인 요청은 이어서 진행합니다.</p>
      <dl className="kv">
        <dt>공연 ID</dt>
        <dd className="num">{created.productionId}</dd>
        <dt>회차</dt>
        <dd className="num">{created.eventIds.length}개</dd>
      </dl>
      {created.warnings.map((w) => (
        <div key={`${w.eventIndex}-${w.code}`} className="banner banner-warning" role="status">
          <i className="ic ic-alert" aria-hidden="true" />
          <div className="banner-body">
            {w.eventIndex + 1}회차: {warningText(w)}
          </div>
        </div>
      ))}
      <ImageResults uploads={uploads} onRetry={onRetry} />
      <div className="row" style={{ gap: 8 }}>
        <Link className="btn btn-primary" href={routes.events()}>
          공연 관리로 가기
        </Link>
        <button className="btn btn-outline" type="button" onClick={onAgain}>
          새 공연 등록
        </button>
      </div>
    </section>
  );
}

export function LiveWizard() {
  const [keeper] = useState(() => new DraftKeeper(browserDraftStore, emptyDraft()));
  const [draft, setDraft] = useState<WizardDraft>(() => keeper.value());
  const [step, setStep] = useState<LiveStep>(1);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [restored, setRestored] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<ProductionCreated | null>(null);
  const media = useImageFiles();
  const [overflow, setOverflow] = useState(0);
  const [uploads, setUploads] = useState<Uploads | null>(null);
  /** 다른 탭이 등록했거나 초안을 지웠다 */
  const [closed, setClosed] = useState(false);
  const sending = useRef(false);
  /** 값이 밖에서 바뀌면(복원·다른 탭·처음부터) 편집기를 새로 그린다. 편집기는 처음 내용만 읽는다 */
  const [editorKey, setEditorKey] = useState(0);

  const flush = useCallback(() => {
    const result = keeper.flush();
    if (result === 'none') return;
    setSaveFailed(result === 'failed');
    if (result === 'saved') setSavedAt(Date.now());
  }, [keeper]);

  useEffect(() => {
    const stored = keeper.restore();
    if (stored) {
      setDraft(stored);
      setRestored(true);
      setEditorKey((k) => k + 1);
    }
  }, [keeper]);

  useEffect(() => {
    if (!keeper.isDirty()) return;
    const timer = setTimeout(flush, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [draft, keeper, flush]);

  useEffect(() => {
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      // 앱 안 이동에는 pagehide가 없다. 떠날 때 마지막 입력을 저장한다
      keeper.flush();
    };
  }, [keeper, flush]);

  useEffect(
    () =>
      watchOtherTabs((other) => {
        const before = JSON.stringify(keeper.value().description);
        const result = keeper.fromOtherTab(other);
        if (result === 'closed') setClosed(true);
        else if (result === 'adopted') {
          setDraft(keeper.value());
          setRestored(false);
          setErrors([]);
          // 설명이 바뀌었을 때만 다시 그린다(다시 그리면 입력 중인 초점과 실행 취소 기록이 사라진다)
          if (JSON.stringify(keeper.value().description) !== before) setEditorKey((k) => k + 1);
        }
      }),
    [keeper],
  );

  // 단계를 옮긴 뒤 초점: 오류가 있으면 요약으로, 없으면 단계 본문으로(화면 낭독기가 새 단계를 읽게 한다)
  const [focusTick, setFocusTick] = useState(0);
  const summary = useRef<HTMLDivElement | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (focusTick === 0) return;
    const target = summary.current ?? body.current;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'start' });
  }, [focusTick]);

  const update = useCallback(
    (patch: Partial<WizardDraft>, field: string) => {
      const next = { ...keeper.value(), ...patch };
      keeper.change(next);
      setDraft(next);
      setRestored(false);
      setErrors((es) => clearFieldErrors(es, field));
    },
    [keeper],
  );

  const errorOf = useCallback((field: string) => errors.find((e) => e.field === field)?.message, [errors]);

  const leaveForLogin = useCallback(() => {
    keeper.flush();
    window.location.assign(routes.login());
  }, [keeper]);

  const onApiError = useCallback(
    (e: unknown) => {
      if (isUnauthorized(e)) leaveForLogin();
    },
    [leaveForLogin],
  );

  function show(next: LiveStep, errs: FieldError[]) {
    flush();
    setRestored(false);
    setErrors(errs);
    setStep(next);
    setFocusTick((t) => t + 1);
  }

  /** 1단계 이미지 줄의 오류(파일 없는 줄·화면 검사·대체 텍스트·장수)를 칸 오류 하나로 모은다 */
  function imageFieldErrors(): FieldError[] {
    const errs = imageErrors(draft.images, fileState(media.files, draft.images.map((x) => x.key)));
    if (errs.length === 0) return [];
    return [{ step: 1, field: 'images', message: errs.length === 1 ? errs[0]!.message : `이미지 ${errs.length}장을 확인해 주세요` }];
  }

  function goNext() {
    const errs = step === 3 ? [] : [...validateStep(draft, step as InputStep, Date.now()), ...(step === 1 ? imageFieldErrors() : [])];
    if (errs.length > 0) show(step, errs);
    else show((step + 1) as LiveStep, []);
  }

  async function submit() {
    if (sending.current) return;
    const now = Date.now();
    const errs = [...validateStep(draft, 1), ...imageFieldErrors(), ...validateStep(draft, 2, now), ...validateStep(draft, 4)];
    if (errs.length > 0) {
      const first = errs[0]!.step;
      show(first, errs.filter((e) => e.step === first));
      return;
    }
    const payload = toCreateBody(draft);
    const key = keeper.requestKey(payload, () => crypto.randomUUID());
    sending.current = true;
    setSubmitting(true);
    setErrors([]);
    try {
      const done = await createProduction(payload, key);
      keeper.finish();
      setCreated(done);
      setFocusTick((t) => t + 1);
      startUploads(done.productionId, { images: draft.images, files: media.files, rows: new Map() });
    } catch (e) {
      if (isUnauthorized(e)) {
        leaveForLogin();
        return;
      }
      const failed = errorsFromFailure(e, draft);
      show(failed[0]!.step, failed);
    } finally {
      sending.current = false;
      setSubmitting(false);
    }
  }

  /** 등록 뒤 올리기(포스터부터 한 장씩). only를 주면 그 줄만 다시 올린다 */
  function startUploads(productionId: string, base: Uploads, only?: string[]) {
    if (base.images.length === 0) {
      setUploads(base);
      return;
    }
    const mark = new Map(base.rows);
    for (const img of base.images) if (!only || only.includes(img.key)) mark.set(img.key, { key: img.key, status: 'uploading' });
    setUploads({ ...base, rows: mark });
    // 올리기 코드는 이때 늦게 싣는다. 덩어리를 받지 못하면 줄마다 오류(다시 올리기 가능)가 된다(runUploads)
    const done = [...base.rows.values()].filter((r) => r.status === 'done').map((r) => r.key);
    void runUploads({
      load: () => import('../../model/image-upload'),
      productionId,
      images: base.images,
      fileOf: (k) => base.files.get(k)?.file,
      send: uploadProductionImage,
      done,
      ...(only ? { only } : {}),
      onEach: (r) => {
        setUploads((u) => (u ? { ...u, rows: new Map(u.rows).set(r.key, r) } : u));
        // 로그인이 끝났으면 등록 경로처럼 로그인으로 보낸다
        if (r.unauthorized) leaveForLogin();
      },
    });
  }

  function startOver() {
    media.clear();
    setOverflow(0);
    setUploads(null);
    const fresh = emptyDraft();
    keeper.reset(fresh);
    setDraft(fresh);
    setEditorKey((k) => k + 1);
    setRestored(false);
    setCreated(null);
    setClosed(false);
    setSavedAt(null);
    setSaveFailed(false);
    setErrors([]);
    setStep(1);
    setFocusTick((t) => t + 1);
  }

  if (closed) {
    return (
      <section className="card pad-lg col max-md:hidden" style={{ gap: 12 }} aria-labelledby="h-closed" role="status">
        <h2 id="h-closed">다른 탭에서 이 공연을 등록했거나 초안을 지웠습니다</h2>
        <p className="t-sm">같은 공연이 두 번 등록되지 않도록 이 탭의 입력을 멈췄습니다.</p>
        <div className="row" style={{ gap: 8 }}>
          <Link className="btn btn-primary" href={routes.events()}>
            공연 관리로 가기
          </Link>
          <button className="btn btn-outline" type="button" onClick={startOver}>
            처음부터 다시
          </button>
        </div>
      </section>
    );
  }

  if (created) {
    return (
      <div className="col max-md:hidden" style={{ gap: 20 }} ref={body} tabIndex={-1}>
        <DonePanel created={created} onAgain={startOver} uploads={uploads ?? { images: [], files: media.files, rows: new Map() }} onRetry={(k) => {
            const row = uploads?.rows.get(k);
            if (uploads && row && canRetry(row, Date.now())) startUploads(created.productionId, uploads, [k]);
          }} />
      </div>
    );
  }

  const props = { draft, update, errorOf };
  const saveText = saveFailed ? '이 브라우저에 임시저장하지 못했습니다' : savedAt !== null ? `자동 임시저장됨 ${kstClock(savedAt)} KST` : '입력하면 이 브라우저에 자동으로 임시저장합니다';

  return (
    <>
      <div className="col max-md:hidden" style={{ gap: 20 }}>
        <WizardStepper view={{ context: 'new', body: { kind: 'step', step: step as WizardStep } }} />
        {restored ? (
          <div className="banner banner-info" role="status" style={{ flexWrap: 'wrap' }}>
            <i className="ic ic-info" aria-hidden="true" />
            <div className="banner-body" style={{ flex: '1 1 300px' }}>
              이 브라우저에 임시저장한 내용을 불러왔습니다
            </div>
            <button className="btn btn-outline btn-sm" type="button" onClick={startOver}>
              처음부터 다시
            </button>
          </div>
        ) : null}
        <ErrorSummary
          errors={errors}
          refCallback={(el) => {
            summary.current = el;
          }}
        />
        {/* 하단 고정 막대에 초점 칸이 가리지 않게 여유를 둔다(WCAG 2.4.11). 등록 중에는 입력을 잠근다 */}
        <div ref={body} tabIndex={-1} className="[&_:is(input,select,textarea,button,a)]:scroll-mb-28 [&_[contenteditable]]:scroll-mb-28" style={{ outline: 'none' }} onFocusCapture={(e) => e.target.scrollIntoView({ block: 'nearest' })}>
          <fieldset disabled={submitting} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            {step === 1 ? <LiveStepBasic {...props} onApiError={onApiError} editorKey={editorKey} media={{ files: media.files, attach: media.attach, drop: media.drop, overflow, onOverflow: setOverflow }} /> : step === 2 ? <LiveStepRounds {...props} /> : step === 3 ? <SeatmapNotice /> : <LiveStepPolicy {...props} />}
          </fieldset>
        </div>
      </div>

      <div className={BAR} style={BAR_STYLE}>
        <button className="btn btn-outline" type="button" disabled={step === 1 || submitting} aria-describedby={step === 1 ? 'l-prev-why' : undefined} onClick={() => show((step - 1) as LiveStep, [])}>
          <i className="ic ic-arrow-left" aria-hidden="true" />
          이전
        </button>
        {step === 1 ? (
          <span className="sr-only" id="l-prev-why">
            1단계라 이전 단계가 없습니다
          </span>
        ) : null}
        <span className="t-sm muted grow" role="status" style={{ textAlign: 'right' }}>
          {saveText}
        </span>
        <button className="btn btn-secondary" type="button" disabled={submitting} onClick={flush}>
          임시저장
        </button>
        {step < 4 ? (
          <button className="btn btn-primary" type="button" onClick={goNext}>
            다음
            <i className="ic ic-arrow-right" aria-hidden="true" />
          </button>
        ) : (
          <button className="btn btn-primary" type="button" aria-busy={submitting || undefined} aria-disabled={submitting || undefined} onClick={() => void submit()}>
            {submitting ? <span className="spinner" aria-hidden="true" /> : null}
            공연 등록
          </button>
        )}
      </div>
    </>
  );
}
