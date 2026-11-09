export { CachedRootLayout as default, rootMetadata as metadata, rootViewport as viewport } from '@/_app';

// 퍼블리싱 화면은 주소 값(?state=·목업 경로 값)을 읽어 요청 때 그린다. 요청 값을 읽지 않는 화면은 그대로 빌드 때 그린다(docs/frontend.md §2.5).
// 데이터를 잇는 단계(HOT-300 등)가 이 묶음 화면을 요청 값 없이 그리게 바꾸면 빌드 때 그려진다
export const instant = false;
