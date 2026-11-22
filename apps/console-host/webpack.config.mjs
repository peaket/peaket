// 관제 콘솔 호스트 빌드(docs/frontend.md §2.3·§4.5, add-screen-publishing design.md 결정 6, ADR-0100 결정 6, ADR-0360, ADR-0361).
// 기본 빌드는 Module Federation이다: 호스트 하나와 원격 둘(대기열 팀 apps/widgets/queue, 구매 팀 apps/widgets/purchase)을 따로 컴파일한다.
// 원격은 한 파일(remoteEntry.js 하나에 노출 모듈·위젯 덩어리까지, LimitChunkCountPlugin)로 같은 출처 /remotes/<이름>/<sha>/remoteEntry.js에 나간다
// (dist/remotes/<이름>/<sha>/). 빌드 뒤 scripts/remotes-manifest.mjs가 sha384를 계산해 dist/remotes.json(원격 목록)을 쓰고, 호스트는 실행 중에
// 그 목록을 읽어 무결성 값을 붙인 스크립트로 진입 파일을 받는다(src/shared/lib/remotes/, Trusted Types 정책 peaket-remote). webpack 5 내장 ModuleFederationPlugin을 쓴다.
// 원격 하나만 빌드: webpack --mode production --config-name remote-<이름> 뒤 node scripts/remotes-manifest.mjs --remote <이름>(공용 워크플로 build-remote.yml).
// 공유 싱글턴은 원격이 실제로 가져오는 것만 선언한다(react·react-dom·react/jsx-runtime·@peaket/console-contract, ADR-0361 결정 7). 원격은 대체본 없이(import: false)
// 호스트 것만 쓰고, 호스트는 원격 한 파일이 동기로 가져가도록 셋을 첫 덩어리(eager)로 내놓는다. 계약 패키지만 strictVersion이다.
// PEAKET_CONSOLE_BUILD=single이면 한 앱 기준선(FE-T29): 원격 없이 같은 위젯 소스를 작업 공간 패키지로 묶는다.
// 헤더: 개발 서버는 묶음 C CSP와 Trusted Types를 보고 모드로(eval 소스 맵·HMR 웹소켓 때문), 미리보기 서버(scripts/preview-server.mjs)는 운영 빌드에 묶음 C를 막는 모드로 붙인다.
// 개발 서버도 /remotes.json을 그 순간의 원격 바이트로 계산해 내준다(무결성을 끄는 개발 갈래는 없다, ADR-0361 결정 4).
// Trusted Types 정책 이름: 호스트 peaket-webpack-host, 원격 peaket-webpack-queue·peaket-webpack-purchase(§5.14.1 'Trusted Types' 허용 목록).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import webpack from 'webpack';
import { renderCsp, trustedTypesReportOnly, REPORTING_ENDPOINTS, PAGE_HEADERS } from '@peaket/config/headers/security-headers.mjs';
import { opsProxyMiddleware } from './scripts/ops-proxy.mjs';
import { CONTRACT_MAJOR, contractVersion, remoteSha, remotesJsonMiddleware } from './scripts/remotes-manifest.mjs';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const require = (await import('node:module')).createRequire(import.meta.url);
const pkg = require('./package.json');

/** 원격 둘(이름 → 원천 폴더). 컨테이너 이름은 src/shared/lib/remotes/remote-list.ts REMOTE_CONTAINERS와 같다 */
export const REMOTES = {
  queue: { dir: path.join(dirname, '../widgets/queue'), container: 'peaket_widget_queue' },
  purchase: { dir: path.join(dirname, '../widgets/purchase'), container: 'peaket_widget_purchase' },
};

/** 계약 패키지 판 범위(큰 수가 CONTRACT_MAJOR, strictVersion으로 맞춘다) */
const CONTRACT_RANGE = `^${CONTRACT_MAJOR}.0.0`;

/**
 * 호스트가 내놓는 공유 싱글턴(원격이 실제로 가져오는 것만, ADR-0361 결정 7). react·react/jsx-runtime·계약 패키지는 첫 덩어리(eager)로 내놓아
 * 원격 한 파일이 동기로 가져가게 한다(원격의 노출 모듈이 진입 파일 안에 있어 공유 모듈을 기다리지 못한다)
 */
