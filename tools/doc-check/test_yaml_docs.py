"""문서 점검 도구 `yaml` 검사의 여러 문서·Helm 틀 시험(BUILD_ORDER FND-110, openspec 변경 add-local-cluster-and-relay-deployment).

쿠버네티스 매니페스트는 한 파일에 `---`로 문서 여럿을 잇는다. 문서마다 따로 읽어야 apiVersion·kind가 '두 번'으로 잡히지 않는다.
Helm 차트의 templates/는 렌더하기 전에는 YAML이 아니라(Go 틀) 건너뛴다. 렌더 결과는 tools/local/chart.test.mjs가 본다.
실행: python -I -m unittest discover -s tools/doc-check -p "test_*.py"
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check_all as dc  # noqa: E402

TWO_DOCS = """\
# 설명 줄
apiVersion: v1
kind: Service
metadata:
  name: a
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: a
"""


def errors(texts):
    rep = dc.Report()
    docs = dc.check_yaml(texts, rep)
    return [(e['check'], e['where'], e['msg']) for e in rep.errors if e['check'] == 'yaml'], docs


class YamlDocsTest(unittest.TestCase):
    def test_FND110_여러문서는_문서마다따로읽어_같은키를두번으로보지않는다(self):
        errs, docs = errors({'deploy/local/x.yaml': TWO_DOCS})
        self.assertEqual(errs, [])
        self.assertEqual([d['kind'] for d in docs['deploy/local/x.yaml']], ['Service', 'Deployment'])

    def test_FND110_한문서안의같은키는_원래줄번호로잡는다(self):
        text = TWO_DOCS + 'kind: Again\n'
        errs, _ = errors({'deploy/local/x.yaml': text})
        self.assertEqual(len(errs), 1)
        self.assertIn('deploy/local/x.yaml:11', errs[0][1])
        self.assertIn("'kind'", errs[0][2])

    def test_FND110_한문서파일은_예전처럼값하나다(self):
        errs, docs = errors({'docs/api/x.yaml': 'a: 1\nb: 2\n'})
        self.assertEqual(errs, [])
        self.assertEqual(docs['docs/api/x.yaml'], {'a': '1', 'b': '2'})  # 이 읽기 도구는 값을 글자로 둔다

    def test_FND110_Helm차트templates는_건너뛰고_차트밖templates는읽는다(self):
        tpl = '{{- if .Values.x }}\napiVersion: v1\nkind: { a: {{ .Values.y }} }\n{{- end }}\n'
        errs, docs = errors({
            'deploy/charts/c/Chart.yaml': 'apiVersion: v2\nname: c\nversion: 0.1.0\n',
            'deploy/charts/c/templates/d.yaml': tpl,
            'deploy/other/templates/e.yaml': tpl,
        })
        self.assertNotIn('deploy/charts/c/templates/d.yaml', docs)
        self.assertEqual([e[1].split(':')[0] for e in errs], ['deploy/other/templates/e.yaml'])


if __name__ == '__main__':
    unittest.main()
