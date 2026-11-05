// 붙여넣은 HTML 거름(FE-T41, ADR-0204 결정 2): 해석 중 CSP 위반 보고가 나는 것(<style>·<script>·이벤트·style 속성·<img>)을 걷는다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { precleanPastedHtml } from './paste.ts';

test('스타일·스크립트·그림·주석·이벤트·style 속성을 걷고 글과 구조 꼬리표는 남긴다', () => {
  const html =
    '<html><head><meta charset="utf-8"><link rel="stylesheet" href="x.css"><style>p{color:red}</style></head><body><!--StartFragment-->' +
    '<h1 class="MsoTitle" style="color:#f00">제목</h1><p onclick="alert(1)" ONMOUSEOVER=\'x()\'>글<img src="https://evil.example/x.png" onerror="alert(1)"></p>' +
    '<script type="text/javascript">alert(1)</script><SCRIPT>alert(2)</SCRIPT><ul><li style=color:blue>항목</li></ul><!--EndFragment--></body></html>';
  const out = precleanPastedHtml(html);
  assert.doesNotMatch(out, /style|script|onclick|onmouseover|onerror|<img|<meta|<link|<!--|alert/i);
  assert.match(out, /<h1 class="MsoTitle">제목<\/h1><p>글<\/p><ul><li>항목<\/li><\/ul>/);
});

test('걷어 낸 자리에서 꼬리표가 되살아나지 않고, 꼬리표 밖 글자와 따옴표 안 값은 건드리지 않는다(새 맥락 리뷰 낮음 4)', () => {
  assert.doesNotMatch(precleanPastedHtml('<b o onclick="1"nclick="alert(1)">x</b>'), /onclick|alert/);
  assert.doesNotMatch(precleanPastedHtml('<scr<script></script>ipt>alert(1)</script>'), /<\/?script/i);
  assert.equal(precleanPastedHtml('<p>onion=3 style = bold</p>'), '<p>onion=3 style = bold</p>');
  assert.equal(precleanPastedHtml('<p title="a onclick=b" onclick="x">글</p>'), '<p title="a onclick=b">글</p>');
});
