// 구매 조건 알림의 표시 부품. 문구는 서버가 로케일 파일에서 읽어 넘긴다(클라이언트 번들에 네 언어를 넣지 않는다).
// 화면 뼈대는 아직 한국어이므로 번역문에만 lang을 달아 낭독기가 번역문을 한국어로 읽지 않게 한다(WCAG 3.1.2).
import type { Locale } from './catalog';
import { cx } from '../lib/cx';

export function DomesticPhoneNotice({ text, lang, className }: { text?: string; lang?: Locale; className?: string }) {
  if (!text) return null;
  return (
    <p className={cx('t-sm muted', className)} role="note" lang={lang}>
      {text}
    </p>
  );
}
