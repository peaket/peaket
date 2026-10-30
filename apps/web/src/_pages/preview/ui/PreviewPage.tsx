// 소비자 웹 화면 목록(/preview, 개발 서버에서만. 운영 빌드에서는 404, add-screen-publishing design.md 결정 7).
// 등록은 src/shared/config/screens.<담당>.ts에 한다. 운영 빌드에서는 조건이 글자 비교(false)로 바뀌고 목록은 그 안에서만 늦게 불러온다.
import { notFound } from 'next/navigation';
import { PreviewCatalog } from '@peaket/ds/Preview';
import { renderNextLink } from '@/shared/lib/next-link';

export async function PreviewPage() {
  if (process.env.NODE_ENV !== 'production') {
    const { OTHER_APP_PREVIEWS, WEB_SCREENS } = await import('@/shared/config/screens');
    return <PreviewCatalog appName="소비자 웹" screens={WEB_SCREENS} otherApps={OTHER_APP_PREVIEWS} renderLink={renderNextLink} />;
  }
  notFound();
}
