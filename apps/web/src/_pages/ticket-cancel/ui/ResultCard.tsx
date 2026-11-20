'use client';
// SCR-038 ⑥ 202 결과 카드(d5 §5.20). 취소 POST가 끝난 뒤에만 그리므로 첫 묶음에서 빼고 늦게 싣는다(frontend §5.8).
// `pending-account`에만 SCR-060 안내 문구를 둔다(SCR-060 실제 연결은 BAT-422 후보).
import Link from 'next/link';
import { NoticeBanner } from '@peaket/ds/NoticeBanner';
import type { ResultView } from '../model/view';

const won = (n: number) => `₩${new Intl.NumberFormat('ko-KR').format(n)}`;

export function ResultCard({ result, accountUsed }: { result: ResultView; accountUsed: boolean }) {
  const meta =
    result.kind === 'refunded'
      ? { badge: '환급 완료', tone: 'badge-success', title: '환급을 마쳤습니다' }
      : result.kind === 'deferred'
        ? { badge: '환급 보류', tone: 'badge-warning', title: '입장 기록 마감 뒤 환급합니다' }
        : result.kind === 'pending-account'
          ? { badge: '환급 대기', tone: 'badge-warning', title: '환불받을 계좌가 필요합니다' }
          : { badge: '환급 지연', tone: 'badge-warning', title: '환급이 지연되고 있습니다' };
  return (
    <section className="card col gap-3.5 p-4 md:px-5 md:py-[18px]" aria-labelledby="h-result">
      <div className="row between gap-2">
        <h2 className="t-md fw-b lg:text-lg" id="h-result">
          취소 결과
        </h2>
        <span className={`badge ${meta.tone}`}>{meta.badge}</span>
      </div>
      <p className="t-sm">{meta.title}</p>
      <dl className="kv">
        <dt>환급액</dt>
        <dd className="num">{won(result.refundAmount)}</dd>
        <dt>환급 수단</dt>
        <dd>{accountUsed ? '입력한 환불 계좌' : '원결제 수단'}</dd>
      </dl>
      {result.kind === 'pending-account' ? (
        <NoticeBanner tone="info" role={null}>
          환급할 때 알림으로 계좌를 다시 받습니다. 알림을 받으면 환불 계좌를 입력해 주세요
        </NoticeBanner>
      ) : null}
      {result.kind === 'pending' ? (
        <NoticeBanner tone="warning" role="status">
          결제사 응답이 늦어 환급 요청을 자동으로 다시 보내고 있습니다. 따로 하실 일은 없습니다
        </NoticeBanner>
      ) : null}
      {result.kind === 'deferred' ? (
        <NoticeBanner tone="info" role={null}>
          입장 기록 마감 뒤 입장하지 않은 것이 확인되면 환급합니다
        </NoticeBanner>
      ) : null}
      <Link className="link-more" href="/my/tickets">
        예매·주문 내역에서 진행 상태 보기
        <i className="ic ic-chevron-right" aria-hidden="true" />
      </Link>
    </section>
  );
}
