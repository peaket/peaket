"""문서 점검 도구 `api` 검사의 계약 규칙 시험(BUILD_ORDER BAS-040, docs/api/guidelines.md §1·§2·§10).

- 작업 이름(operationId): 모든 작업에 있고, 겹치지 않으며, 메서드에 맞는 동사로 시작하는 camelCase다(§10 '작업 이름').
- 오류 목록(x-peaket-problem-types): 항목마다 4xx·5xx 상태 코드와 제목이 있고, 오류 응답 설명에 적힌 케밥 이름은
  목록에 있어야 한다. 목록과 다른 상태 코드의 응답에 적힌 이름은 경고다(대비 설명일 수 있다, §2).
- 칸 닫힘: 요청 본문에서 닿는 객체는 additionalProperties: false로 닫고, 응답에서 닿는 객체는 닫지 않는다.
  둘 다에서 닿는 객체 스키마는 요청용과 나눈다(§1 '응답 칸 추가는 깨짐 아님', authz-matrix '요청 스키마는 허용한 칸만').
실행: python -I -X utf8 -m unittest discover -s tools/doc-check -p "test_*.py"
"""
import os
import sys
import textwrap
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check_all as dc  # noqa: E402

PROBLEMS = """\
x-peaket-problem-types:
  types:
    seat-already-held: { status: 409, title: "좌석이 이미 선택되었습니다" }
    sale-paused: { status: 423, title: "판매가 잠시 멈췄습니다" }
"""


def spec(paths, problems=PROBLEMS, schemas='', extra_components=''):
    text = ('openapi: 3.1.0\n' + problems + 'components:\n  schemas:\n' + textwrap.indent(textwrap.dedent(schemas), '    ')
            + textwrap.indent(textwrap.dedent(extra_components), '  ')
            + 'paths:\n' + textwrap.indent(textwrap.dedent(paths), '  '))
    # 실제 점검(check_all.main)과 같은 읽기를 거친다. check_yaml은 YAML 값을 글자로 읽는다('false', '423')
    docs = dc.check_yaml({'docs/api/openapi.yaml': text}, dc.Report())
    return docs['docs/api/openapi.yaml']


def run(fn, paths, **kw):
    rep = dc.Report()
    fn(spec(paths, **kw), rep)
    return rep


def errors(rep):
    return [e['msg'] for e in rep.errors]


def warnings(rep):
    return [w['msg'] for w in rep.warnings]


class 작업이름(unittest.TestCase):
    def test_이름이없거나_겹치거나_동사가메서드와다르면_오류다(self):
        paths = """\
          /v1/events/{eventId}/holds:
            post: { operationId: createEventHold, responses: { '201': { description: 홀드 } } }
          /v1/holds/{holdId}:
            delete: { operationId: createEventHold, responses: { '204': { description: 해제 } } }
          /v1/orders:
            post: { responses: { '201': { description: 주문 } } }
          /v1/tickets:
            get: { operationId: createTickets, responses: { '200': { description: 목록 } } }
        """
        msgs = errors(run(dc.check_operation_ids, paths))
        # DELETE의 createEventHold는 겹침과 동사(delete) 둘 다 걸린다
        self.assertEqual(4, len(msgs), msgs)
        self.assertTrue(any('겹침' in m and 'createEventHold' in m for m in msgs), msgs)
        self.assertTrue(any('DELETE' in m and 'delete로 시작' in m for m in msgs), msgs)
        self.assertTrue(any('operationId가 없음' in m for m in msgs), msgs)
        self.assertTrue(any('GET' in m and 'createTickets' in m for m in msgs), msgs)

    def test_규칙대로면_오류가없고_수를보고한다(self):
        paths = """\
          /v1/tickets:
            get: { operationId: listTickets, responses: { '200': { description: 목록 } } }
          /v1/webhooks/toss:
            post: { operationId: receiveTossWebhook, responses: { '200': { description: 받음 } } }
          /v1/productions/{productionId}/wish:
            put: { operationId: putProductionWish, responses: { '204': { description: 찜 } } }
            delete: { operationId: deleteProductionWish, responses: { '204': { description: 해제 } } }
          /v1/reviews/{reviewId}:
            patch: { operationId: updateReview, responses: { '200': { description: 고침 } } }
        """
        rep = run(dc.check_operation_ids, paths)
        self.assertEqual([], errors(rep))
        self.assertEqual(5, rep.info['api']['operation_ids'])

    def test_camelCase가아니면_오류다(self):
        paths = """\
          /v1/tickets:
            get: { operationId: list_tickets, responses: { '200': { description: 목록 } } }
        """
        self.assertEqual(1, len(errors(run(dc.check_operation_ids, paths))))


