// 아직 퍼블리싱하지 않은 화면의 자리 표시(셸 안 본문). 다음 담당이 src/_pages/<화면 폴더>/만 바꿔 채운다.
import type { ReactNode } from 'react';

export interface PlaceholderProps {
  /** 'SCR-024' */
  scr: string;
  title: string;
  /** 공연 문맥 머리 등 위에 둘 것 */
  head?: ReactNode;
}

export function Placeholder({ scr, title, head }: PlaceholderProps) {
  return (
    <>
      {head ?? (
        <div className="page-head">
          <h1>{title}</h1>
        </div>
      )}
      <section className="card" aria-label={`${title} 자리 표시`}>
        <div className="state" style={{ padding: '56px 24px' }}>
          <span className="state-icon">
            <i className="ic ic-doc" aria-hidden="true" />
          </span>
          <p className="t-md fw-b">{head ? title : '이 화면은 아직 그리지 않았습니다'}</p>
          <p className="t-sm muted">퍼블리싱 예정 · {scr}</p>
        </div>
      </section>
    </>
  );
}
