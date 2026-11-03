'use client';
// SCR-038 상호작용: 좌석 고르기(체크박스) → 환급 예상액(CMP-054)과 아래 막대·데스크톱 패널이 고른 좌석대로 바뀐다 →
// [선택한 N장 취소하기] → 소셜 재인증 시트(CMP-064 fan-social) → 최종 확인 시트(위험 확인, 결과를 적은 버튼) → '취소 처리 중'.
// 시트 마크업은 보드 SCR-038-m의 .scrim.bottom + .sheet 그대로다(ds Dialog auto: 휴대폰은 시트, md 이상은 가운데 대화상자).
// 실제 재인증·취소 API는 붙이지 않는다(퍼블리싱). 다음 상태로는 ?state= 주소를 바꿔 넘어간다.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@peaket/ds/Button';
import { Dialog } from '@peaket/ds/Dialog';
import { NoticeBanner } from '@peaket/ds/NoticeBanner';
import { previewHref } from '@peaket/ds/Preview';
import { RefundQuote } from '@peaket/ds/RefundQuote';
import { cx } from '@/shared/lib/cx';
import { CARD_REFUND_TEXT, CURRENT_FEE_BP, CURRENT_FEE_TEXT, refundOf, type CancelSeat, type CancelSheet } from '../model/view';

const won = (n: number) => `₩${new Intl.NumberFormat('ko-KR').format(n)}`;

interface CancelCtx {
  seats: readonly CancelSeat[];
  selected: string[];
  toggle: (ticketId: string) => void;
  /** 양도 요청 중이라 고를 수 없는 티켓 */
  blockedId: string | null;
  postponed: boolean;
  calculating: boolean;
  vbank: boolean;
  sheet: CancelSheet | null;
  setSheet: (s: CancelSheet | null) => void;
  /** 고른 좌석 합계 */
  n: number;
  seatText: string;
  paid: number;
  deduction: number;
  refund: number;
  /** 다음 상태로 넘어가기 */
  go: (state: string) => void;
  doneHref: string;
}

const Ctx = createContext<CancelCtx | null>(null);
function useCancel(): CancelCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('CancelProvider 안에서만 쓴다');
  return v;
}

export interface CancelProviderProps {
  seats: readonly CancelSeat[];
  initialSelected: string[];
  blockedId?: string | null;
  postponed?: boolean;
  calculating?: boolean;
  vbank?: boolean;
  initialSheet: CancelSheet | null;
  path: string;
  keep: Record<string, string | undefined>;
  /** 연기 환급 신청 뒤 진행 상태(SCR-055) */
  doneHref: string;
  children: ReactNode;
}

export function CancelProvider({
  seats,
  initialSelected,
  blockedId = null,
  postponed = false,
  calculating = false,
  vbank = false,
  initialSheet,
  path,
  keep,
  doneHref,
  children,
}: CancelProviderProps) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>(initialSelected);
  const [sheet, setSheet] = useState<CancelSheet | null>(initialSheet);
  const value = useMemo<CancelCtx>(() => {
    const chosen = seats.filter((s) => selected.includes(s.ticketId));
    const bp = postponed ? 0 : CURRENT_FEE_BP;
    const sums = chosen.reduce(
      (a, s) => {
        const r = refundOf(s.price, bp);
        return { paid: a.paid + s.price, deduction: a.deduction + r.deduction, refund: a.refund + r.refund };
      },
      { paid: 0, deduction: 0, refund: 0 },
    );
    return {
      seats,
      selected,
      toggle: (id) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : seats.filter((s) => s.ticketId === id || cur.includes(s.ticketId)).map((s) => s.ticketId))),
      blockedId,
      postponed,
      calculating,
      vbank,
      sheet,
      setSheet,
      n: chosen.length,
      seatText: chosen.map((s) => s.seat).join(', '),
      ...sums,
      go: (state) => router.push(previewHref(path, state, keep), { scroll: false }),
      doneHref,
    };
  }, [seats, selected, blockedId, postponed, calculating, vbank, sheet, path, keep, doneHref, router]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** ① 취소할 좌석(좌석 단위로 고른다). 양도 요청 중인 좌석은 비활성 + 이유 글 + ( 요청 보기 › ) */
