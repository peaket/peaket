// 운영 묶음에 드는 대역: 데모 SIMULATOR 결제창 코드가 묶음에 들지 않게 한다(FE-T21, ADR-0253). next.config의 별칭이 빌드 값에 따라 고른다.
export function simulatorWindow(): never {
  throw new Error('이 빌드에는 데모 결제창이 없다');
}