class 오류목록(unittest.TestCase):
    def test_목록의이름은_오류가없다_다른상태코드에적히면_경고다(self):
        paths = """\
          /v1/events/{eventId}/holds:
            post:
              responses:
                '409': { description: "경합 패배 seat-already-held(suggestedSeats)" }
                '423': { description: "Problem type sale-paused" }
                '410': { description: "판매 종료. 409 seat-already-held와 다르다" }
        """
        rep = run(dc.check_problem_types, paths)
        self.assertEqual([], errors(rep))
        self.assertEqual(1, len(warnings(rep)), warnings(rep))
        self.assertIn('seat-already-held', warnings(rep)[0])

    def test_목록에없는_케밥이름은_오류다_서비스이름과_머리이름은_오류가아니다(self):
        paths = """\
          /v1/events/{eventId}/holds:
            post:
              responses:
                '409': { description: "hold-not-found 또는 seat-already-hold" }
                '503': { description: "purchase-svc가 gw-fan 뒤에서 x-peaket-deadline-ms를 본다" }
        """
        msgs = errors(run(dc.check_problem_types, paths))
        self.assertEqual(2, len(msgs), msgs)
        self.assertTrue(all('목록(x-peaket-problem-types)에 없음' in m for m in msgs), msgs)

    def test_대문자별칭은_목록에있을때만_상태코드를본다(self):
        paths = """\
          /v1/holds:
            post:
              responses:
                '410': { description: "SEAT_ALREADY_HELD와 다르다. 상태 PENDING_APPROVAL" }
        """
        rep = run(dc.check_problem_types, paths)
        self.assertEqual([], errors(rep))
        self.assertEqual(1, len(warnings(rep)), warnings(rep))

    def test_항목에_상태코드나제목이없거나_이름모양이틀리면_오류다(self):
        problems = """\
x-peaket-problem-types:
  types:
    seat-already-held: { status: 200, title: "좌석" }
    Sale_Paused: { status: 423, title: "판매가 잠시 멈췄습니다" }
    no-title: { status: 409 }
"""
        msgs = errors(run(dc.check_problem_types, "/v1/x:\n  get: { responses: { '200': { description: 됨 } } }\n", problems=problems))
        self.assertEqual(3, len(msgs), msgs)

    def test_목록이없으면_오류다(self):
        msgs = errors(run(dc.check_problem_types, "/v1/x:\n  get: { responses: { '200': { description: 됨 } } }\n", problems=''))
        self.assertEqual(1, len(msgs), msgs)


