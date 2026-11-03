// SCR-015 굿즈 스토어(d5 §5.15, d3 SCR-015 행, 캔버스 보드 SCR-015-m·t·d의 카탈로그를 한 페이지 반응형으로 합쳤다).
// 휴대폰: 제목 줄(장바구니 아이콘 링크) → 칩 → 안내 배너 → 2열 카드. 태블릿(md): 3열, 장바구니 글자 버튼 링크.
// 데스크톱(lg): 폭 1280 안 4열, 장바구니 버튼은 오른쪽 드로어를 연다. 셸 바닥글이 통신판매중개자 고지와 구매안전서비스 줄을 싣는다.
// 상태: 보드 state 열거값 그대로(옵션 고르기·장바구니 드로어는 열린 채로, 담음·품절·한도 초과는 토스트를 띄운 채로 그린다).
// '로딩'은 보드에 없고 d5 상태 표 '로딩·빈 화면'에서 더했다(상품 목록 스켈레톤).
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { Skeleton, SkeletonGroup } from '@peaket/ds/Skeleton';
import { PRODUCTS } from '@/entities/product';
import { TICKETS } from '@/entities/ticket';
import { SCR015_SHOP_STATES, type Scr015ShopState } from '@/shared/config/screens.booking';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { ShopCatalog, type ShopCatalogProps } from './ShopCatalog';

/** 티켓을 가진 것으로 보는 상태(취소 접수·공연 취소·지난 공연은 뺀다) */
const GONE = new Set(['취소 접수', '공연 취소됨', '지난 공연']);
const OWNED = TICKETS.filter((t) => !GONE.has(t.status)).map((t) => t.performanceId);

const WRAP = 'mx-auto col w-full max-w-[1280px] gap-4 px-4 pt-5 pb-10 md:px-6 md:pt-6 md:pb-12 lg:gap-6 lg:px-8 lg:pt-8 lg:pb-16';

function previewProps(state: Scr015ShopState): Partial<ShopCatalogProps> {
  switch (state) {
    case '옵션 고르기':
      return { initialSheetProductId: 'gds-lumen-tee' };
    case '장바구니 드로어':
      return { initialDrawer: true };
    case '장바구니에 담음':
      return { initialToast: { kind: 'added' } };
    case '품절':
      return { initialToast: { kind: 'soldout' } };
    case '한도 초과':
      return { initialToast: { kind: 'limit', limit: 2 } };
    default:
      return {};
  }
}

function TitleBlock() {
  return (
    <div className="col" style={{ gap: 4 }}>
      <h1 className="t-xl md:text-[32px] md:leading-[42px] md:tracking-[-0.01em]">굿즈 스토어</h1>
      <p className="t-sm muted lg:text-base lg:leading-[22px]">공식 굿즈와 티켓 연동 부가 상품</p>
    </div>
  );
}

export async function ShopPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR015_SHOP_STATES, '카탈로그');
  const dark = resolvePreviewTheme(sp) === 'dark';

  let body;
  if (state === '빈 화면') {
    body = (
      <>
        <TitleBlock />
        <div className="card-flat state px-5 py-12 md:px-6 md:py-16 lg:py-20">
          <span className="state-icon">
            <i className="ic ic-bag" aria-hidden="true" />
          </span>
          <h2 className="t-lg">판매 중인 상품이 없습니다</h2>
        </div>
      </>
    );
  } else if (state === '로딩') {
    body = (
      <>
        <TitleBlock />
        <SkeletonGroup label="상품 목록을 불러오는 중">
          <ul className="grid grid-cols-2 gap-x-3 gap-y-6 md:grid-cols-3 md:gap-x-4 md:gap-y-7 lg:grid-cols-4 lg:gap-x-6 lg:gap-y-8" aria-hidden="true">
            {Array.from({ length: 8 }, (_, i) => (
              <li key={i} className="col gap-2.5">
                <Skeleton style={{ aspectRatio: 1, width: '100%' }} radius="var(--r-lg)" />
                <Skeleton variant="text" width="80%" />
                <Skeleton variant="title" width="50%" />
                <Skeleton variant="text" width="65%" />
              </li>
            ))}
          </ul>
        </SkeletonGroup>
      </>
    );
  } else {
    body = <ShopCatalog products={PRODUCTS} ownedPerformanceIds={OWNED} {...previewProps(state)} />;
  }

  return (
    <AppShell dark={dark} current="shop">
      <main className="page-main" id="main" tabIndex={-1}>
        <div className={WRAP}>{body}</div>
      </main>
      <PreviewSwitcher path="/shop" states={SCR015_SHOP_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
    </AppShell>
  );
}
