// 아직 퍼블리싱하지 않은 관제 화면의 자리 표시. 다음 담당이 src/pages/<화면 폴더>/ 안만 바꾼다.
import { useDocumentTitle } from '@/shared/lib/title';

export function PlaceholderPage({ scr, title, path, section }: { scr: string; title: string; path: string; section: string }) {
  useDocumentTitle(title);
  return (
    <>
      <div className="page-head">
        <div className="col" style={{ gap: 4 }}>
          <h1 tabIndex={-1}>{title}</h1>
          <p className="t-sm muted">
            {scr} · <code>{path}</code>
          </p>
        </div>
      </div>
      <section className="card pad-lg col" style={{ gap: 8 }} aria-labelledby="ph-t">
        <h2 className="t-md fw-b" id="ph-t">
          퍼블리싱 예정 화면
        </h2>
        <p className="t-sm muted">
          이 화면은 다음 퍼블리싱 차례에 디자인 캔버스 보드({scr}-d·t·m)를 옮겨 채웁니다. 정본은 docs/design/d5 {section}입니다.
        </p>
      </section>
    </>
  );
}
