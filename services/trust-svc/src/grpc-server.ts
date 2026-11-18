// trust-svc 업무 gRPC 포트 시작과 닫기.
// 시작·우아한 종료(새 호출을 받지 않고 처리 중인 호출을 10초 [가정] 기다린 뒤에만 끊는다, D-T27)·호출 지표는 공용 startGrpcServer(packages/platform, BUILD_ORDER BAS-080)다.
// 부하 분산 프로필은 시작 파일이 service.config.grpcLbProfile을 넘긴다. 넘기지 않으면(시험) service 프로필이다.
// 메시 없는 로컬·CI에서는 평문이다(파드 사이 mTLS는 메시가 맡는다, ADR-0082).
import { type GrpcLbProfile, type GrpcServiceBinding, type StartedGrpcServer, type StartGrpcServerOptions, startGrpcServer as startPlatformGrpcServer } from '@peaket/platform';

export type { GrpcServiceBinding };

/** port 0이면 빈 포트를 잡고 돌려준다(시험). close는 처리 중인 호출을 10초 [가정]까지 기다리고 넘으면 끊는다 */
export function startGrpcServer(o: Omit<StartGrpcServerOptions, 'profile'> & { profile?: GrpcLbProfile }): Promise<StartedGrpcServer> {
  return startPlatformGrpcServer({ ...o, profile: o.profile ?? 'service' });
}
