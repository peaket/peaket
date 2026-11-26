// F-04-18 봇 후보 산점도(CMP-079). 정본: docs/features/forensic-replay.md §2.1·§3.6, d5 §7.17.
// 가로는 first_hold_ms 로그 눈금(10ms~10s), 세로는 entropy(0~1)다. WebGL2가 없으면 2D 표본으로 그린다.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { CandidatePoint, PointBounds } from '../lib/replay/candidate.ts';
import {
  SAMPLE_CAP,
  SCATTER_X_MAX_MS,
  SCATTER_X_MIN_MS,
  map2dLabel,
  renderPlan,
  samplePoints,
  scatterPosition,
  webgl2Available,
} from '../lib/replay/chart-runtime.ts';

const WIDTH = 440;
const HEIGHT = 260;

function drawAxes(ctx: CanvasRenderingContext2D, fallback: boolean, total: number): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(40, 12);
  ctx.lineTo(40, HEIGHT - 32);
  ctx.lineTo(WIDTH - 10, HEIGHT - 32);
  ctx.stroke();
  ctx.fillStyle = 'rgba(224,228,236,0.75)';
  ctx.font = '10px sans-serif';
  const ticks: readonly [number, string][] = [
    [10, '10ms'],
    [100, '100ms'],
    [1_000, '1s'],
    [10_000, '10s'],
  ];
  for (const [value, label] of ticks) {
    const u = scatterPosition(value, 0).u;
    const x = 40 + u * (WIDTH - 50);
    ctx.fillText(label, x - 12, HEIGHT - 18);
  }
  for (const value of [0, 0.5, 1]) {
    const v = scatterPosition(10, value).v;
    const y = HEIGHT - 32 - v * (HEIGHT - 44);
    ctx.fillText(String(value), 14, y + 3);
  }
  if (fallback) ctx.fillText(`표본 ${Math.min(total, SAMPLE_CAP).toLocaleString('ko-KR')}점`, 46, 20);
  ctx.restore();
}

function draw2dPoints(ctx: CanvasRenderingContext2D, points: readonly CandidatePoint[]): void {
  ctx.save();
  ctx.fillStyle = 'rgba(122,167,255,0.55)';
  for (const point of points) {
    const { u, v } = scatterPosition(point.x, point.y);
    if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
    const x = 40 + u * (WIDTH - 50);
    const y = HEIGHT - 32 - v * (HEIGHT - 44);
    ctx.beginPath();
    ctx.arc(x, y, point.bot ? 2.8 : 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (shader === null) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function drawWebgl2(canvas: HTMLCanvasElement, points: readonly CandidatePoint[]): boolean {
  const gl = canvas.getContext('webgl2');
  if (gl === null) return false;
  const vertex = compileShader(
    gl,
    gl.VERTEX_SHADER,
    '#version 300 es\nin vec2 position;\nvoid main(){ gl_Position = vec4(position, 0.0, 1.0); gl_PointSize = 2.6; }',
  );
  const fragment = compileShader(
    gl,
    gl.FRAGMENT_SHADER,
    '#version 300 es\nprecision mediump float;\nout vec4 color;\nvoid main(){ color = vec4(0.48, 0.65, 1.0, 0.62); }',
  );
  if (vertex === null || fragment === null) return false;
  const program = gl.createProgram();
  if (program === null) return false;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) return false;

  const positions: number[] = [];
  for (const point of points) {
    const { u, v } = scatterPosition(point.x, point.y);
    if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
    positions.push(u * 2 - 1, v * 2 - 1);
  }
  const buffer = gl.createBuffer();
  if (buffer === null) return false;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
  const location = gl.getAttribLocation(program, 'position');
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0.09, 0.1, 0.13, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(program);
  gl.drawArrays(gl.POINTS, 0, positions.length / 2);
  return true;
}

function toX(pixel: number): number {
  const position = Math.max(0, Math.min(1, (pixel - 40) / (WIDTH - 50)));
  return SCATTER_X_MIN_MS * (SCATTER_X_MAX_MS / SCATTER_X_MIN_MS) ** position;
}

function toY(pixel: number): number {
  const position = Math.max(0, Math.min(1, (HEIGHT - 32 - pixel) / (HEIGHT - 44)));
  return position;
}

export function ScatterPlot({
  points,
  onSelect,
}: {
  points: readonly CandidatePoint[];
  onSelect: (bounds: PointBounds | null) => void;
}) {
  const pointCanvas = useRef<HTMLCanvasElement | null>(null);
  const labelCanvas = useRef<HTMLCanvasElement | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    const pointElement = pointCanvas.current;
    const labelElement = labelCanvas.current;
    if (pointElement === null || labelElement === null) return;
    const ctx = labelElement.getContext('2d');
    if (ctx === null) return;
    const webgl = webgl2Available(pointElement);
    setFallback(!webgl);
    const plan = renderPlan(points.length, webgl);
    const sampled = samplePoints(points, plan);
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    if (!webgl || !drawWebgl2(pointElement, sampled)) draw2dPoints(ctx, sampled);
    drawAxes(ctx, !webgl, points.length);
  }, [points]);

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    dragStart.current = {
      x: ((event.clientX - rect.left) / rect.width) * WIDTH,
      y: ((event.clientY - rect.top) / rect.height) * HEIGHT,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const start = dragStart.current;
    dragStart.current = null;
    if (start === null) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const end = {
      x: ((event.clientX - rect.left) / rect.width) * WIDTH,
      y: ((event.clientY - rect.top) / rect.height) * HEIGHT,
    };
    if (Math.abs(end.x - start.x) < 4 || Math.abs(end.y - start.y) < 4) {
      onSelect(null);
      return;
    }
    const x0 = toX(Math.min(start.x, end.x));
    const x1 = toX(Math.max(start.x, end.x));
    const y0 = toY(Math.max(start.y, end.y));
    const y1 = toY(Math.min(start.y, end.y));
    onSelect({ x0, x1, y0, y1 });
  };

  return (
    <div className="col" style={{ gap: 4 }}>
      <div style={{ position: 'relative', width: '100%' }}>
        <canvas
          ref={pointCanvas}
          width={WIDTH}
          height={HEIGHT}
          aria-hidden="true"
          style={{ display: 'block', width: '100%', height: 'auto', borderRadius: 6, background: '#171a21' }}
        />
        <canvas
          ref={labelCanvas}
          width={WIDTH}
          height={HEIGHT}
          role="img"
          aria-label={`봇 후보 산점도. 가로는 입장 확정에서 첫 홀드 시도까지(10ms~10s 로그 눈금), 세로는 포인터 이동 엔트로피입니다. 점 ${points.length.toLocaleString('ko-KR')}개.`}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          style={{ position: 'absolute', inset: 0, width: '100%', height: 'auto', touchAction: 'none' }}
        />
      </div>
      {fallback ? <p className="t-xs muted">{map2dLabel()}</p> : null}
    </div>
  );
}
