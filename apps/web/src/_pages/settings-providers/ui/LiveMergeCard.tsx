'use client';
// SCR-040 ④~⑥ 계정 합치기의 실제 흐름(docs/features/identity.md §2.1 '계정 병합의 첫 구현' 화면, BUILD_ORDER BOT-043, I-T31·I-T32).
// 제안 값(GET /v1/identity/merge-proposals/{id})을 ds MergeSummary로 보이고, 재인증 토큰이 있으면 확인 창(CMP-020 위험 확인)을 연다.
// 재인증·확정 호출·탭 저장소·상태 바뀜은 부르는 쪽(LiveLoginMethods와 features/login-methods의 mergeAfter*)이 맡고, 이 파일은 그리기만 한다.
// 확인 창 마크업은 목업 MergePanel과 같다. 확인 창이 닫히거나 카드가 바뀌면 초점을 카드로 옮긴다(창을 연 버튼이 페이지를 불러올 때라 돌아갈 곳이 없다).
import { useEffect, useId, useRef } from 'react';
import { Dialog } from '@peaket/ds/Dialog';
import { MergeSummary, type MergeSummaryStatus } from '@peaket/ds/MergeSummary';
import { MERGE_CHECK_TITLES, PROVIDER_NAME } from '@/entities/provider';
import { mergeView, type MergeState, type Provider } from '@/features/login-methods';

export interface LiveMergeCardProps {
  merge: MergeState & { phase: MergeSummaryStatus };
  /** 다시 로그인할 수단(지금 계정에 연결된 것, 연결한 순) */
  methods: readonly Provider[];
  busy: boolean;
  onContinue: () => void;
  onConfirm: () => void;
  onCancelConfirm: () => void;
  onDismiss: () => void;
}

export function LiveMergeCard({ merge, methods, busy, onContinue, onConfirm, onCancelConfirm, onDismiss }: LiveMergeCardProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const movesId = `${useId()}-mv`;
  const { phase, view, token } = merge;
  const c = view ? mergeView(view, Date.now(), MERGE_CHECK_TITLES) : null;
  const open = phase === 'ready' && token !== undefined && c !== null;
  // 창이 닫혔거나(취소·만료·재인증 만료) 카드 상태가 바뀌면(처리 중·막힘) 카드로 초점을 옮긴다(새 맥락 리뷰 낮음 8)
  const before = useRef({ open, phase });
  useEffect(() => {
    const was = before.current;
    before.current = { open, phase };
    if (!((was.open && !open) || (was.phase !== phase && was.phase !== 'loading'))) return;
    // 다른 창(수단 고르기)에 있는 초점은 빼앗지 않는다: 초점이 문서 바탕이나 이 카드 안일 때만(다시 검토 낮음 1)
    const at = document.activeElement;
    if (!at || at === document.body || wrapRef.current?.contains(at)) wrapRef.current?.focus();
  }, [open, phase]);
  const one = methods.length === 1 ? methods[0] : undefined;
  // 연결한 수단이 하나면 그 수단 모양으로 바로, 둘 이상이면 기본 모양으로 고르는 창을 연다(특정 제공자처럼 보이지 않게, 새 맥락 리뷰 낮음 9)
  const continueAction =
    phase === 'ready' && methods.length > 0
      ? { label: one ? `${PROVIDER_NAME[one]}로 다시 로그인하고 계속` : '다시 로그인하고 계속', ...(one ? { provider: one } : {}), onClick: () => !busy && onContinue() }
      : undefined;

  return (
    <div ref={wrapRef} tabIndex={-1} className="outline-none">
      <MergeSummary
        status={phase}
        question={c?.question}
        blockedQuestion={c?.blockedQuestion}
        survivor={c?.survivor ?? ''}
        absorbed={c?.absorbed ?? ''}
        moves={c?.moves ?? []}
        movesNote={c?.movesNote}
        keeps={c?.keeps ?? ''}
        remaining={c?.remaining}
        deadline={view?.expiresAt}
        blockedReason={c?.blockedReason}
        checks={c?.checks ?? []}
        merging={c?.merging}
        expiredText={c?.expiredText ?? '합치기 제안 시간이 지났습니다. 다시 추가해 주세요'}
        continueAction={continueAction}
        onDismiss={onDismiss}
        className="mx-4 mt-7 md:mx-0 md:mt-0"
      />

      {c && token ? (
        <Dialog open={open} onClose={() => !busy && onCancelConfirm()} title="두 계정을 합칩니다" layout="auto" role="alertdialog" maxWidth={480} initialFocus={cancelRef}>
          <p className="row t-sm tx-success" style={{ gap: 6 }}>
            <i className="ic ic-check-circle ic-16" aria-hidden="true" />
            {PROVIDER_NAME[token.via]}로 다시 로그인했습니다
          </p>
          {merge.error ? (
            <div className="banner banner-danger" role="alert">
              <i className="ic ic-alert-circle" aria-hidden="true" />
              <div className="banner-body">{merge.error}</div>
            </div>
          ) : null}
          <dl className="kv">
            <dt>남는 계정(대표)</dt>
            <dd>{c.survivor}</dd>
            <dt>합쳐지는 계정</dt>
            <dd>{c.absorbed}</dd>
          </dl>
          <div className="card-flat col" style={{ gap: 8, padding: '14px 16px' }}>
            <h3 className="t-sm fw-b" id={movesId}>
              옮겨 오는 것
            </h3>
            <ul className="t-sm" aria-labelledby={movesId} style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: '6px 20px' }}>
              {c.moves.map((m) => (
                <li key={m.label} className="row between">
                  <span className="muted">{m.label}</span>
                  <span className="num fw-b">{m.value}</span>
                </li>
              ))}
            </ul>
            {c.movesNote ? <p className="t-xs muted">{c.movesNote}</p> : null}
          </div>
          <p className="t-sm">
            닉네임과 동의 내역은 대표 계정 것을 그대로 씁니다. {view?.requesterRole === 'MERGED' ? '지금 계정은 합쳐진 뒤 로그아웃됩니다. ' : ''}합치면 되돌릴 수 없습니다.
          </p>
          <div className="col" style={{ gap: 8 }}>
            <button className="btn btn-danger btn-lg btn-block" type="button" aria-disabled={busy ? true : undefined} onClick={() => !busy && onConfirm()}>
              두 계정을 합칩니다. 되돌릴 수 없습니다
            </button>
            <button ref={cancelRef} className="btn btn-ghost btn-block" type="button" onClick={() => !busy && onCancelConfirm()}>
              합치지 않고 닫기
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
