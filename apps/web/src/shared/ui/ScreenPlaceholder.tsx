// 아직 퍼블리싱하지 않은 화면의 본문 자리(셸 안에 넣는다). 화면 이름 <h1>과 "퍼블리싱 예정 · SCR-0NN" 한 줄.
// 셸까지 함께 쓰려면 widgets/app-shell의 PlaceholderScreen을 쓴다. 각 담당이 자기 _pages 폴더의 페이지로 바꾼다.
import Link from 'next/link';

export interface ScreenPlaceholderProps {
  /** 'SCR-003' */
  scr: string;
  /** 화면 이름(d5 §2 인벤토리) */
  name: string;
  /** 덧붙일 한 줄(경로 설명 등) */
  note?: string;
}

export function ScreenPlaceholder({ scr, name, note }: ScreenPlaceholderProps) {
  return (
    <main className="page-main" id="main" tabIndex={-1}>
      <div className="state mx-auto w-full max-w-[640px] py-20 md:py-28">
        <span className="state-icon">
          <i className="ic ic-doc" aria-hidden="true" />
        </span>
        <h1 className="t-xl">{name}</h1>
        <p className="t-md muted">
          퍼블리싱 예정 · <span className="num">{scr}</span>
        </p>
        {note ? <p className="t-sm muted">{note}</p> : null}
        {process.env.NODE_ENV !== 'production' ? (
          <Link className="link-more" href="/preview">
            화면 목록<i className="ic ic-chevron-right" aria-hidden="true" />
          </Link>
        ) : null}
      </div>
    </main>
  );
}