class 칸닫힘(unittest.TestCase):
    def test_닫지않은_요청본문과_안쪽객체는_오류다(self):
        paths = """\
          /v1/orders:
            post:
              requestBody: { content: { application/json: { schema: { type: object, additionalProperties: false, properties: { buyer: { type: object, properties: { name: { type: string } } } } } } } }
              responses: { '201': { description: 주문 } }
          /v1/appeals:
            post:
              requestBody: { content: { application/json: { schema: { type: object, properties: { text: { type: string } } } } } }
              responses: { '201': { description: 소명 } }
        """
        msgs = errors(run(dc.check_schema_closure, paths))
        self.assertEqual(2, len(msgs), msgs)
        self.assertTrue(any('POST /v1/orders' in m and 'buyer' in m for m in msgs), msgs)
        self.assertTrue(any('POST /v1/appeals' in m for m in msgs), msgs)

    def test_요청에서닿는_구성요소도_닫는다_맵과_열어둔표시는_예외다(self):
        schemas = """\
          HoldRequest: { type: object, properties: { seatIds: { type: array, items: { type: string } } } }
          Labels: { type: object, additionalProperties: false, properties: { tags: { type: object, additionalProperties: { type: string } }, params: { type: object, x-peaket-open-object: "명령 유형별 값, 구현 전에 oneOf로 닫는다" } } }
        """
        paths = """\
          /v1/events/{eventId}/holds:
            post:
              requestBody: { content: { application/json: { schema: { $ref: '#/components/schemas/HoldRequest' } } } }
              responses: { '201': { description: 홀드 } }
          /v1/labels:
            put:
              requestBody: { content: { application/json: { schema: { $ref: '#/components/schemas/Labels' } } } }
              responses: { '204': { description: 됨 } }
        """
        msgs = errors(run(dc.check_schema_closure, paths, schemas=schemas))
        self.assertEqual(1, len(msgs), msgs)
        self.assertIn('HoldRequest', msgs[0])

    def test_응답의_닫힌객체와_요청응답겸용객체와_요청의allOf는_오류다(self):
        schemas = """\
          TossCheckout: { type: object, additionalProperties: false, properties: { clientKey: { type: string } } }
          MaskRegion: { type: object, additionalProperties: false, properties: { x: { type: number } } }
          Genre: { type: string, enum: [콘서트, 뮤지컬] }
          HomeLayout: { type: object, properties: { banners: { type: array, items: { type: string } } } }
        """
        paths = """\
          /v1/orders/{orderId}/payments:
            post:
              requestBody: { content: { application/json: { schema: { type: object, additionalProperties: false, properties: { genre: { $ref: '#/components/schemas/Genre' }, masks: { type: array, items: { $ref: '#/components/schemas/MaskRegion' } } } } } } }
              responses: { '201': { description: 결제, content: { application/json: { schema: { type: object, properties: { checkout: { $ref: '#/components/schemas/TossCheckout' }, masks: { type: array, items: { $ref: '#/components/schemas/MaskRegion' } }, genre: { $ref: '#/components/schemas/Genre' } } } } } } }
          /v1/ops/home-layout:
            put:
              requestBody: { content: { application/json: { schema: { allOf: [{ $ref: '#/components/schemas/HomeLayout' }, { type: object, additionalProperties: false, properties: { reason: { type: string } } }] } } } }
              responses: { '200': { description: 저장, content: { application/json: { schema: { $ref: '#/components/schemas/HomeLayout' } } } } }
        """
        rep = run(dc.check_schema_closure, paths, schemas=schemas)
        msgs = errors(rep)
        self.assertTrue(any('TossCheckout' in m and '응답' in m for m in msgs), msgs)
        self.assertTrue(any('MaskRegion' in m and '나눈다' in m for m in msgs), msgs)
        self.assertTrue(any('allOf' in m for m in msgs), msgs)
        self.assertFalse(any('Genre' in m for m in msgs), msgs)

    def test_text_plain본문의_contentSchema도_닫는다(self):
        # T=0 두 호출은 JSON을 text/plain 글자로 보낸다(contentMediaType·contentSchema)
        paths = """\
          /v1/queues/{eventId}/entries:
            post:
              requestBody: { content: { application/json: { schema: { type: object, additionalProperties: false, properties: { t: { type: string } } } }, text/plain: { schema: { type: string, contentMediaType: application/json, contentSchema: { type: object, properties: { t: { type: string } } } } } } }
              responses: { '201': { description: 대기표 } }
        """
        msgs = errors(run(dc.check_schema_closure, paths))
        self.assertEqual(1, len(msgs), msgs)
        self.assertIn('contentSchema', msgs[0])

    def test_구성요소의_요청본문과_응답을_따라간다(self):
        extra = """\
          requestBodies:
            ItemBody: { content: { application/json: { schema: { $ref: '#/components/schemas/Item' } } } }
          responses:
            ItemResponse: { description: 물건, content: { application/json: { schema: { $ref: '#/components/schemas/Item' } } } }
        """
        schemas = """\
          Item: { type: object, properties: { id: { type: string } } }
        """
        paths = """\
          /v1/items:
            post:
              requestBody: { $ref: '#/components/requestBodies/ItemBody' }
              responses: { '201': { $ref: '#/components/responses/ItemResponse' } }
        """
        msgs = errors(run(dc.check_schema_closure, paths, schemas=schemas, extra_components=extra))
        self.assertTrue(any('Item' in m and '나눈다' in m for m in msgs), msgs)

    def test_닫힌요청과_열린응답은_오류가없고_수를보고한다(self):
        schemas = """\
          Hold: { type: object, properties: { holdId: { type: string } } }
        """
        paths = """\
          /v1/events/{eventId}/holds:
            post:
              requestBody: { content: { application/json: { schema: { type: object, additionalProperties: false, properties: { auto: { type: object, additionalProperties: false, properties: { count: { type: integer } } } } } } } }
              responses: { '201': { description: 홀드, content: { application/json: { schema: { $ref: '#/components/schemas/Hold' } } } } }
        """
        rep = run(dc.check_schema_closure, paths, schemas=schemas)
        self.assertEqual([], errors(rep))
        self.assertEqual(1, rep.info['api']['json_request_bodies'])


if __name__ == '__main__':
    unittest.main()
