// 제어 토픽 소비가 꼭 있어야 하는지의 판정(controlSyncRequired). 서비스 시작 파일은 이 값이 거짓일 때만 Kafka 클라이언트 모듈(네이티브 모듈)을
// 싣지 못해도 경고로 넘기고 뜬다(ADR-0249 결정 4와 같은 꼴). 브로커 주소가 없어도 뜨는 곳은 local·ci뿐이다
// (ADR-0334 결정 2, docs/features/control-tower.md C-T75 ② '서비스 파드가 그 사건을 받는다', BAT-215 리뷰 RV215-6).
import { describe, expect, test } from 'vitest';
import { controlSyncRequired } from '../src/index.js';

describe('C-T75 ② 제어 토픽 소비가 꼭 있어야 하는지(controlSyncRequired, RV215-6)', () => {
  test('C-T75 ② RV215-6 ① local·ci에 브로커 주소가 없으면(빈 값·공백 포함) 꼭 있어야 하지 않다', () => {
    expect(controlSyncRequired({ PEAKET_ENV: 'local' })).toBe(false);
    expect(controlSyncRequired({ PEAKET_ENV: 'ci' })).toBe(false);
    expect(controlSyncRequired({ PEAKET_ENV: 'ci', PEAKET_KAFKA_BROKERS: '' })).toBe(false);
    expect(controlSyncRequired({ PEAKET_ENV: 'local', PEAKET_KAFKA_BROKERS: '   ' })).toBe(false);
  });

  test('C-T75 ② RV215-6 ② local·ci라도 브로커 주소가 있으면 꼭 있어야 한다(주소를 주고 모듈을 못 실으면 조용히 끄지 않는다)', () => {
    expect(controlSyncRequired({ PEAKET_ENV: 'local', PEAKET_KAFKA_BROKERS: '127.0.0.1:9092' })).toBe(true);
    expect(controlSyncRequired({ PEAKET_ENV: 'ci', PEAKET_KAFKA_BROKERS: 'kafka-0:9092,kafka-1:9092' })).toBe(true);
  });

  test('C-T75 ② RV215-6 ③ prod·staging은 브로커 주소가 있든 없든 꼭 있어야 한다', () => {
    expect(controlSyncRequired({ PEAKET_ENV: 'prod' })).toBe(true);
    expect(controlSyncRequired({ PEAKET_ENV: 'staging' })).toBe(true);
    expect(controlSyncRequired({ PEAKET_ENV: 'prod', PEAKET_KAFKA_BROKERS: 'b-1.msk:9098' })).toBe(true);
  });

  test('C-T75 ② RV215-6 ④ PEAKET_ENV가 없거나 비었거나 모르는 값(대소문자 다름 포함)이면 꼭 있어야 한다(열린 쪽으로 실패하지 않는다)', () => {
    expect(controlSyncRequired({})).toBe(true);
    expect(controlSyncRequired({ PEAKET_ENV: '' })).toBe(true);
    expect(controlSyncRequired({ PEAKET_ENV: 'dev' })).toBe(true);
    expect(controlSyncRequired({ PEAKET_ENV: 'CI' })).toBe(true);
  });
});