export function SeatChoices({ transferHref }: { transferHref: string }) {
  const c = useCancel();
  return (
    <fieldset className="col gap-2.5" aria-describedby="sel-h">
      <legend className="t-md fw-b mb-2.5 lg:mb-3 lg:text-lg">취소할 좌석</legend>
      <div className="col gap-2.5 lg:grid lg:grid-cols-2 lg:gap-3">
        {c.seats.map((s) => {
          const id = `c-${s.ticketId}`;
          const meta = `${s.grade} · ${won(s.price)} · ${s.gate}`;
          if (s.ticketId === c.blockedId) {
            return (
              <div key={s.ticketId} className="card col gap-2 px-4 py-3.5 md:px-[18px] lg:py-4" style={{ borderColor: 'var(--danger)' }}>
                <label className="row gap-3" htmlFor={id}>
                  <input className="cb" id={id} type="checkbox" disabled aria-invalid="true" aria-describedby={`${id}-e`} />
                  <span className="col grow gap-0.5">
                    <span className="t-md fw-b">{s.seat}</span>
                    <span className="t-sm muted">{meta}</span>
                  </span>
                  <span className="badge badge-warning">양도 요청 중</span>
                </label>
                <span className="error-msg" id={`${id}-e`}>
                  <i className="ic ic-alert-circle" aria-hidden="true" />
                  양도 요청을 철회한 뒤 취소할 수 있습니다
                </span>
                <Link className="link-more self-start" href={transferHref} aria-label={`${s.seat} 양도 요청 보기`}>
                  요청 보기
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </Link>
              </div>
            );
          }
          const on = c.selected.includes(s.ticketId);
          return (
            <label
              key={s.ticketId}
              className={cx('card row cursor-pointer gap-3 px-4 py-3.5 md:px-[18px] lg:py-4', on && 'is-selected')}
              htmlFor={id}
            >
              <input className="cb" id={id} type="checkbox" checked={on} onChange={() => c.toggle(s.ticketId)} />
              <span className="col grow gap-0.5">
                <span className="t-md fw-b">{s.seat}</span>
                <span className="t-sm muted">{meta}</span>
              </span>
              <span className="badge badge-success">사용 가능</span>
            </label>
          );
        })}
      </div>
      <p className="hint" id="sel-h">
        좌석마다 따로 취소할 수 있습니다. 여러 장을 고르면 좌석마다 한 번씩 다시 로그인합니다.
      </p>
    </fieldset>
  );
}

function quoteProps(c: CancelCtx, place: 'inline' | 'aside') {
  const state = c.calculating ? ('loading' as const) : c.n === 0 ? ('empty' as const) : ('ready' as const);
  const rows = c.postponed
    ? [
        { label: '결제 금액', value: won(c.paid) },
        { label: '공제', value: '0원' },
      ]
    : [
        { label: '결제 금액', value: won(c.paid) },
        { label: `취소 수수료(${CURRENT_FEE_TEXT})`, value: `−${won(c.deduction)}` },
      ];
  const method = c.vbank
    ? { icon: 'bank' as const, text: place === 'inline' ? '아래에 입력한 환불 계좌로 3영업일 안에 환급합니다' : '입력한 환불 계좌로 3영업일 안에 환급합니다' }
    : { icon: 'receipt' as const, text: `${CARD_REFUND_TEXT}로 3영업일 안에 환급합니다` };
  return {
    state,
    rows,
    total: won(c.refund),
    basis: c.postponed ? undefined : `공연 5일 전이라 입장료의 ${CURRENT_FEE_TEXT}를 공제하고 환급합니다(소비자분쟁해결기준)`,
    method,
  };
}

/** ③ 환급 예상액(휴대폰·태블릿: 기준표 아래) */
export function QuoteInline({ className }: { className?: string }) {
  const c = useCancel();
  const q = quoteProps(c, 'inline');
  return (
    <RefundQuote
      {...q}
      headingId="h-q"
      badge={`${c.n}장 · ${c.seatText}`}
      className={cx(q.state !== 'empty' && 'md:px-5 md:py-[18px]', className)}
    />
  );
}

