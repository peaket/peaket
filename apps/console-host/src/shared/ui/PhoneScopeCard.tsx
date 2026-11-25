// 범위 밖 안내 카드(CMP-017 info, d5 §3.9). 휴대폰에서 못 하는 일의 자리에 단추 대신 둔다.
// 문구는 정본 그대로이고, [ 링크 복사 ]는 같은 화면 주소를 큰 화면에서 열 수 있게 복사한다.
import { PHONE_SCOPE_TEXT } from '@/shared/lib/layout';

export function PhoneScopeCard({ title = '큰 화면에서 하는 작업입니다' }: { title?: string }) {
  const copy = () => {
    const url = typeof window === 'undefined' ? '' : window.location.href;
    void navigator.clipboard?.writeText(url);
  };
  return (
    <section className="banner banner-info" role="note" data-phone-scope="true" aria-label="큰 화면에서 하는 작업">
      <span className="banner-title">{title}</span>
      <p className="t-sm" style={{ margin: '4px 0 8px' }}>
        {PHONE_SCOPE_TEXT}
      </p>
      <button className="btn btn-outline btn-sm" type="button" onClick={copy}>
        링크 복사
      </button>
    </section>
  );
}
