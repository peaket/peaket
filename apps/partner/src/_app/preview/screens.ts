// 화면 목록(/preview)에 올리는 파트너 콘솔 화면 전부. 등록은 screens.a.ts(골격 담당)·screens.b.ts(다음 담당)에 한다.
import type { PreviewScreen } from '@peaket/ds/Preview';
import { screensA } from './screens.a';
import { screensB } from './screens.b';

export const screens: readonly PreviewScreen[] = [...screensA, ...screensB];
