// 화면 목록(/preview, 개발 서버에서만). 운영 빌드에서는 404(add-screen-publishing design.md 결정 7).
// 운영 빌드에서는 조건이 글자 비교(false)로 바뀌고 목록은 그 안에서만 늦게 불러와, 목록과 개발 주소가 운영 묶음에 들지 않는다.
import { notFound } from 'next/navigation';
import { PreviewCatalog } from '@peaket/ds/Preview';
import { renderNextLink } from '@/shared/ui/link';

export default async function PreviewPage() {
  if (process.env.NODE_ENV !== 'production') {
    const { screens } = await import('./screens');
    // 다른 앱 개발 서버 주소(common 규칙 '이동 링크': 웹 3000 · 관제 3002 · 스캐너 3003 · 대기실 3004 · 포렌식 3005)
    const dev = (port: number, path: string) => `http://localhost:${port}${path}`;
    const otherApps = [
      { name: '소비자 웹', href: dev(3000, '/preview') },
      { name: '관제 콘솔', href: dev(3002, '/preview') },
      { name: '스캐너', href: dev(3003, '/preview') },
      { name: '대기실', href: dev(3004, '/preview') },
      { name: '포렌식 데모', href: dev(3005, '/') },
    ];
    return (
      <div className="pk" style={{ minHeight: '100dvh' }}>
        <PreviewCatalog appName="파트너 콘솔" screens={screens} renderLink={renderNextLink} otherApps={otherApps} />
      </div>
    );
  }
  notFound();
}
