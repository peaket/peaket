// [정산서] 탭(보드 상태 정산·KYC 예고·이의 제기 대화상자·이의 기간 끝·재통지(조정)·재통지(기각), d5 §6.10).
// 휴대폰: 결제사 카드 · 이의 제기는 아래 시트 / 태블릿: 지급액을 앞으로 당긴 가로 스크롤 표 / 데스크톱: 8칸 표 + 지급 안내 7·배상 5열.
// 이의 제기는 파트너 관리자만 한다(상품 정산서와 같은 규칙, SCR-023). 실무자에게는 AdminOnly로 이유 글을 보인다.
import { formatWon } from '@/entities/production';
import { AdminOnly } from '@/features/admin-only';
import { Modal } from '@/shared/ui/Modal';
import { DISPUTE_CODES, PAYOUT_HOLDS, settleTotals, statements, type Statement } from '../model/settlement';
import { CountedTextarea, DownloadMenu } from './client';
import { RoundSelect, SHEET_ACTIONS, SHEET_PRIMARY } from './parts';

export type SettleVariant = '정산' | 'KYC 예고' | '이의 제기 대화상자' | '이의 기간 끝' | '재통지(조정)' | '재통지(기각)';

interface Ctx {
  v: SettleVariant;
  isMember: boolean;
  round: string;
}

function disputeBadge(s: Statement, v: SettleVariant): string {
  if (v === '이의 기간 끝') return '이의 기간 끝 10/28(수)';
  if (s.key === 'toss' && (v === '재통지(조정)' || v === '재통지(기각)')) return '재통지 · 이의 기간 1영업일';
  return '이의 기한 10/28(수) · 2영업일 남음';
}

function payNote(s: Statement, v: SettleVariant): string {
  return s.kycHold && v !== 'KYC 예고' ? 'KYC 확인 뒤 지급' : '예정대로 지급';
}

function DisputeButton({ s, ctx, sfx, block = false }: { s: Statement; ctx: Ctx; sfx: string; block?: boolean }) {
  const cls = block ? 'btn btn-outline btn-block' : 'btn btn-outline btn-sm';
  const label = (
    <>
      <span aria-hidden="true">이의 제기</span>
      <span className="sr-only">{s.provider} 정산서 이의 제기</span>
    </>
  );
  if (ctx.isMember)
    return (
      <AdminOnly isMember id={`dp-${s.key}-${sfx}`} className={cls}>
        {label}
      </AdminOnly>
    );
  const ended = ctx.v === '이의 기간 끝';
  const whyId = `dp-why-${s.key}-${sfx}`;
  return (
    <>
      <button
        className={cls}
        type="button"
        aria-haspopup="dialog"
        data-modal-open={`dispute-${s.key}`}
        aria-disabled={ended ? 'true' : undefined}
        aria-describedby={ended ? whyId : undefined}
      >
        {label}
      </button>
      {ended ? (
        block ? (
          <p className="t-sm fw-b" id={whyId}>
            이의 기간이 끝났습니다
          </p>
        ) : (
          <span className="t-xs fw-b" id={whyId}>
            이의 기간이 끝났습니다
          </span>
        )
      ) : null}
    </>
  );
}

function StatusCell({ s, ctx, sfx }: { s: Statement; ctx: Ctx; sfx: string }) {
  return (
    <div className="col" style={{ gap: 6, alignItems: 'flex-start' }}>
      <div className="row wrap" style={{ gap: 4 }}>
        <span className="badge badge-primary">통지됨</span>
        <span className="badge">
          <i className="ic ic-clock" aria-hidden="true" />
          {disputeBadge(s, ctx.v)}
        </span>
      </div>
      <DisputeButton s={s} ctx={ctx} sfx={sfx} />
    </div>
  );
}

function PayDateCell({ s, ctx }: { s: Statement; ctx: Ctx }) {
  return (
    <div className="col" style={{ gap: 2 }}>
      <span className="num">{s.payDate}</span>
      <span className="t-xs muted">{payNote(s, ctx.v)}</span>
    </div>
  );
}

const caption = (round: string) => `${round} 회차의 결제사별 정산서와 지급 상태`;