/** ③ 데스크톱 오른쪽 고정 패널: 환급 명세 + 실행 버튼(명세가 버튼보다 먼저 읽힌다) */
export function QuoteAside() {
  const c = useCancel();
  const q = quoteProps(c, 'aside');
  const blocked = c.calculating ? '환급 예상액을 계산한 뒤 진행할 수 있습니다' : c.n === 0 ? '취소할 좌석을 고르면 진행할 수 있습니다' : null;
  return (
    <RefundQuote
      {...q}
      headingId="h-q-lg"
      titleClassName="t-lg"
      badge={`${c.n}장`}
      summary={c.seatText}
      className="lg:gap-3.5 lg:px-5 lg:py-[22px]"
      footer={
        <>
          <div className="divider" />
          <Button
            size="lg"
            block
            aria-describedby="cta-note"
            disabledReasonId={blocked ? 'cta-why' : undefined}
            aria-haspopup="dialog"
            onClick={() => c.setSheet('reauth')}
          >
            {ctaLabel(c)}
          </Button>
          {blocked ? (
            <p className="t-xs muted" id="cta-why">
              {blocked}
            </p>
          ) : null}
          <p className="t-xs muted" id="cta-note">
            다음 단계에서 카카오로 다시 로그인하고, 환급액을 한 번 더 확인한 뒤 {c.postponed ? '신청합니다' : '취소합니다'}.
          </p>
        </>
      }
    />
  );
}

function ctaLabel(c: CancelCtx): string {
  if (c.n === 0 || c.calculating) return c.n === 0 ? '선택한 좌석 취소하기' : `선택한 ${c.n}장 취소하기`;
  return c.postponed ? `선택한 ${c.n}장 환급 신청하기` : `선택한 ${c.n}장 취소하기`;
}

