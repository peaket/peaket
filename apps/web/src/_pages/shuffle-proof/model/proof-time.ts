// 추첨 검증 화면(SCR-019)만 쓰는 초 단위 시각 글. 공용 시각 모듈(shared/lib/kst)에 두면 홈 첫 JS까지 늘어 여기에 둔다.
import { dateTimeText, timeText } from '@/shared/lib/kst';

/** 한국 시각은 UTC와 시간 단위로만 달라 초는 그대로다 */
const seconds = (ms: number): string => String(new Date(ms).getUTCSeconds()).padStart(2, '0');

/** '19:50:03'(짧은 구간을 보이는 곳) */
export const timeSecText = (ms: number): string => `${timeText(ms)}:${seconds(ms)}`;

/** '11/20(금) 20:00:03' */
export const dateTimeSecText = (ms: number): string => `${dateTimeText(ms)}:${seconds(ms)}`;
