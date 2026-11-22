// 파트너 콘솔의 좁은 기본 Trusted Types 정책(ADR-0360 결정 7, docs/frontend.md §5.14.1 'Trusted Types'). 화면 스크립트보다 먼저 싣는다.
// Next.js(Turbopack)의 덩어리 적재기가 정책 없이 script.src에 주소 글을 넣는다. 그 주소가 같은 출처 /_next/static/ 아래 .js일 때만 통과시킨다.
// 목록 밖 주소와 createHTML·createScript(정의하지 않음)는 기본 정책을 통과하지 못한다: HTML 해석과 문자열 스크립트는 기본 정책으로 통과하지 못한다(ADR-0204가 버린 넓은 default와 다르다).
(function () {
  var tt = window.trustedTypes;
  if (!tt || tt.defaultPolicy) return;
  var origin = location.origin;
  tt.createPolicy('default', {
    createScriptURL: function (input) {
      var u = new URL(input, origin);
      if (u.origin === origin && u.pathname.indexOf('/_next/static/') === 0 && /\.js$/.test(u.pathname)) return input;
      // 목록 밖 주소는 값을 주지 않는다(위반으로 보고되고, 막는 모드에서는 막힌다. 던지지 않아 보고 모드의 적재를 깨지 않는다)
      return null;
    },
  });
})();
