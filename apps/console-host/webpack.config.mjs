// 관제 콘솔 호스트 빌드(docs/frontend.md §2.3, add-screen-publishing design.md 결정 6).
// Module Federation은 아직 붙이지 않는다. 위젯은 workspace 패키지(@peaket/widget-*)로 한 앱에 넣는다(한 앱 기준선, ADR-0100 결정 6).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import webpack from 'webpack';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default (_env, argv) => {
  const dev = argv.mode !== 'production';
  // SEED CSS 층 PoC 빌드(FE-T36, tools/web-checks/seed-css/)는 탐침 화면(poc-seed-css.html) 하나만 묶는다(운영 빌드처럼 진입점 하나)
  const seedCssPoc = process.env.PEAKET_POC === 'seed-css';
  return {
    mode: dev ? 'development' : 'production',
    entry: seedCssPoc ? { 'poc-seed-css': path.join(dirname, 'src/poc-seed-css.tsx') } : { main: path.join(dirname, 'src/main.tsx') },
    output: {
      path: path.join(dirname, 'dist'),
      filename: dev ? '[name].js' : 'assets/[name].[contenthash:8].js',
      chunkFilename: dev ? '[name].chunk.js' : 'assets/[name].[contenthash:8].chunk.js',
      publicPath: '/',
      clean: true,
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
        {
          test: /\.[cm]?[jt]sx?$/,
          exclude: /node_modules/,
          loader: 'esbuild-loader',
          options: { target: 'es2022', jsx: 'automatic' },
        },
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
      new webpack.DefinePlugin({ __PREVIEW__: JSON.stringify(dev) }),
      ...(dev ? [] : [new MiniCssExtractPlugin({ filename: 'assets/[name].[contenthash:8].css', chunkFilename: 'assets/[name].[contenthash:8].chunk.css' })]),
    ],
    devServer: {
      port: 3002,
      historyApiFallback: true,
      hot: true,
      client: { overlay: { warnings: false, errors: true } },
    },
    performance: { hints: false },
  };
};
