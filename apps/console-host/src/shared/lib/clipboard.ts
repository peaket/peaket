/** 휴대폰 범위 밖 안내 카드의 [ 링크 복사 ](d5 §3.9): 같은 화면 주소를 복사해 큰 화면에서 연다 */
export function copyLink() {
  void navigator.clipboard?.writeText(window.location.href).catch(() => undefined);
}
