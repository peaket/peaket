// 본문 글꼴: Pretendard Variable(OFL-1.1)을 직접 호스팅한다(d2 §1 타이포). 변수 --font-pretendard를 <html>에 단다.
import localFont from 'next/font/local';

export const pretendard = localFont({
  src: '../../node_modules/pretendard/dist/web/variable/woff2/PretendardVariable.woff2',
  variable: '--font-pretendard',
  weight: '45 920',
  display: 'swap',
  preload: true,
});