function hostShared() {
  const v = pkg.dependencies;
  return {
    react: { singleton: true, eager: true, requiredVersion: v.react },
    'react/jsx-runtime': { singleton: true, eager: true, requiredVersion: v.react },
    'react-dom': { singleton: true, requiredVersion: v['react-dom'] },
    '@peaket/console-contract': { singleton: true, eager: true, strictVersion: true, requiredVersion: CONTRACT_RANGE, version: contractVersion() },
  };
}

/** 원격이 가져가는 공유 싱글턴: 대체본 없이(import: false) 호스트 것만 쓴다. 계약 패키지 판이 범위 밖이면 그 원격만 실패한다 */
function remoteShared() {
  const v = pkg.dependencies;
  return {
    react: { import: false, singleton: true, requiredVersion: v.react },
    'react/jsx-runtime': { import: false, singleton: true, requiredVersion: v.react },
    'react-dom': { import: false, singleton: true, requiredVersion: v['react-dom'] },
    '@peaket/console-contract': { import: false, singleton: true, strictVersion: true, requiredVersion: process.env.PEAKET_REMOTE_CONTRACT_RANGE || CONTRACT_RANGE },
  };
}

function jsRule() {
  return {
    test: /\.[cm]?[jt]sx?$/,
    exclude: /node_modules/,
    loader: 'esbuild-loader',
    options: { target: 'es2022', jsx: 'automatic' },
  };
}

/** 원격 하나의 빌드(노출 ./widgets = src/remote.ts). 산출물은 dist/remotes/<이름>/<sha>/remoteEntry.js 한 파일(숨김 소스 맵은 maps/ 아래) */
function remoteConfig(name, dev) {
  const r = REMOTES[name];
  const sha = remoteSha(name);
  return {
    name: `remote-${name}`,
    mode: dev ? 'development' : 'production',
    context: r.dir,
    entry: {},
    output: {
      path: path.join(dirname, 'dist/remotes', name),
      // 한 파일이라 컨테이너 진입 덩어리가 output.filename을 따른다
      filename: `${sha}/remoteEntry.js`,
      chunkFilename: `${sha}/[name].chunk.js`,
      sourceMapFilename: 'maps/[file].map',
      publicPath: `/remotes/${name}/`,
      uniqueName: r.container,
      clean: true,
      trustedTypes: { policyName: `peaket-webpack-${name}` },
    },
    devtool: dev ? 'eval-cheap-module-source-map' : 'hidden-source-map',
    resolve: { extensions: ['.tsx', '.ts', '.js', '.mjs'], conditionNames: ['seed-layered', 'import', 'module', 'browser', 'default'] },
    // 로더는 이 빌드 설정의 작업 공간(console-host)에서 찾는다. 원격 빌드를 팀 저장소로 옮길 때 그 저장소 의존으로 바꾼다(공용 워크플로 build-remote.yml)
    resolveLoader: { modules: [path.join(dirname, 'node_modules'), 'node_modules'] },
    module: { rules: [jsRule()] },
    plugins: [
      new webpack.container.ModuleFederationPlugin({
        name: r.container,
        filename: `${sha}/remoteEntry.js`,
        exposes: { './widgets': path.join(r.dir, 'src/remote.ts') },
        shared: remoteShared(),
      }),
      // 한 파일: 진입 파일의 sha384가 원격 코드 전부를 덮는다(원격 런타임이 따로 받는 덩어리에는 무결성이 없다, ADR-0361 결정 2)
      new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 }),
    ],
    performance: { hints: false },
  };
}

/** 개발 서버 헤더(묶음 C와 Trusted Types를 보고 모드로) */
function devHeaders(opsApi) {
  const origins = opsApi ? { opsApi } : {};
  return {
    'Content-Security-Policy-Report-Only': `${renderCsp('C', { origins })}, ${trustedTypesReportOnly(Object.keys(REMOTES))}`,
    'Reporting-Endpoints': REPORTING_ENDPOINTS,
    ...PAGE_HEADERS.console,
  };
}