/** 휴대폰·태블릿 아래 고정 막대(보드 m·t의 .bottom-bar). 데스크톱(lg)은 오른쪽 패널이 버튼을 가진다 */
export function CancelBar() {
  const c = useCancel();
  const blocked = c.calculating ? '환급 예상액을 계산한 뒤 진행할 수 있습니다' : c.n === 0 ? '취소할 좌석을 고르면 진행할 수 있습니다' : null;
  return (
    <div className="bottom-bar sticky bottom-0 z-10 md:px-6 md:pt-3.5 md:pb-5 lg:hidden">
      <div className="mx-auto flex w-full max-w-[600px] flex-col items-stretch gap-2.5 md:flex-row md:items-center md:gap-4">
        {c.n > 0 ? (
          <div className="flex items-center justify-between md:grow md:flex-col md:items-start md:justify-start md:gap-0.5">
            <span className="t-sm muted">환급 예상액 · {c.n}장</span>
            {c.calculating ? <span className="skel" style={{ height: 24, width: 96 }} /> : <span className="t-lg num">{won(c.refund)}</span>}
          </div>
        ) : null}
        <div className={cx('col gap-2.5', c.n === 0 && 'md:grow md:items-end')}>
          <Button
            size="lg"
            className="w-full md:w-auto md:min-w-[240px]"
            disabledReasonId={blocked ? 'bb-why' : undefined}
            aria-haspopup="dialog"
            onClick={() => c.setSheet('reauth')}
          >
            {ctaLabel(c)}
          </Button>
          {blocked ? (
            <p className="t-xs muted text-center" id="bb-why">
              {blocked}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** 재인증·최종 확인·재인증 만료·연기 환급 최종 확인 시트 */
export function CancelSheets() {
  const c = useCancel();
  const router = useRouter();
  const close = () => c.setSheet(null);
  const next: CancelSheet = c.postponed ? 'postFinal' : 'final';
  const method = c.vbank ? '입력한 환불 계좌 · 3영업일 안' : `${CARD_REFUND_TEXT} · 3영업일 안`;
  const reauthActions = (
    <>
      <Button variant="kakao" size="lg" block onClick={() => c.setSheet(next)}>
        카카오로 다시 로그인하고 계속
      </Button>
      <Button variant="ghost" block onClick={close}>
        닫기
      </Button>
    </>
  );
  const reauthed = (
    <p className="t-xs tx-success row gap-1.5">
      <i className="ic ic-check-circle ic-16" aria-hidden="true" />
      카카오로 다시 로그인했습니다
    </p>
  );
  // 연기 환급의 재인증 시트 글은 보드에 없어 취소 시트의 틀에 작업 이름만 바꿨다(추천안)
  const job = c.postponed ? '환급 신청을' : '취소를';
  return (
    <>
      <Dialog
        open={c.sheet === 'reauth'}
        onClose={close}
        layout="auto"
        icon="shield"
        iconTone="primary"
        title="다시 로그인하고 계속"
        description={`${c.postponed ? '환급 신청은' : '예매 취소는'} 되돌릴 수 없어 로그인한 분이 맞는지 한 번 더 확인합니다. 지금 로그인한 카카오 계정으로 다시 로그인해 주세요.`}
        actions={reauthActions}
      >
        <p className="t-sm muted">다시 로그인한 뒤 5분 안에 {job} 마쳐야 합니다.</p>
      </Dialog>

      <Dialog
        open={c.sheet === 'final'}
        onClose={close}
        layout="auto"
        title="예매 취소 확인"
        describedBy="fc-d"
        actions={
          <>
            <Button
              variant="danger"
              size="lg"
              block
              style={{ whiteSpace: 'normal', height: 'auto', minHeight: 52, padding: '12px 16px' }}
              onClick={() => c.go('취소 처리 중')}
            >
              예매를 취소하고 {won(c.refund)}을 환급받습니다
            </Button>
            <Button variant="ghost" block onClick={close}>
              예매 유지하기
            </Button>
          </>
        }
      >
        <dl className="kv" id="fc-d">
          <dt>취소할 좌석</dt>
          <dd>{c.seatText}</dd>
          <dt>결제 금액</dt>
          <dd>{won(c.paid)}</dd>
          <dt>취소 수수료({CURRENT_FEE_TEXT})</dt>
          <dd>−{won(c.deduction)}</dd>
          <dt className="kv-total">환급 예상액</dt>
          <dd className="kv-total">{won(c.refund)}</dd>
          <dt>환급 수단</dt>
          <dd>{method}</dd>
        </dl>
        <p className="t-sm muted">취소하면 되돌릴 수 없고, 이 좌석은 다른 분에게 다시 판매됩니다.</p>
        {reauthed}
      </Dialog>

      <Dialog
        open={c.sheet === 'expired'}
        onClose={close}
        layout="auto"
        title="다시 로그인해 주세요"
        describedBy="ex-d"
        actions={reauthActions}
      >
        <NoticeBanner tone="danger" role="alert">
          다시 로그인한 지 5분이 지났습니다. 다시 로그인해 주세요
        </NoticeBanner>
        <p className="t-sm muted" id="ex-d">
          예매는 아직 취소하지 않았습니다. 다시 로그인하면 이어서 취소할 수 있습니다.
        </p>
      </Dialog>

      <Dialog
        open={c.sheet === 'postFinal'}
        onClose={close}
        layout="auto"
        title="환급 신청 확인"
        describedBy="pf-d"
        actions={
          <>
            <Button
              variant="danger"
              size="lg"
              block
              style={{ whiteSpace: 'normal', height: 'auto', minHeight: 52, padding: '12px 16px' }}
              onClick={() => router.push(c.doneHref)}
            >
              환급을 신청하고 {won(c.refund)}을 받습니다
            </Button>
            <Button variant="ghost" block onClick={close}>
              예매 유지하기
            </Button>
          </>
        }
      >
        <dl className="kv" id="pf-d">
          <dt>환급할 좌석</dt>
          <dd>{c.seatText}</dd>
          <dt>결제 금액</dt>
          <dd>{won(c.paid)}</dd>
          <dt>공제</dt>
          <dd>0원</dd>
          <dt className="kv-total">환급 예상액</dt>
          <dd className="kv-total">{won(c.refund)}</dd>
          <dt>환급 수단</dt>
          <dd>{method}</dd>
        </dl>
        <p className="t-sm muted">환급을 신청하면 되돌릴 수 없고, 이 좌석의 티켓은 바로 쓸 수 없게 됩니다.</p>
        {reauthed}
      </Dialog>
    </>
  );
}
