"""지표 사전·규칙 판정·품질 검사 통합 시험(F-04-5 빠른 길, docs/features/analytics.md §6·§7, A-T11·A-T20 ③·A-T25).

실제 ClickHouse 컨테이너에 브론즈 표를 만들고 회차 여럿의 합성 브론즈를 넣은 뒤 dbt build → 현재 판 바꾸기 → 다시 build로
F12 규칙 판정(95% Wilson 구간·판정 보류 사유)·같은 규모 기준선(없음·범위·사분위)·품질 검사·지표 뷰(현재 판만)를 본다. 자기가 띄운 컨테이너 ID만 지운다.

돌리기(data 폴더에서, Docker 잠금을 잡은 뒤):  PYTHONUTF8=1 .venv/Scripts/python -m unittest tests_int.test_metrics_rules -v
"""
import json
import os
import subprocess
import time
import unittest
import uuid
from datetime import datetime, timedelta, timezone

import clickhouse_connect
import yaml

from tests_int.test_dbt_models import DATA, DBT, IMAGE, PASSWORD, USER, free_port, ms, statements

OPEN = datetime(2026, 8, 1, 11, 0, tzinfo=timezone.utc)
E1, E2, E3, L1 = (str(uuid.uuid4()) for _ in range(4))
MEDIUM_OTHERS = [str(uuid.uuid4()) for _ in range(9)]
SMALL = [str(uuid.uuid4()) for _ in range(4)]
RUN1, RUN2, RUN3, RUN4 = (str(uuid.uuid4()) for _ in range(4))
COLS = ['event_id', 'event_key', 'record', 'occurred_at', 'key_version', 'schema_id', 'payload', 'kafka_topic', 'kafka_partition', 'kafka_offset', 'kafka_ts']


