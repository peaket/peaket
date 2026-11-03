"""문서 점검 도구 `api` 검사의 openapi 계약 시험(기술 검토 낮음-031·032, wbs 0.1.3).

openapi 글 하나를 `docs/api/openapi.yaml` 이름으로 넣고, check_all.main()이 부르는 순서 그대로
(check_yaml → check_api → check_api_contract) 돌려 오류와 보고(정보 줄)를 본다.
실행: python -I -m unittest discover -s tools/doc-check -p "test_*.py"
"""
import os
import sys
import textwrap
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check_all as dc  # noqa: E402

OPENAPI = 'docs/api/openapi.yaml'
GLOBAL_FAN = "security:\n  - fanCookie: []\n"
RULES_OPS_FIRST = """\
x-peaket-gateways:
  rules:
    - { prefix: /v1/ops/, server: 'https://ops-api.peaket.example' }
    - { prefix: /v1/scanner/, server: 'https://scanner-api.peaket.example' }
    - { prefix: /v1/, server: 'https://api.peaket.example' }
"""
COMPONENTS = """\
components:
  securitySchemes:
    fanCookie: { type: apiKey, in: cookie, name: __Secure-peaket_at }
    opsCookie: { type: apiKey, in: cookie, name: __Host-peaket_ops_at }
    deviceDpop: { type: apiKey, in: header, name: DPoP }
  responses:
    Problem: { description: RFC 9457 오류, content: { application/problem+json: { schema: { $ref: '#/components/schemas/Problem' } } } }
"""


def run(paths, security=GLOBAL_FAN, rules=RULES_OPS_FIRST):
    """paths: `paths:` 아래 글(들여쓰기는 상대값. 맨 앞을 걷어 낸 뒤 경로가 두 칸, 작업이 네 칸이 되게 민다)."""
    text = 'openapi: 3.1.0\n' + security + rules + COMPONENTS + 'paths:\n' + textwrap.indent(textwrap.dedent(paths), '  ')
    texts = {OPENAPI: text}
    rep = dc.Report()
    docs = dc.check_yaml(texts, rep)
    dc.check_api(texts, rep)
    dc.check_api_contract(docs.get(OPENAPI), rep)
    return rep


def messages(rep):
    return ['%s: %s' % (e['where'], e['msg']) for e in rep.errors]


