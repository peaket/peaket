// SCR-011 주문·결제의 본문(d5 §5.11). 실제 화면(CheckoutLive)과 개발 서버 미리보기(CheckoutPreview)가 함께 쓴다.
// 휴대폰: ① 좌석과 금액 → ② 예매자 → ③ 판매자에게 개인정보 제공 동의 → ④ 판매 조건·취소 규정 동의 → ⑤⑥ 결제수단 → ⑧ 판매자 정보 → ⑨ 미성년자 고지.
// 데스크톱(lg): 왼쪽 8열 본문, 오른쪽 4열 고정 주문 요약.
import Link from 'next/link';
import type { ReactNode } from 'react';
import { CANCEL_FEE_ROWS, thirdPartyRows } from '@/entities/payment';
import { formatWon, type SortMode } from '@/entities/production';
import type { GradeLine } from '../model/order';
import { brokerNotice, MINOR_NOTICE, SORT_NOTICE } from '../model/view';
import { ConsentCheck } from './CheckoutClient';

export interface SellerView {
  name: string;
  representative: string;
  address: string;
  phone: string;
  email: string;
  businessNo: string;
  mailOrderNo: string;
}

export interface CheckoutFormData {
  title: string;
  /** 회차·장소 한 줄 */
  line: string;
  seatText: string;
  grades: GradeLine[];
  totalText: string;
  sellerName: string;
  seller: SellerView;
  sortMode: SortMode;
  perPerson: number;
}

interface FormProps {
  data: CheckoutFormData;
  /** 데스크톱 오른쪽 결제 버튼 */
  payPanel: ReactNode;
  /** 제목 아래 안내(오류 요약·배너) */
  top?: ReactNode;
  /** ② 예매자 입력 두 칸 */
  buyer: ReactNode;
  /** ④ 위 부정 예매 조사 안내(ADR-0173 결정 3) */
  lockNote?: ReactNode;
  /** ⑤⑥ 결제수단 */
  payment: ReactNode;
}

