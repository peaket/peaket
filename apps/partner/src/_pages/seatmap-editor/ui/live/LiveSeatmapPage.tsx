// 실제 좌석맵 에디터 화면(/events/{소문자 UUID}/seatmap, ?state= 없음, ADR-0264 결정 2). 서버 부품은 머리와 휴대폰 안내만 그린다.
// 휴대폰 폭에서 무엇을 싣는지는 LiveSeatmapEditor가 정한다(편집 화면 대신 미리보기와 요약 줄, 결정 39).
// 공연 문맥 머리의 공연 이름·상태 배지는 공연 개요 읽기(HOT-260)가 잇고, 그 전에는 '좌석맵 에디터'와 공연 ID 앞 8자만 보인다.
import Link from 'next/link';
import { routes } from '@/shared/config/routes';
import { LiveSeatmapEditor } from './LiveSeatmapEditor';

export function LiveSeatmapPage({ productionId }: { productionId: string }) {
  return (
    <>
      <div className="col" style={{ gap: 8 }}>
        <nav className="breadcrumb" aria-label="위치">
          <Link href={routes.events()}>공연 관리</Link>
          <i className="ic ic-chevron-right" aria-hidden="true" />
          <span>좌석맵 에디터</span>
        </nav>
        <div className="page-head">
          <h1>좌석맵 에디터</h1>
        </div>
        <p className="t-sm muted">{`공연 ${productionId.slice(0, 8)}`}</p>
      </div>
      <div className="md:hidden card pad col" style={{ gap: 6 }}>
        <p className="t-md fw-b">좌석맵 편집은 태블릿이나 데스크톱에서 합니다</p>
        <p className="t-sm muted">큰 화면에서 이 주소를 열어 주세요.</p>
      </div>
      <LiveSeatmapEditor productionId={productionId} />
    </>
  );
}