class 낮음031_호스트와_인증(unittest.TestCase):
    def test_낮음031_처음맞는접두사의_서버로_호스트를정한다(self):
        paths = """\
          /v1/ops/events:
            get: { responses: { '200': { description: 목록 } } }
          /v1/events:
            get: { responses: { '200': { description: 목록 } } }
        """
        rep = run(paths)
        self.assertEqual([], messages(rep))
        self.assertEqual({'ops-api': 1, 'api': 1}, rep.info['api_hosts'])
        # 넓은 접두사가 앞에 있으면 그것이 이긴다(위에서부터 처음 맞는 것, guidelines §10)
        wide_first = "x-peaket-gateways:\n  rules:\n    - { prefix: /v1/, server: 'https://api.peaket.example' }\n" \
                     "    - { prefix: /v1/ops/, server: 'https://ops-api.peaket.example' }\n"
        rep = run(paths, rules=wide_first)
        self.assertEqual([], messages(rep))
        self.assertEqual({'api': 2}, rep.info['api_hosts'])

    def test_낮음031_경로servers가_접두사규칙을이긴다(self):
        rep = run("""\
          /v1/pages/{pageId}.json:
            servers: [{ url: 'https://www.peaket.example' }]
            get: { responses: { '200': { description: 파일 } } }
        """)
        self.assertEqual([], messages(rep))
        self.assertEqual({'www': 1}, rep.info['api_hosts'])

    def test_낮음031_작업servers가_경로servers를이긴다(self):
        rep = run("""\
          /v1/pages/{pageId}.json:
            servers: [{ url: 'https://www.peaket.example' }]
            get:
              servers: [{ url: 'https://queue-files.peaket.example' }]
              responses: { '200': { description: 파일 } }
        """)
        self.assertEqual([], messages(rep))
        self.assertEqual({'queue-files': 1}, rep.info['api_hosts'])

    def test_낮음031_맞는규칙도servers도없으면_오류(self):
        only_ops = "x-peaket-gateways:\n  rules:\n    - { prefix: /v1/ops/, server: 'https://ops-api.peaket.example' }\n"
        rep = run("""\
          /v1/events:
            get: { responses: { '200': { description: 목록 } } }
        """, rules=only_ops)
        self.assertEqual(1, len(rep.errors), messages(rep))
        self.assertEqual('docs/api/openapi.yaml GET /v1/events', rep.errors[0]['where'])
        self.assertIn('호스트가 하나로 정해지지 않음', rep.errors[0]['msg'])
        self.assertEqual(1, rep.info['api']['missing_host'])
        self.assertEqual({}, rep.info['api_hosts'])

    def test_낮음031_servers에서버가둘이면_오류(self):
        rep = run("""\
          /v1/pages/{pageId}.json:
            servers: [{ url: 'https://www.peaket.example' }, { url: 'https://queue-files.peaket.example' }]
            get: { responses: { '200': { description: 파일 } } }
        """)
        self.assertEqual(1, len(rep.errors), messages(rep))
        self.assertIn('호스트가 하나로 정해지지 않음', rep.errors[0]['msg'])
        self.assertEqual(1, rep.info['api']['missing_host'])

    def test_낮음031_작업security의_없는인증방식은_오류(self):
        rep = run("""\
          /v1/events:
            get: { security: [{ fanCookie: [] }, { ghostCookie: [] }], responses: { '200': { description: 목록 } } }
        """)
        self.assertEqual(['docs/api/openapi.yaml GET /v1/events: security의 ghostCookie가 securitySchemes에 없음'],
                         messages(rep))

    def test_낮음031_전역security의_없는인증방식은_오류(self):
        rep = run("""\
          /v1/events:
            get: { security: [], responses: { '200': { description: 목록 } } }
        """, security="security:\n  - ghostCookie: []\n")
        self.assertEqual(['docs/api/openapi.yaml security: 전역 security의 ghostCookie가 securitySchemes에 없음'],
                         messages(rep))

    def test_낮음031_security를안적은작업은_전역이있을때만_통과(self):
        paths = """\
          /v1/events:
            get: { responses: { '200': { description: 목록 } } }
        """
        rep = run(paths)
        self.assertEqual([], messages(rep))
        self.assertEqual(1, rep.info['api']['missing_security'])
        rep = run(paths, security='')
        self.assertEqual(1, len(rep.errors), messages(rep))
        self.assertIn('security가 없고 전역 security도 없음', rep.errors[0]['msg'])
        self.assertEqual(1, rep.info['api']['missing_security'])
        # 전역이 빈 목록이면 기본 인증이 없다. 적지 않은 작업이 조용히 공개 작업이 되지 않게 오류다(guidelines §10)
        rep = run(paths, security='security: []\n')
        self.assertEqual(1, len(rep.errors), messages(rep))
        self.assertIn('security가 없고 전역 security도 없음', rep.errors[0]['msg'])
        self.assertEqual(0, rep.info['api']['public'])

    def test_낮음031_security빈목록은_공개작업(self):
        rep = run("""\
          /v1/events:
            get: { security: [], responses: { '200': { description: 목록 } } }
        """, security='')
        self.assertEqual([], messages(rep))
        self.assertEqual(1, rep.info['api']['public'])
        self.assertEqual(0, rep.info['api']['missing_security'])

    def test_낮음031_명세를읽지못하면_계약검사실패(self):
        rep = run("""\
          /v1/events:
            get: { responses: { '200': { description: "닫히지 않은 따옴표 } } }
        """)
        self.assertTrue(any(e['check'] == 'yaml' for e in rep.errors), messages(rep))
        self.assertIn('docs/api/openapi.yaml: openapi를 읽지 못해 계약 검사를 못 함', messages(rep))