class MetricsRules(unittest.TestCase):
    container: str
    ch = None
    offset = 0

    @classmethod
    def setUpClass(cls):
        cls.port = free_port()
        cls.container = subprocess.check_output([
            'docker', 'run', '-d', '-e', f'CLICKHOUSE_USER={USER}', '-e', f'CLICKHOUSE_PASSWORD={PASSWORD}', '-e', 'CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1',
            '-p', f'127.0.0.1:{cls.port}:8123', '--ulimit', 'nofile=262144:262144', IMAGE,
        ], text=True).strip()
        end = time.time() + 120
        while True:
            try:
                cls.ch = clickhouse_connect.get_client(host='127.0.0.1', port=cls.port, username=USER, password=PASSWORD)
                cls.ch.command('SELECT 1')
                break
            except Exception:
                if time.time() > end:
                    raise
                time.sleep(0.5)
        for f in sorted((DATA / 'clickhouse' / 'bronze').glob('*.sql')):
            for s in statements(f.read_text(encoding='utf-8')):
                cls.ch.command(s)
        cls.seed()

    @classmethod
    def tearDownClass(cls):
        subprocess.run(['docker', 'rm', '-f', '-v', cls.container], capture_output=True)

    # ---- 합성 브론즈 ----
    @classmethod
    def rows(cls, table: str, record: str, items: list[tuple[str, datetime, dict]]):
        out = []
        for event_id, at, payload in items:
            cls.offset += 1
            out.append([event_id, str(uuid.uuid4()), record, at, 'local-v1', 1, json.dumps({'eventId': event_id, **payload}), 't', 0, cls.offset, at])
        cls.ch.insert(f'bronze.{table}', out, column_names=COLS)

    @classmethod
    def event(cls, e: str, grade: str, seats: dict[str, int]):
        cls.ch.insert('bronze.brz_ref_event', [[e, 'prod-' + e[:4], '합성 공연', 'CONCERT', 'v-1', '피켓 아레나', OPEN + timedelta(days=30), OPEN, None, sum(seats.values()), '{}', '피켓 기획', grade]],
                      column_names=['event_id', 'production_id', 'production_name', 'genre', 'venue_id', 'venue_name', 'starts_at', 'open_at', 'sale_end_at', 'seat_count', 'sale_policy', 'promoter_name', 'size_grade'])
        price = {'R': 150_000, 'S': 100_000}
        cls.ch.insert('bronze.brz_ref_seat_map', [[e, 1, t, f'{t}구역', t, price[t], n, 1, n] for t, n in seats.items()],
                      column_names=['event_id', 'layout_version', 'section_id', 'section_name', 'tier_id', 'price', 'seat_count', 'seat_index_from', 'seat_index_to'])

    @classmethod
    def sessions(cls, e: str, admitted: int, approved: int, bad_order: int = 0):
        """입장 admitted명(구매 세션 시작), 그중 approved명이 승인. bad_order명은 첫 홀드가 시작보다 1초 앞선다(시각 순서 위반)"""
        start = OPEN + timedelta(minutes=2)
        starts, orders, holds = [], [], []
        for i in range(admitted):
            ps = f'{e[:8]}-ps-{i}'
            starts.append((e, start, {'purchaseSessionId': ps, 'admissionJti': f'adm-{i}', 'startedAt': ms(start)}))
            if i < approved:
                orders.append((e, start + timedelta(minutes=3), {'orderId': f'{e[:8]}-o-{i}', 'purchaseSessionId': ps, 'type': 'APPROVED', 'amount': 100_000, 'items': [], 'firstInStage': True}))
            if i < bad_order:
                holds.append((e, start - timedelta(seconds=1), {'purchaseSessionId': ps, 'mode': 'PICK', 'tierId': 'S', 'sectionId': 'S', 'seatIds': [f'S-{i}'], 'result': 'HELD', 'heldAt': ms(start - timedelta(seconds=1)), 'firstHeldInSession': True, 'retryNo': 0, 'latencyMs': 80}))
        cls.rows('brz_purchase_session', 'PurchaseSessionStarted', starts)
        if orders:
            cls.rows('brz_order_event', 'OrderEvent', orders)
        if holds:
            cls.rows('brz_hold_attempt', 'HoldAttempt', holds)

    @classmethod
    def seed(cls):
        # E1(중형, 매진): 입장 1,200·승인 950 → 전환율 79.2%, 구간 전체가 83% 아래(걸림). 오픈 25분에 매진(22분 초과)
        cls.event(E1, 'MEDIUM', {'R': 2, 'S': 3})
        cls.sessions(E1, 1200, 950)
        cls.rows('brz_event_sale', 'EventSaleChanged', [(E1, OPEN + timedelta(minutes=25), {'status': 'SOLD_OUT', 'previousStatus': 'ON_SALE'})])
        # 등급별 매진: R 두 석은 오픈 3분에 다 팔리고, S는 10분에 한 석만 → R 매진 때 S 미판매 100%
        R = lambda s: {'seatId': s, 'tierId': 'R', 'sectionId': 'R', 'price': 150_000}
        S = lambda s: {'seatId': s, 'tierId': 'S', 'sectionId': 'S', 'price': 100_000}
        cls.rows('brz_order_event', 'OrderEvent', [
            (E1, OPEN + timedelta(minutes=3), {'orderId': 'c1', 'type': 'CONFIRMED', 'amount': 300_000, 'items': [R('R-1'), R('R-2')], 'firstInStage': True}),
            (E1, OPEN + timedelta(minutes=10), {'orderId': 'c2', 'type': 'CONFIRMED', 'amount': 100_000, 'items': [S('S-1')], 'firstInStage': True}),
        ])
        # A-T25: 같은 좌석 S-3을 두 세션이 거의 같은 때 직접 선택(하나는 HELD, 하나는 CONFLICT)
        at = OPEN + timedelta(minutes=4)
        cls.rows('brz_hold_attempt', 'HoldAttempt', [
            (E1, at, {'purchaseSessionId': 'race-a', 'mode': 'PICK', 'tierId': 'S', 'sectionId': 'S', 'seatIds': ['S-3'], 'result': 'HELD', 'heldAt': ms(at), 'firstHeldInSession': True, 'retryNo': 0, 'latencyMs': 90}),
            (E1, at + timedelta(milliseconds=3), {'purchaseSessionId': 'race-b', 'mode': 'PICK', 'tierId': 'S', 'sectionId': 'S', 'seatIds': ['S-3'], 'result': 'CONFLICT', 'firstHeldInSession': False, 'retryNo': 0, 'latencyMs': 95}),
        ])
        # 지표 사전의 나머지 원천이 E1에 한 줄씩 있게: 대기 기록 1(예상 120초·실제 120초 → 비율 1.0), 결제 승인·실패, 셀프 환불
        cls.rows('brz_queue_entry', 'QueueEntryRecord', [(E1, OPEN + timedelta(minutes=3), {'queueEntryId': 'qe-1', 'pid': 'p-1', 'number': 1, 'entryMode': 'ONLINE', 'enteredAt': ms(OPEN + timedelta(minutes=1)),
                                                                                         'firstEtaSec': 120, 'turnAt': ms(OPEN + timedelta(minutes=3)), 'admittedAt': ms(OPEN + timedelta(minutes=3)), 'admissionJti': 'adm-q1'})])
        cls.rows('brz_payment_event', 'PaymentEvent', [
            (E1, OPEN + timedelta(minutes=5), {'orderId': 'p1', 'pg': 'TOSS', 'type': 'APPROVED', 'amount': 100_000, 'payMethodCategory': 'CARD', 'latencyMs': 300}),
            (E1, OPEN + timedelta(minutes=6), {'orderId': 'p2', 'pg': 'PORTONE', 'type': 'FAILED', 'amount': 100_000, 'payMethodCategory': 'CARD', 'failureCategory': 'CARD_DECLINED', 'latencyMs': 700}),
        ])
        cls.rows('brz_order_event', 'OrderEvent', [(E1, OPEN + timedelta(days=2), {'orderId': 'c2', 'type': 'REFUNDED', 'amount': 100_000, 'refundAmount': 100_000, 'items': [S('S-1')], 'firstInStage': False})])
        # E2(중형, 매진): 입장 900 → 전환율 규칙은 표본 부족(A-T11)
        cls.event(E2, 'MEDIUM', {'S': 10})
        cls.sessions(E2, 900, 800)
        cls.rows('brz_event_sale', 'EventSaleChanged', [(E2, OPEN + timedelta(minutes=15), {'status': 'SOLD_OUT', 'previousStatus': 'ON_SALE'})])
        # E3(중형): 50 세션 가운데 하나가 시각 순서 위반 → 격리(F3 입장 49), 품질 검사 WARN 1
        cls.event(E3, 'MEDIUM', {'S': 10})
        cls.sessions(E3, 50, 40, bad_order=1)
        # 같은 규모 기준선 재료: 중형 9회(E1의 비교 회차 = E2·E3·이 아홉 = 11 → 사분위), 소형 4회(서로 3 → 범위), 대형 1회(없음)
        for i, e in enumerate(MEDIUM_OTHERS):
            cls.event(e, 'MEDIUM', {'S': 10})
            cls.sessions(e, 20, 14 + (i % 5))
        for i, e in enumerate(SMALL):
            cls.event(e, 'SMALL', {'S': 10})
            cls.sessions(e, 10, 6 + i)
        cls.event(L1, 'LARGE', {'S': 10})
        cls.sessions(L1, 10, 9)

    def dbt(self, *args: str, run_id: str, stage: str = 'R1', event_id: str | None = None, quality_failed: list[str] | None = None):
        env = {**os.environ, 'PYTHONUTF8': '1', 'PEAKET_ANALYTICS_CLICKHOUSE_HOST': '127.0.0.1', 'PEAKET_ANALYTICS_CLICKHOUSE_PORT': str(self.port),
               'PEAKET_ANALYTICS_CLICKHOUSE_USER': USER, 'PEAKET_ANALYTICS_CLICKHOUSE_PASSWORD': PASSWORD}
        v = json.dumps({'event_id': event_id, 'run_id': run_id, 'stage': stage, 'quality_failed': quality_failed or []})
        r = subprocess.run([DBT, *args, '--profiles-dir', '.', '--vars', v], cwd=DATA, env=env, capture_output=True, text=True, encoding='utf-8')
        if r.returncode != 0:
            raise AssertionError(f'dbt {" ".join(args)} 실패\n{r.stdout[-6000:]}\n{r.stderr[-2000:]}')
        return r

    def swap_all(self, run_id: str):
        # 회차 17개의 현재 판을 한 번에 바꾼다(swap_current_run 매크로와 같은 줄을 넣는다. 매크로 자체는 test_dbt_models가 본다)
        now = datetime.now(timezone.utc)
        self.ch.insert('gold.current_run', [[e, run_id, now] for e in [E1, E2, E3, L1, *MEDIUM_OTHERS, *SMALL]], column_names=['event_id', 'run_id', 'switched_at'])

    def q(self, sql: str):
        return self.ch.query(sql).result_rows

    def rule(self, e: str, run: str, rule_id: str):
        cols = ['verdict', 'hold_reason', 'value', 'ci_low', 'ci_high', 'sample', 'baseline_n', 'baseline_shape', 'baseline_strength', 'provisional', 'close_stage']
        rows = self.q(f"SELECT {', '.join(cols)} FROM gold.fct_rule_check WHERE event_id = '{e}' AND run_id = '{run}' AND rule_id = '{rule_id}'")
        self.assertEqual(len(rows), 1, (e, run, rule_id))
        return dict(zip(cols, rows[0]))

    def test_1_rules_baseline_quality_views(self):
        self.dbt('seed', run_id=RUN1)
        self.dbt('build', run_id=RUN1)
        self.swap_all(RUN1)
        self.dbt('build', run_id=RUN2)
        self.swap_all(RUN2)

        # 규칙 18개가 회차마다 한 줄씩
        rules = yaml.safe_load((DATA / 'models' / 'metrics' / 'rules.yml').read_text(encoding='utf-8'))['models'][0]['config']['meta']['rules']
        self.assertEqual(len(rules), 18)
        self.assertEqual(self.q(f"SELECT count() FROM gold.fct_rule_check WHERE event_id = '{E1}' AND run_id = '{RUN2}'")[0][0], 18)

        # 입장 → 구매 전환율: 950/1,200 = 0.7917, 95% Wilson 구간 [0.768, 0.814] 전체가 0.83 아래 → 걸림. 같은 규모 확정 회차 11 → 사분위(IQR)
        c = self.rule(E1, RUN2, 'admission_to_purchase_rate')
        self.assertEqual((c['verdict'], c['hold_reason'], c['sample']), ('HIT', '', 1200))
        self.assertAlmostEqual(c['value'], 950 / 1200, places=6)
        self.assertAlmostEqual(c['ci_low'], 0.7678, places=3)
        self.assertAlmostEqual(c['ci_high'], 0.8137, places=3)
        self.assertEqual((c['baseline_n'], c['baseline_shape'], c['baseline_strength']), (11, 'IQR', 'NORMAL'))
        # A-T11: 입장 900명 → 판정 보류(표본 부족)
        self.assertEqual((self.rule(E2, RUN2, 'admission_to_purchase_rate')['verdict'], self.rule(E2, RUN2, 'admission_to_purchase_rate')['hold_reason']), ('HOLD', 'SAMPLE_SHORT'))
        # 기준선 모양: 소형은 서로 3회 → 범위(근거 약함), 대형 혼자 → 없음
        s = self.rule(SMALL[0], RUN2, 'admission_to_purchase_rate')
        self.assertEqual((s['baseline_n'], s['baseline_shape'], s['baseline_strength']), (3, 'RANGE', 'WEAK'))
        l = self.rule(L1, RUN2, 'admission_to_purchase_rate')
        self.assertEqual((l['baseline_n'], l['baseline_shape']), (0, 'NONE'))
        # 매진 소요 시간 25분 > 22분 → 걸림(값 규칙), 등급별 매진 시각 차이: R 매진(3분) 때 S 미판매 100% → 걸림
        so = self.rule(E1, RUN2, 'sold_out_minutes')
        self.assertEqual((so['verdict'], so['value']), ('HIT', 25.0))
        gap = self.rule(E1, RUN2, 'tier_sold_out_gap')
        self.assertEqual((gap['verdict'], gap['value']), ('HIT', 1.0))
        # 원천이 없는 R0 규칙(에러 버짓)은 판정 보류(데이터 품질 실패), R2 규칙(CS 건수)은 R1에서 미확정, 직접 선택 시도 2건은 표본 부족
        self.assertEqual(self.rule(E1, RUN2, 'error_budget_used')['hold_reason'], 'QUALITY_FAILED')
        self.assertEqual(self.rule(E1, RUN2, 'cs_count')['hold_reason'], 'NOT_FINAL')
        self.assertEqual(self.rule(E1, RUN2, 'hold_conflict_rate')['hold_reason'], 'SAMPLE_SHORT')

        # A-T25: 실버에서 두 시도의 seatIds가 같고 진 시도에도 좌석 번호가 남는다. F4 패배율(직접 선택) = 1/2, 좌석 단위로 셀 수 있다
        race = self.q(f"SELECT result, seat_ids FROM silver.slv_hold_attempt WHERE event_id = '{E1}' AND purchase_session_ref IN ('race-a', 'race-b') ORDER BY result")
        self.assertEqual(race, [('CONFLICT', ['S-3']), ('HELD', ['S-3'])])
        self.assertEqual(self.q(f"SELECT count() FROM silver.slv_hold_attempt ARRAY JOIN seat_ids AS seat WHERE event_id = '{E1}' AND seat = 'S-3'")[0][0], 2)
        pick = self.q(f"SELECT value, numerator, denominator FROM gold.mtr_event_metric WHERE event_id = '{E1}' AND metric = 'hold_conflict_rate' AND dim = 'PICK'")
        self.assertEqual(pick, [(0.5, 1.0, 2.0)])

        # 품질: E3의 시각 순서 위반 세션 1개는 격리(F3 입장 49), 검사는 WARN이고 판정을 막지 않는다
        self.assertEqual(self.q(f"SELECT status, failed_count FROM gold.mtr_data_quality WHERE event_id = '{E3}' AND check_name = 'time_order'"), [('WARN', 1)])
        self.assertEqual(self.q(f"SELECT denominator FROM gold.mtr_event_metric WHERE event_id = '{E3}' AND metric = 'admission_to_purchase_rate'"), [(49.0,)])

        # 지표 사전: metrics.yml의 지표가 모두 metric_value에 있다(원천 없음은 source_ok 0)
        metrics = yaml.safe_load((DATA / 'models' / 'metrics' / 'metrics.yml').read_text(encoding='utf-8'))['models'][0]['config']['meta']['metrics']
        names = {m['name'] for m in metrics}
        have = {r[0] for r in self.q(f"SELECT DISTINCT metric FROM gold.mtr_event_metric WHERE event_id = '{E1}'")}
        self.assertEqual(names - have, set())
        numbered = {m['num'] for m in metrics if m['num'] > 0}
        self.assertEqual(numbered, set(range(1, 32)))
        none = {m['name'] for m in metrics if m.get('source') == 'none'}
        self.assertEqual({r[0] for r in self.q(f"SELECT metric FROM gold.mtr_event_metric WHERE event_id = '{E1}' AND source_ok = 0")}, none | {'slo_good_rate', 'invariant_violations'})

        mv = {(m, d): v for m, d, v in self.q(f"SELECT metric, dim, value FROM gold.mtr_event_metric WHERE event_id = '{E1}'")}
        self.assertEqual(mv[('wait_error_p90', '')], 1.5)
        self.assertEqual((mv[('pg_approval_rate', 'TOSS')], mv[('pg_approval_rate', 'PORTONE')], mv[('pg_latency_p99_ms', 'TOSS')]), (1.0, 0.0, 500.0))
        self.assertEqual(mv[('payment_failure_share', 'CARD_DECLINED')], 1.0)
        self.assertEqual(mv[('refunds', 'SELF')], 100_000.0)

        # 뷰는 현재 판만: E1 행은 판 하나, 등급별 매진 시각 R 3분·S 없음, 판매 곡선 R 3분 누적 100%
        self.assertEqual(self.q(f"SELECT uniqExact(run_id) FROM gold.mtr_event_metric WHERE event_id = '{E1}'")[0][0], 1)
        self.assertEqual(self.q(f"SELECT tier_id, sold_out_minute FROM gold.mtr_tier_sold_out WHERE event_id = '{E1}' ORDER BY tier_rank"), [('R', 3), ('S', None)])
        self.assertEqual(self.q(f"SELECT cum_sold_seats, cum_sale_rate FROM gold.mtr_sales_curve WHERE event_id = '{E1}' AND tier_id = 'R' AND open_minute = 3"), [(2, 1.0)])
        self.assertEqual(self.q(f"SELECT count() FROM gold.mtr_rule_check WHERE event_id = '{E1}'")[0][0], 18)
        print(f"[F-04-5] 전환율 {c['value']:.4f} 구간 [{c['ci_low']:.4f}, {c['ci_high']:.4f}] < 0.83 → {c['verdict']}, 기준선 n={c['baseline_n']} {c['baseline_shape']}; "
              f"입장 900 → HOLD(SAMPLE_SHORT); 소형 n=3 RANGE·WEAK, 대형 n=0 NONE; 매진 25분 → HIT; 등급 차이 1.0 → HIT; "
              f"지표 {len(names)}개(번호 1~31) 모두 있음, 원천 없음 {len(none)}개")

    def test_2_quality_failure_and_not_final(self):
        # A-T20 ③: 마감 실행기가 전환율의 바깥 품질 검사 실패를 넘기면 그 규칙은 판정 보류(데이터 품질 실패)
        self.dbt('build', '--select', '+fct_rule_check', run_id=RUN3, event_id=E1, quality_failed=['admission_to_purchase_rate'])
        c = self.rule(E1, RUN3, 'admission_to_purchase_rate')
        self.assertEqual((c['verdict'], c['hold_reason']), ('HOLD', 'QUALITY_FAILED'))
        self.assertEqual(self.q(f"SELECT status, affects FROM gold.quality_check WHERE event_id = '{E1}' AND run_id = '{RUN3}' AND check_name = 'external'"), [('FAIL', ['admission_to_purchase_rate'])])
        # 같은 판의 다른 규칙은 그대로 판정된다
        self.assertEqual(self.rule(E1, RUN3, 'sold_out_minutes')['verdict'], 'HIT')
        # R0: R1 규칙은 미확정, 매진 소요 시간은 R0 잠정으로 판정(provisional 1)
        self.dbt('build', '--select', '+fct_rule_check', run_id=RUN4, event_id=E1, stage='R0')
        self.assertEqual((self.rule(E1, RUN4, 'admission_to_purchase_rate')['verdict'], self.rule(E1, RUN4, 'admission_to_purchase_rate')['hold_reason']), ('HOLD', 'NOT_FINAL'))
        so = self.rule(E1, RUN4, 'sold_out_minutes')
        self.assertEqual((so['verdict'], so['provisional'], so['close_stage']), ('HIT', 1, 'R0'))
        # 현재 판은 RUN2 그대로라 지표 뷰는 바뀌지 않는다(판 바꾸기 전, analytics §4.1)
        self.assertEqual(self.q(f"SELECT DISTINCT run_id FROM gold.mtr_rule_check WHERE event_id = '{E1}'"), [(RUN2,)])
        print('[F-04-5] 바깥 품질 실패 → 전환율 HOLD(QUALITY_FAILED), 매진 소요는 HIT 그대로; R0 → 전환율 HOLD(NOT_FINAL), 매진 소요 HIT(잠정)')


if __name__ == '__main__':
    unittest.main()