export function CheckoutForm({ data, payPanel, top, buyer, lockNote, payment }: FormProps) {
  const { seller, sellerName, grades, seatText, totalText } = data;
  const sort = SORT_NOTICE[data.sortMode];
  return (
    <div className="w-full px-4 pt-5 pb-8 md:px-6 md:pt-6 md:pb-10 lg:px-8 lg:pt-8 lg:pb-12">
      <div className="mx-auto w-full max-w-[600px] lg:grid lg:max-w-[976px] lg:grid-cols-12 lg:items-start lg:gap-x-6">
        <div className="col min-w-0 gap-6 md:gap-7 lg:col-span-8">
          <h1 className="t-xl">주문·결제</h1>

          {top}

          {/* ① 좌석과 금액(휴대폰·태블릿. 데스크톱은 오른쪽 패널) */}
          <section className="card pad col md:p-6 lg:hidden" style={{ gap: 12 }} aria-labelledby="co-sum-h">
            <div className="row between">
              <h2 className="t-md fw-b" id="co-sum-h">
                좌석과 금액
              </h2>
              <span className="badge badge-primary">홀드 중</span>
            </div>
            <p className="t-lg">{seatText}</p>
            <dl className="kv">
              {grades.map((l) => (
                <div key={`${l.grade}|${l.price}`} className="contents">
                  <dt>
                    {l.grade} {l.quantity}매
                  </dt>
                  <dd className="num">
                    {formatWon(l.price)} × {l.quantity}
                  </dd>
                </div>
              ))}
              <dt className="kv-total">합계</dt>
              <dd className="kv-total num">{totalText}</dd>
            </dl>
          </section>

          {/* ② 예매자(저장된 정보 자동 입력. 이메일 칸은 없다, ADR-0044 결정 10) */}
          <fieldset className="col gap-4 md:gap-3">
            <legend className="t-lg" style={{ marginBottom: 12 }}>
              예매자
            </legend>
            <div className="col gap-4 md:grid md:grid-cols-2 md:items-start">{buyer}</div>
          </fieldset>

          {/* ③ 판매자에게 개인정보 제공(받는 자·목적·보유 기간 굵게) */}
          <section className="card pad col md:p-6" style={{ gap: 14 }} aria-labelledby="co-3p-h">
            <h2 className="t-lg" id="co-3p-h">
              판매자에게 개인정보 제공
            </h2>
            <dl className="col gap-2 md:gap-2.5 lg:grid lg:grid-cols-2 lg:gap-x-6 lg:gap-y-3">
              {thirdPartyRows(sellerName).map((r) => (
                <div key={r.term} className="col" style={{ gap: 2 }}>
                  <dt className="t-xs fw-b muted">{r.term}</dt>
                  <dd className={r.bold ? 't-sm fw-b' : 't-sm'}>{r.value}</dd>
                </div>
              ))}
            </dl>
            <div className="divider" />
            <ConsentCheck id="co-agree1" which="thirdParty">
              위 내용에 동의합니다 (필수)
            </ConsentCheck>
          </section>

          {/* ④ 위: 부정 예매 조사로 이 회차 양도가 잠긴 계정에 결제 전 안내(d5 §5.11, 약관법 제3조 제3항 설명의무, 추천 적용 2026-10-31, ADR-0173 결정 3).
              잠긴 동안 새로 산 표도 발권 때 잠긴다. 결제 버튼은 그대로다 */}
          {lockNote}

          {/* ④ 판매 조건과 취소 규정(정렬 방식 세 번째 고지 자리, 취소 수수료 재고지) */}
          <section className="col" style={{ gap: 12 }} aria-labelledby="co-terms-h">
            <h2 className="t-lg" id="co-terms-h">
              판매 조건과 취소 규정
            </h2>
            <div className="banner banner-info">
              <i className="ic ic-info" aria-hidden="true" />
              <div className="banner-body">
                <span className="banner-title">{sort.title}</span>
                {sort.body}
              </div>
            </div>
            <div className="banner banner-info">
              <i className="ic ic-receipt" aria-hidden="true" />
              <div className="banner-body col min-w-0" style={{ gap: 10 }}>
                <span className="banner-title">공연일 10일 이내 취소 시 기준에 따른 공제 후 환불</span>
                <CancelFeeTable />
                <span className="t-xs muted">
                  <span className="hidden lg:inline">관람일 기준이고, 당일 취소는 공연 시작 전까지 받습니다. </span>
                  예매 후 24시간 안 취소는 관람일 3일 전까지만 해당하고, 주말·공휴일은 24시간 계산에서 뺍니다. 근거: 소비자분쟁해결기준
                </span>
                {/* 추천안: 취소 규정 전문은 이용약관(SCR-057)의 취소·환불 조항으로 잇는다 */}
                <Link className="link-more" href="/policy/terms">
                  취소 규정 자세히 보기
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </Link>
              </div>
            </div>
            <p className="t-sm">
              이 공연의 판매 조건: <span className="fw-b">1인 1순번</span> · <span className="fw-b">1인 {data.perPerson}매</span>
            </p>
            <ConsentCheck id="co-agree2" which="terms">
              판매 조건(정렬 방식·1인 1순번·매수 한도·취소 규정)에 동의합니다 (필수)
            </ConsentCheck>
          </section>

          {/* ⑤⑥ 결제수단 · 결제 프레임(CMP-027) */}
          {payment}

          {/* ⑧ 판매자 정보(POL-037 고지 + 신원정보 7항목, 접지 않고 늘 보인다) · ⑨ 미성년자 계약 취소 고지 */}
          <section className="col" style={{ gap: 12 }} aria-labelledby="co-seller-h">
            <h2 className="t-lg" id="co-seller-h">
              판매자 정보
            </h2>
            <div className="banner banner-legal">
              <i className="ic ic-scale" aria-hidden="true" />
              <div className="banner-body t-md">
                <span className="legal-tag">법정 고지</span>
                {brokerNotice(sellerName)}
              </div>
            </div>
            <div className="card-flat" style={{ padding: '14px 16px' }}>
              <dl className="kv" style={{ gap: '6px 12px', fontSize: 13, lineHeight: '18px' }}>
                <dt>상호</dt>
                <dd>{seller.name}</dd>
                <dt>대표자</dt>
                <dd>{seller.representative}</dd>
                <dt>주소</dt>
                <dd>{seller.address}</dd>
                <dt>전화</dt>
                <dd>{seller.phone}</dd>
                <dt>전자우편</dt>
                <dd>{seller.email}</dd>
                <dt>사업자등록번호</dt>
                <dd>{seller.businessNo}</dd>
                <dt>통신판매업 신고번호</dt>
                <dd>{seller.mailOrderNo}</dd>
              </dl>
            </div>
            <p className="t-md">
              {MINOR_NOTICE}{' '}
              <Link className="link-more" href="/help">
                미성년자 계약 취소 안내
                <i className="ic ic-chevron-right" aria-hidden="true" />
              </Link>
            </p>
          </section>
        </div>

        {/* 데스크톱 오른쪽 고정 주문 요약(①⑦ + 결제 버튼) */}
        <aside className="hidden lg:sticky lg:top-6 lg:col-span-4 lg:block" aria-label="주문 요약">
          <section className="card pad-lg col" style={{ gap: 14 }} aria-labelledby="co-sum-h2">
            <div className="row between">
              <h2 className="t-md fw-b" id="co-sum-h2">
                좌석과 금액
              </h2>
              <span className="badge badge-primary">홀드 중</span>
            </div>
            <p className="t-sm muted">
              {data.title} · {data.line}
            </p>
            <p className="t-lg">{seatText}</p>
            <dl className="kv">
              <dt className="kv-total">합계</dt>
              <dd className="kv-total num">{totalText}</dd>
            </dl>
            <div className="divider" />
            {payPanel}
          </section>
        </aside>
      </div>
    </div>
  );
}

/** 취소 시점별 공제율 표: 휴대폰·태블릿은 세로(시점·공제 두 열), 데스크톱은 가로 한 줄 */
function CancelFeeTable() {
  return (
    <>
      <div className="table-wrap lg:hidden">
        <table className="table dense">
          <caption className="sr-only">취소 시점별 공제율</caption>
          <thead>
            <tr>
              <th scope="col">취소 시점</th>
              <th className="r" scope="col">
                공제
              </th>
            </tr>
          </thead>
          <tbody>
            {CANCEL_FEE_ROWS.map((r) => (
              <tr key={r.when}>
                <td>{r.when}</td>
                <td className="r">{r.fee}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-wrap relative hidden lg:block">
        <table className="table dense">
          <caption className="sr-only">취소 시점별 공제율(관람일 기준)</caption>
          <thead>
            <tr>
              <th scope="col">취소 시점</th>
              {CANCEL_FEE_ROWS.map((r) => (
                <th key={r.short} scope="col">
                  {r.short}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">공제</th>
              {CANCEL_FEE_ROWS.map((r) => (
                <td key={r.short} className={r.fee === '없음' ? undefined : 'num'}>
                  {r.fee}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