/** 데스크톱 표(금액 → 지급 예정일 → 상태) */
function DesktopTable({ ctx }: { ctx: Ctx }) {
  return (
    <div className="table-wrap max-lg:hidden">
      <table className="table dense">
        <caption className="sr-only">{caption(ctx.round)}</caption>
        <thead>
          <tr>
            <th scope="col">결제사</th>
            <th scope="col" className="r">
              판매 대금
            </th>
            <th scope="col" className="r">
              환급
            </th>
            <th scope="col" className="r">
              수수료·부가세
            </th>
            <th scope="col" className="r">
              상계
            </th>
            <th scope="col" className="r">
              지급액
            </th>
            <th scope="col">지급 예정일</th>
            <th scope="col">상태</th>
          </tr>
        </thead>
        <tbody>
          {statements.map((s) => (
            <tr key={s.key}>
              <td className="fw-b">{s.provider}</td>
              <td className="r">{formatWon(s.sales)}</td>
              <td className="r">{formatWon(s.refund)}</td>
              <td className="r">{formatWon(s.fee)}</td>
              <td className="r">{formatWon(s.offset)}</td>
              <td className="r fw-b">{formatWon(s.payout)}</td>
              <td>
                <PayDateCell s={s} ctx={ctx} />
              </td>
              <td>
                <StatusCell s={s} ctx={ctx} sfx="d" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 태블릿 표(상태·지급 예정일·지급액을 앞으로, 가로 스크롤) */
function TabletTable({ ctx }: { ctx: Ctx }) {
  return (
    <div className="table-wrap table-scroll max-md:hidden lg:hidden" role="region" aria-label="결제사별 정산서 표" tabIndex={0}>
      <table className="table dense" style={{ minWidth: 920 }}>
        <caption className="sr-only">{caption(ctx.round)}</caption>
        <thead>
          <tr>
            <th scope="col">결제사</th>
            <th scope="col">상태</th>
            <th scope="col">지급 예정일</th>
            <th scope="col" className="r">
              지급액
            </th>
            <th scope="col" className="r">
              판매 대금
            </th>
            <th scope="col" className="r">
              환급
            </th>
            <th scope="col" className="r">
              수수료·부가세
            </th>
            <th scope="col" className="r">
              상계
            </th>
          </tr>
        </thead>
        <tbody>
          {statements.map((s) => (
            <tr key={s.key}>
              <td className="fw-b">{s.provider}</td>
              <td>
                <StatusCell s={s} ctx={ctx} sfx="t" />
              </td>
              <td>
                <PayDateCell s={s} ctx={ctx} />
              </td>
              <td className="r fw-b">{formatWon(s.payout)}</td>
              <td className="r">{formatWon(s.sales)}</td>
              <td className="r">{formatWon(s.refund)}</td>
              <td className="r">{formatWon(s.fee)}</td>
              <td className="r">{formatWon(s.offset)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 휴대폰 결제사 카드 */
function MobileCards({ ctx }: { ctx: Ctx }) {
  return (
    <ul className="col md:hidden" style={{ gap: 12 }} aria-label={caption(ctx.round)}>
      {statements.map((s) => (
        <li key={s.key} className="card pad col" style={{ gap: 12 }}>
          <div className="row between" style={{ gap: 8 }}>
            <h4 className="t-md fw-b">{s.provider}</h4>
            <span className="badge badge-primary">통지됨</span>
          </div>
          <div className="row between" style={{ gap: 8, alignItems: 'baseline' }}>
            <span className="t-sm muted">지급액</span>
            <span className="t-lg num">{formatWon(s.payout)}</span>
          </div>
          <div className="row between" style={{ gap: 8, alignItems: 'flex-start' }}>
            <span className="t-sm muted">지급 예정일</span>
            <span className="col" style={{ gap: 2, alignItems: 'flex-end' }}>
              <span className="t-sm fw-m num">{s.payDate}</span>
              <span className="t-xs muted">{payNote(s, ctx.v)}</span>
            </span>
          </div>
          <span className="badge" style={{ alignSelf: 'flex-start' }}>
            <i className="ic ic-clock" aria-hidden="true" />
            {disputeBadge(s, ctx.v)}
          </span>
          <hr className="divider" />
          <dl className="kv" style={{ rowGap: 6 }}>
            <dt>판매 대금</dt>
            <dd>{formatWon(s.sales)}</dd>
            <dt>환급</dt>
            <dd>{formatWon(s.refund)}</dd>
            <dt>수수료·부가세</dt>
            <dd>{formatWon(s.fee)}</dd>
            <dt>상계</dt>
            <dd>{formatWon(s.offset)}</dd>
          </dl>
          <DisputeButton s={s} ctx={ctx} sfx="m" block />
        </li>
      ))}
    </ul>
  );
}

/** 이의 제기 대화상자(휴대폰은 아래 시트). 결제사마다 하나 */
function DisputeDialog({ s, open, round }: { s: Statement; open: boolean; round: string }) {
  const id = `dispute-${s.key}`;
  return (
    <Modal id={id} defaultOpen={open} labelledBy={`${id}-t`} describedBy={`${id}-d`} maxWidth={520}>
      <span className="sheet-handle md:hidden" aria-hidden="true" />
      <h2 className="dialog-title" id={`${id}-t`}>
        정산서 이의 제기
      </h2>
      <p className="t-sm muted" id={`${id}-d`}>
        {s.provider} · {round} 회차 · 지급액 {formatWon(s.payout)}
      </p>
      <span className="badge" style={{ alignSelf: 'flex-start' }}>
        <i className="ic ic-clock" aria-hidden="true" />
        이의 기한 10/28(수) · 2영업일 남음
      </span>
      <fieldset className="col" style={{ gap: 8 }} role="radiogroup" aria-labelledby={`${id}-code-l`}>
        <legend className="label" id={`${id}-code-l`} style={{ marginBottom: 8 }}>
          이의 사유 (필수)
        </legend>
        {DISPUTE_CODES.map((c) => (
          <label key={c.code} className="check-row" style={{ alignItems: 'flex-start' }}>
            <input className="rd" type="radio" name={`${id}-code`} value={c.code} />
            <span className="col" style={{ gap: 2 }}>
              <span className="t-sm fw-b">{c.label}</span>
              <span className="t-xs muted">{c.help}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="field">
        <label className="label" htmlFor={`${id}-detail`}>
          설명 <span className="opt">(그 밖의 사유면 필수)</span>
        </label>
        <CountedTextarea id={`${id}-detail`} hintId={`${id}-h`} max={2000} />
      </div>
      <p className="t-sm muted">보내면 이 정산서만 지급을 멈추고 PEAKET이 확인합니다. 3영업일 안에 진행 상황을, 10영업일 안에 결과를 알립니다.</p>
      <div className={SHEET_ACTIONS}>
        <button className="btn btn-ghost" type="button" data-modal-close="">
          닫기
        </button>
        <button className={`btn btn-primary ${SHEET_PRIMARY}`} type="button">
          이의 보내기
        </button>
      </div>
    </Modal>
  );
}

export function SettleTab({ v, isMember, rounds }: { v: SettleVariant; isMember: boolean; rounds: readonly string[] }) {
  const round = rounds[0] ?? '';
  const ctx: Ctx = { v, isMember, round };
  const stats = [
    { label: '판매 대금', value: settleTotals.sales, meta: '승인된 결제 금액 합' },
    { label: '환급', value: settleTotals.refund, meta: '취소·환불 합' },
    { label: '중개수수료와 부가세', value: settleTotals.fee, meta: '수수료율 10%(예시)' },
    { label: '미수금 상계', value: settleTotals.offset, meta: '배상 선지급분' },
  ];
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between lg:flex-wrap">
        <RoundSelect id="st-round" rounds={rounds} />
        <div className="flex flex-col gap-2 md:items-end md:gap-1.5 lg:flex-row lg:flex-wrap lg:items-center lg:gap-3">
          <span className="t-xs muted">계산 10/26(월) 06:00 KST · 같은 날 통지</span>
          <DownloadMenu label="정산서 내려받기 · CSV·XLSX·PDF" menuLabel="정산서 파일 형식" />
        </div>
      </div>

      {v !== 'KYC 예고' && (
        <div className="banner banner-warning" role="status">
          <i className="ic ic-alert" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">토스페이먼츠 고객확인(KYC)이 필요합니다</span>
            결제사가 등록 이메일로 보낸 고객확인 신청서를 PC에서 열어 제출해 주세요. 서류가 갖춰지면 결제사는 2영업일 안에 심사를 마친다고 안내합니다. 승인될 때까지
            토스페이먼츠 결제분 지급을 보류하고, 승인되면 다음 지급일에 보냅니다. 포트원 결제분은 그대로 지급합니다. 이메일을 받지 못했으면 PEAKET 파트너센터에 알려 주세요.
          </div>
        </div>
      )}
      {v === '재통지(조정)' && (
        <div className="banner banner-info" role="status">
          <i className="ic ic-receipt" aria-hidden="true" />
          <div className="banner-body">이의를 반영해 조정한 정산서를 다시 알렸습니다. 이의 기간은 1영업일입니다</div>
        </div>
      )}
      {v === '재통지(기각)' && (
        <div className="banner banner-warning" role="status">
          <i className="ic ic-alert" aria-hidden="true" />
          {/* 기각 사유는 운영자가 적은 글을 그대로 보인다(d5 §6.10). 그림 시안처럼 자리 표시로 둔다 */}
          <div className="banner-body">이의를 받아들이지 않았습니다: [기각 사유]. 이의 기간은 1영업일입니다</div>
        </div>
      )}
      {v === 'KYC 예고' && (
        <div className="banner banner-info" role="status">
          <i className="ic ic-info" aria-hidden="true" />
          <div className="banner-body">
            이번 지급으로 토스페이먼츠 결제분 지급이 7일 동안 1천만 원 이상이 될 수 있어, 결제사가 고객확인(KYC)을 요청할 수 있습니다. 결제사가 셀러 등록 이메일로
            고객확인 신청서를 보내면 PC에서 바로 제출해 주세요(서류는 최근 3개월 안에 발급한 것). 고객확인은 미리 받을 수 없고, 요청이 오면 승인될 때까지 토스페이먼츠
            결제분 지급이 보류됩니다.
          </div>
        </div>
      )}

      <div className="col" style={{ gap: 8 }}>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5" role="group" aria-label={`${round} 회차 정산 요약, 결제사 2곳 합계`}>
          {stats.map((s) => (
            <div key={s.label} className="stat">
              <span className="stat-label">{s.label}</span>
              <span className="t-md fw-b num md:text-[20px] md:leading-[27px]">{formatWon(s.value)}</span>
              <span className="stat-meta">{s.meta}</span>
            </div>
          ))}
          <div className="stat card is-selected col-span-2 lg:col-span-1">
            <span className="stat-label">지급액</span>
            <span className="t-xl num lg:text-[20px] lg:leading-[27px]">{formatWon(settleTotals.payout)}</span>
            <span className="stat-meta">결제사 2곳 합계</span>
          </div>
        </div>
        <p className="t-xs muted">
          지급액 = 판매 대금 − 환급 − 중개수수료와 부가세 − 미수금 상계. 공제한 취소 수수료는 판매 대금에 남고, 결제사 수수료는 PEAKET이 부담합니다.
        </p>
      </div>

      <section className="col" style={{ gap: 10 }} aria-labelledby="ps-h">
        <div className="flex flex-col gap-0.5 md:flex-row md:flex-wrap md:items-center md:justify-between md:gap-x-3 md:gap-y-1">
          <h3 className="t-md fw-b" id="ps-h">
            결제사별 정산서
          </h3>
          <span className="t-xs muted">회차가 끝난 다음 영업일에 계산 · 통지 뒤 2영업일 안에 이의를 낼 수 있습니다</span>
        </div>
        <DesktopTable ctx={ctx} />
        <TabletTable ctx={ctx} />
        <MobileCards ctx={ctx} />
      </section>

      <div className="grid gap-4 lg:grid-cols-12 lg:gap-x-6" style={{ alignItems: 'start' }}>
        <section className="card-flat pad col lg:col-span-7" style={{ gap: 12 }} aria-labelledby="pay-h">
          <h3 className="t-sm fw-b" id="pay-h">
            지급이 멈추거나 늦어질 때
          </h3>
          <dl className="col gap-3.5 md:gap-2.5">
            {PAYOUT_HOLDS.map((h) => (
              <div key={h.label} className="flex flex-col gap-1 md:flex-row md:items-start md:gap-3">
                <dt className="md:w-[92px] md:flex-none">
                  <span className={h.badge}>{h.label}</span>
                </dt>
                <dd className="t-sm">{h.text}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="card col p-4 md:p-6 lg:col-span-5" style={{ gap: 12 }} aria-labelledby="cp-h">
          <div className="col" style={{ gap: 2 }}>
            <h3 className="t-md fw-b" id="cp-h">
              상계한 배상
            </h3>
            <span className="t-xs muted">같은 공연의 회차 연기 배상 · 대상 수와 합계만 보입니다</span>
          </div>
          <div className="row" style={{ gap: 32 }}>
            <div className="col" style={{ gap: 2 }}>
              <span className="t-xs muted">대상</span>
              <span className="t-lg num">312명</span>
            </div>
            <div className="col" style={{ gap: 2 }}>
              <span className="t-xs muted">합계</span>
              <span className="t-lg num">{formatWon(4_804_800)}</span>
            </div>
          </div>
          <p className="t-sm muted">주최 측 귀책 판정에 따라 실제 결제 금액의 10%를 PEAKET이 먼저 지급하고 미수금으로 잡았습니다. 아래 순서로 돌려받습니다.</p>
          <div className="stepper max-md:gap-1.5 md:max-lg:max-w-[480px]" role="group" aria-label="미수금 회수 단계">
            <span className="step is-current" aria-current="step">
              <span className="step-num">1</span>정산금 상계
            </span>
            <span className="step-line" />
            <span className="step">
              <span className="step-num">2</span>계약 보증
            </span>
            <span className="step-line" />
            <span className="step">
              <span className="step-num">3</span>청구
            </span>
          </div>
          <p className="t-xs muted">지금 단계: 이 회차 토스페이먼츠 정산서에서 {formatWon(4_804_800)} 상계</p>
        </section>
      </div>

      {!isMember
        ? statements.map((s) => <DisputeDialog key={s.key} s={s} round={round} open={v === '이의 제기 대화상자' && s.key === 'toss'} />)
        : null}
    </div>
  );
}