class 낮음032_명세숫자보고(unittest.TestCase):
    def test_낮음032_보고숫자가_명세와같다(self):
        rep = run("""\
          /v1/events:
            get:
              operationId: listEvents
              responses:
                '200': { description: 목록 }
                '404': { $ref: '#/components/responses/Problem' }
                '503': { description: 잠시 못 함, content: { application/problem+json: { schema: { type: object } } } }
            post:
              responses:
                '201': { description: 만듦 }
                '400': { $ref: '#/components/responses/Problem' }
                '409': { description: 충돌, content: { application/json: { schema: { $ref: '#/components/schemas/Problem' } } } }
          /v1/events/{eventId}:
            get: { security: [], responses: { '200': { description: 한 건 } } }
          /v1/ops/events:
            get: { security: [{ opsCookie: [] }], responses: { '200': { description: 목록 }, '403': { $ref: '#/components/responses/Problem' } } }
        """)
        self.assertEqual([], messages(rep))
        # Problem 선언은 셋 다 센다: components/responses 참조(404·400·403), application/problem+json(503),
        # 다른 형식 아래 Problem 스키마 참조(409, README 'api' 행)
        self.assertEqual({'paths': 3, 'operations': 4, 'error_responses': 5, 'problem_responses': 5,
                          'missing_operation_id': 3, 'missing_host': 0, 'missing_security': 2, 'public': 1,
                          'if_match_required': 0, 'if_match_exempt': 0}, dict(rep.info['api']))
        self.assertEqual({'api': 3, 'ops-api': 1}, rep.info['api_hosts'])
        self.assertEqual([], rep.info['api_problem_exempt'])

    def test_낮음032_Problem예외는_오류가아니고_목록에나온다(self):
        rep = run("""\
          /v1/queues/{eventId}/shuffle-results/{hashPrefix}.json:
            get: { security: [], responses: { '200': { description: 파일 }, '404': { description: 아직 없음 } } }
          /v1/scanner/token:
            post:
              security: [{ deviceDpop: [] }]
              responses:
                '200': { description: 토큰 }
                '400': { description: OAuth 오류, content: { application/json: { schema: { $ref: '#/components/schemas/OAuthError' } } } }
        """)
        self.assertEqual([], messages(rep))
        self.assertEqual(['GET /v1/queues/{eventId}/shuffle-results/{hashPrefix}.json 404', 'POST /v1/scanner/token 400'],
                         rep.info['api_problem_exempt'])
        self.assertEqual(2, rep.info['api']['error_responses'])
        self.assertEqual(0, rep.info['api']['problem_responses'])

    def test_낮음032_예외가아닌오류응답이Problem이아니면_오류(self):
        rep = run("""\
          /v1/events:
            get: { responses: { '200': { description: 목록 }, '404': { description: 없음 } } }
          /v1/queues/{eventId}/shuffle-results/{hashPrefix}.json:
            get: { security: [], responses: { '200': { description: 파일 }, '400': { description: 틀림 } } }
          /v1/scanner/token:
            post: { security: [{ deviceDpop: [] }], responses: { '401': { description: 인증 실패 } } }
        """)
        self.assertEqual(['docs/api/openapi.yaml GET /v1/events: 404 응답이 Problem을 선언하지 않음(guidelines §2·§12)',
                          'docs/api/openapi.yaml GET /v1/queues/{eventId}/shuffle-results/{hashPrefix}.json: '
                          '400 응답이 Problem을 선언하지 않음(guidelines §2·§12)',
                          'docs/api/openapi.yaml POST /v1/scanner/token: 401 응답이 Problem을 선언하지 않음(guidelines §2·§12)'],
                         messages(rep))
        self.assertEqual([], rep.info['api_problem_exempt'])

    def test_낮음032_줄규칙과YAML의작업수가다르면_오류(self):
        # 줄 규칙(check_api)은 get·post·put·patch·delete만 센다. head 작업은 YAML 읽기만 센다
        rep = run("""\
          /v1/events:
            get: { responses: { '200': { description: 목록 } } }
            head: { responses: { '200': { description: 머리만 } } }
        """)
        self.assertEqual(['docs/api/openapi.yaml: 작업 수를 줄 규칙(1)과 YAML 읽기(2)로 센 값이 다름'], messages(rep))
        self.assertEqual(2, rep.info['api']['operations'])


if __name__ == '__main__':
    unittest.main()
