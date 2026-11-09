// 결제창 복귀 뒤 상태 카드(SCR-011 보드의 복귀 상태: 접수 중 · 복귀 뒤 새로고침 · 금액 불일치 · 이미 진행 중 · 예매 제한).
// 주문·결제 화면(/checkout)과 결제 복귀 화면(/checkout/return)이 같이 쓴다. 카드의 제목이 그 화면의 <h1>이다.
// 위아래 여백: 휴대폰 40 · 태블릿 48 · 데스크톱 64(보드 margin-top).
import Link from 'next/link';

export type PaymentReturnKind = 'accepting' | 'reload' | 'mismatch' | 'other-tab' | 'restricted';

export interface PaymentReturnCardProps {
  kind: PaymentReturnKind;
  /** 좌석 요약(복귀 뒤 새로고침, 데스크톱에서는 숨김). 모르면 줄을 뺀다 */
  seatText?: string;
  /** 합계 '₩308,000'. 모르면 줄을 뺀다 */
  totalText?: string;
  /** 복귀 뒤 카드의 설명 글을 바꾼다(결제창 취소·승인 거절) */
  note?: string;
  /** 복귀 뒤 카드의 버튼 글(기본 '다시 결제하기') */
  retryLabel?: string;
  /** [다시 결제하기]·[다시 시도] → 주문·결제(결제 위젯) */
  retryHref: string;
  /** [소명하기] → SCR-042 */
  appealHref: string;
}

const CARD = 'card pad-lg col mt-10 md:mt-12 lg:mt-16';
const ICON = { width: 56, height: 56 } as const;

export function PaymentReturnCard({ kind, seatText, totalText, note, retryLabel = '다시 결제하기', retryHref, appealHref }: PaymentReturnCardProps) {
  if (kind === 'reload') {
    return (
      <section className={CARD} style={{ gap: 16 }} aria-labelledby="rl-h">
        <div className="col" style={{ gap: 10, alignItems: 'center', textAlign: 'center' }} role="alert">
          <span className="state-icon is-warning" style={ICON}>
            <i className="ic ic-alert-circle" aria-hidden="true" />
          </span>
          <h1 className="t-xl" id="rl-h">
            결제가 끝나지 않았습니다
          </h1>
          <p className="t-md">{note ?? '요금은 청구되지 않습니다. 고른 좌석은 홀드 시간 동안 그대로 있습니다'}</p>
        </div>
        {seatText || totalText ? (
          <dl className="kv">
            {seatText ? (
              <>
                <dt className="lg:hidden">좌석</dt>
                <dd className="lg:hidden">{seatText}</dd>
              </>
            ) : null}
            {totalText ? (
              <>
                <dt className="kv-total">합계</dt>
                <dd className="kv-total num">{totalText}</dd>
              </>
            ) : null}
          </dl>
        ) : null}
        <Link className="btn btn-primary btn-lg btn-block" href={retryHref}>
          {retryLabel}
        </Link>
      </section>
    );
  }
  const view = {
    accepting: { id: 'rt-h', icon: 'ic-clock', tone: 'is-primary', role: 'status', title: '결제 접수 중' },
    mismatch: { id: 'mm-h', icon: 'ic-alert-circle', tone: 'is-warning', role: 'alert', title: '결제 정보가 변경되었습니다' },
    'other-tab': { id: 'ot-h', icon: 'ic-device', tone: 'is-primary', role: 'status', title: '다른 탭에서 결제가 진행 중입니다' },
    restricted: { id: 'br-h', icon: 'ic-ban', tone: 'is-danger', role: 'alert', title: '예매가 제한되어 있어 주문할 수 없습니다' },
  }[kind];
  return (
    <section className={CARD} style={{ gap: 16, alignItems: 'center', textAlign: 'center' }} role={view.role} aria-labelledby={view.id}>
      <span className={`state-icon ${view.tone}`} style={ICON}>
        <i className={`ic ${view.icon}`} aria-hidden="true" />
      </span>
      <h1 className="t-xl" id={view.id}>
        {view.title}
      </h1>
      {kind === 'accepting' ? (
        <>
          <div className="progress indet" role="progressbar" aria-label="결제 접수 중">
            <span />
          </div>
          <p className="t-sm muted">결제창에서 돌아왔습니다. 접수되면 결제 결과 화면으로 넘어갑니다</p>
        </>
      ) : null}
      {kind === 'mismatch' ? (
        <>
          <p className="t-md">다시 확인해 주세요</p>
          {/* 접수 400: 주문서를 다시 불러와 금액을 확인하게 한다(보드는 button, 퍼블리싱에서는 주문·결제로 가는 링크) */}
          <Link className="btn btn-primary btn-lg btn-block" href={retryHref}>
            다시 시도
          </Link>
        </>
      ) : null}
      {kind === 'other-tab' ? (
        <>
          <div className="progress indet" role="progressbar" aria-label="결과 확인 중">
            <span />
          </div>
          <p className="t-sm muted">결과를 확인합니다</p>
        </>
      ) : null}
      {kind === 'restricted' ? (
        <>
          <p className="t-md">고른 좌석은 풀었습니다</p>
          <Link className="btn btn-outline btn-lg btn-block" href={appealHref}>
            소명하기
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </Link>
        </>
      ) : null}
    </section>
  );
}
