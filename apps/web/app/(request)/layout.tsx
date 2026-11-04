export { RequestRootLayout as default, rootMetadata as metadata, rootViewport as viewport } from '@/_app';

// 이 묶음은 정적 셸 없이 요청 때 그린다(루트 레이아웃이 요청 nonce를 읽는다, docs/frontend.md §2.5, FE-T35)
export const instant = false;
