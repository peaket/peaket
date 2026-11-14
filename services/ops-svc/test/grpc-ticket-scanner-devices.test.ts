// ticket-svc ScannerDeviceService gRPC 오류 사상(BAT-450). HTTP 시험의 가짜 포트가 지나가는 길을 따로 본다.
import * as grpc from '@grpc/grpc-js';
import { describe, expect, test } from 'vitest';
import { mappedErrorOf } from '../src/modules/scanner-devices/adapters/grpc-ticket-scanner-devices.js';
import { ScannerDeviceDependencyUnavailable, ScannerDeviceInactive, ScannerDeviceInputRejected, ScannerDeviceKeyInUse, ScannerDeviceNotFound } from '../src/modules/scanner-devices/index.js';

const err = (code: grpc.status, details = ''): grpc.ServiceError => ({ code, details, metadata: new grpc.Metadata() }) as grpc.ServiceError;

describe('ScannerDeviceService gRPC 오류 사상 [BAT-450]', () => {
  test('NOT_FOUND·FAILED_PRECONDITION·ALREADY_EXISTS·INVALID_ARGUMENT를 각각의 오류로 옮긴다', () => {
    expect(mappedErrorOf(err(grpc.status.NOT_FOUND))).toBeInstanceOf(ScannerDeviceNotFound);
    expect(mappedErrorOf(err(grpc.status.FAILED_PRECONDITION))).toBeInstanceOf(ScannerDeviceInactive);
    expect(mappedErrorOf(err(grpc.status.ALREADY_EXISTS))).toBeInstanceOf(ScannerDeviceKeyInUse);
    expect(mappedErrorOf(err(grpc.status.INVALID_ARGUMENT, 'NAME'))).toBeInstanceOf(ScannerDeviceInputRejected);
  });

  test('그 밖의 상태·연결 실패는 503 의존성 오류로 닫는다', () => {
    expect(mappedErrorOf(err(grpc.status.INTERNAL))).toBeInstanceOf(ScannerDeviceDependencyUnavailable);
    expect(mappedErrorOf(err(grpc.status.UNAVAILABLE))).toBeInstanceOf(ScannerDeviceDependencyUnavailable);
  });
});
