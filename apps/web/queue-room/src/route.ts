// 셸 하나가 여러 경로를 그린다. 운영에서는 CloudFront Function이 경로를 셸로 바꿔 읽고, 회차·상품 ID는 이 스크립트가 주소에서 읽는다(§5.1).
import { DEFAULT_EVENT_ID } from './fixtures';

export type Route =
  | { kind: 'event'; id: string; locale: 'ko' | 'en' | 'ja' | 'zh' }
  | { kind: 'goods'; id: string };

const EVENT_PATH = /^\/(?:(en|ja|zh)\/)?queue\/([^/]+)\/?$/;
const GOODS_PATH = /^\/shop\/([^/]+)\/queue\/?$/;

function decode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

export function parseRoute(pathname: string): Route {
  const g = GOODS_PATH.exec(pathname);
  if (g) return { kind: 'goods', id: decode(g[1]!) };
  const e = EVENT_PATH.exec(pathname);
  if (e) return { kind: 'event', id: decode(e[2]!), locale: (e[1] as 'en' | 'ja' | 'zh' | undefined) ?? 'ko' };
  // 셸 파일을 바로 연 경우(/_q/shell.ko.html 등): 기본 목업 공연으로 그린다
  return { kind: 'event', id: DEFAULT_EVENT_ID, locale: 'ko' };
}
