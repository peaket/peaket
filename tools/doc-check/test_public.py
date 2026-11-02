"""문서 점검 도구 `public` 검사의 공인 대역 시험(ADR-0153, docs/devops.md §2.1, BUILD_ORDER BSL-060).

공개 문서에 실제 운영 망 주소를 적지 않게 하되, 사설·공유·링크 로컬·루프백·문서용(RFC 5737)과 성능 측정용(RFC 2544,
198.18.0.0/15) 대역은 적을 수 있다. 측정용 대역은 부하 시험의 가상 사용자 IP다(docs/verification.md §3.9 '신원').
실행: python -I -m unittest discover -s tools/doc-check -p "test_*.py"
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check_all as dc  # noqa: E402


def errors(line):
    rep = dc.Report()
    dc.check_public({'docs/x.md': line}, rep)
    return [e['msg'] for e in rep.errors if e['check'] == 'public']


class 공인대역(unittest.TestCase):
    def test_NFR013_측정용대역_198_18_0_0_15와_그안의_대역은_적을수있다(self):
        for line in ('가상 사용자 IP는 198.18.0.0/15에서 붙인다', '198.19.0.0/16', '198.18.1.0/24'):
            self.assertEqual([], errors(line), line)

    def test_NFR013_측정용대역을_넘는_대역과_실제공인대역은_오류다(self):
        for line in ('198.18.0.0/14', '198.20.0.0/16', '8.8.8.0/24', '52.95.0.0/16'):
            self.assertEqual(1, len(errors(line)), line)

    def test_NFR013_사설·문서용대역은_그대로_통과한다(self):
        for line in ('10.0.0.0/8', '192.168.1.0/24', '100.64.0.0/10', '203.0.113.0/24', '0.0.0.0/0'):
            self.assertEqual([], errors(line), line)


if __name__ == '__main__':
    unittest.main()