export default (_env, argv) => {
  const dev = argv.mode !== 'production';
  // SEED CSS 층 PoC 빌드(FE-T36, tools/web-checks/seed-css/)는 탐침 화면(poc-seed-css.html) 하나만 묶는다(운영 빌드처럼 진입점 하나)
  const seedCssPoc = process.env.PEAKET_POC === 'seed-css';
  const single = seedCssPoc || process.env.PEAKET_CONSOLE_BUILD === 'single';
  const opsApi = process.env.PEAKET_OPS_API_ORIGIN || (dev ? 'http://localhost:8080' : 'https://ops-api.peaket.example');
  const host = {
    name: 'host',
    mode: dev ? 'development' : 'production',
    entry: seedCssPoc ? { 'poc-seed-css': path.join(dirname, 'src/poc-seed-css.tsx') } : { main: path.join(dirname, 'src/main.tsx') },
    output: {
      path: path.join(dirname, 'dist'),
      filename: dev ? '[name].js' : 'assets/[name].[contenthash:8].js',
      chunkFilename: dev ? '[name].chunk.js' : 'assets/[name].[contenthash:8].chunk.js',
      publicPath: '/',
      uniqueName: 'peaket_console_host',
      // 원격 산출물(dist/remotes)은 원격 빌드가 지운다
      clean: single ? true : { keep: /^remotes[\\/]/ },
      trustedTypes: { policyName: 'peaket-webpack-host' },
    },
    devtool: dev ? 'eval-cheap-module-source-map' : 'hidden-source-map', // 운영은 링크 없는 숨김 소스 맵(frontend §5.18, FE-T21)
    resolve: {
      extensions: ['.tsx', '.ts', '.js', '.mjs'],
      // SEED 부품 CSS의 층 판을 고른다(d2 §1 'CSS 층 순서')
      conditionNames: ['seed-layered', 'import', 'module', 'browser', 'default'],
      alias: { '@': path.join(dirname, 'src') },
    },
    module: {
      rules: [
        jsRule(),
        {
          test: /\.css$/,
          use: [
            dev ? 'style-loader' : MiniCssExtractPlugin.loader,
            { loader: 'css-loader', options: { importLoaders: 1 } },
            { loader: 'postcss-loader', options: { postcssOptions: { plugins: { '@tailwindcss/postcss': {} } } } },
          ],
        },
      ],
    },
    plugins: [
      seedCssPoc
        ? new HtmlWebpackPlugin({ filename: 'poc-seed-css.html', template: path.join(dirname, 'src/poc-seed-css.html') })
        : new HtmlWebpackPlugin({ template: path.join(dirname, 'src/index.html') }),
      // 화면 목록(/preview)은 개발 서버에서만 연다(design.md 결정 7)
      new webpack.DefinePlugin({
        __PREVIEW__: JSON.stringify(dev),
        __OPS_API_ORIGIN__: JSON.stringify(opsApi),
        __SCANNER_ORIGIN__: JSON.stringify(process.env.PEAKET_SCANNER_ORIGIN || (dev ? 'http://localhost:3003' : 'https://scanner.peaket.example')),
        __CONSOLE_BUILD__: JSON.stringify(single ? 'single' : 'mf'),
      }),
      ...(single
        ? []
        : [
            new webpack.container.ModuleFederationPlugin({ name: 'peaket_console_host', shared: hostShared() }),
            // 위젯 소스를 호스트 묶음에 넣지 않는다(원격이 싣는다)
            new webpack.NormalModuleReplacementPlugin(/[\\/]local-widgets$/, (r) => {
              r.request = r.request.replace(/local-widgets$/, 'local-widgets.stub');
            }),
          ]),
      ...(dev ? [] : [new MiniCssExtractPlugin({ filename: 'assets/[name].[contenthash:8].css', chunkFilename: 'assets/[name].[contenthash:8].chunk.css' })]),
    ],
    devServer: {
      port: 3002,
      historyApiFallback: true,
      hot: true,
      client: { overlay: { warnings: false, errors: true } },
      headers: devHeaders(opsApi),
      // 실제 ops-svc(로컬)에 붙이기: PEAKET_OPS_PROXY_TARGET을 주면 /v1/ops/를 그리로 넘긴다(local·ci 전용, apps/README.md)
      setupMiddlewares: (middlewares, server) => {
        const proxy = opsProxyMiddleware(process.env);
        if (proxy) middlewares.unshift({ name: 'peaket-ops-proxy', path: '/v1/ops', middleware: proxy });
        // 원격 목록: 메모리에 빌드한 원격 바이트로 그 순간의 sha384를 계산한다(운영과 같은 무결성 확인 길)
        if (!single) middlewares.unshift({ name: 'peaket-remotes-json', path: '/remotes.json', middleware: remotesJsonMiddleware(server, path.join(dirname, 'dist')) });
        return middlewares;
      },
    },
    performance: { hints: false },
  };
  return single ? host : [host, remoteConfig('queue', dev), remoteConfig('purchase', dev)];
};
