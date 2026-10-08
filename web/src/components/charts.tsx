import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n';

/*
 * Hand-written SVG charts. Rules (see docs/DESIGN.md):
 *  - categorical slots in a fixed order, validated for colour-vision deficiency in light and dark;
 *  - thin bars (≤ 24px) with 4px rounded data ends and 2px surface gaps between segments;
 *  - a legend whenever there are two or more series, hover/focus tooltips, and a table view,
 *    so identity never depends on colour alone;
 *  - every mark is a button that opens the underlying records.
 */
export interface Series {
  key: string;
  label: string;
  color: string; // CSS variable reference, e.g. var(--series-1)
}

export interface StackRow {
  key: string;
  label: string;
  values: Record<string, number>;
}

function niceMax(v: number) {
  if (v <= 5) return 5;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function Legend({ series }: { series: Series[] }) {
  return (
    <div className="legend" aria-hidden="true">
      {series.map((s) => (
        <span key={s.key}>
          <span className="key" style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

function ChartTable({ caption, rows, series, rowHeader }: { caption: string; rows: StackRow[]; series: Series[]; rowHeader: string }) {
  const { number } = useI18n();
  return (
    <div className="table-wrap">
      <table className="data">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{rowHeader}</th>
            {series.map((s) => (
              <th key={s.key} scope="col" className="num">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row" style={{ textAlign: 'left', fontWeight: 500 }}>
                {r.label}
              </th>
              {series.map((s) => (
                <td key={s.key} className="num">
                  {number(r.values[s.key] ?? 0)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Rounded only at the data end: right side for horizontal bars, top for columns. */
function endRoundedRect(x: number, y: number, w: number, h: number, r: number, horizontal: boolean) {
  r = Math.min(r, horizontal ? w : h, horizontal ? h / 2 : w / 2);
  if (w <= 0 || h <= 0) return '';
  if (horizontal) return `M${x},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 -${r},${r}h-${w - r}z`;
  return `M${x},${y + h}v-${h - r}a${r},${r} 0 0 1 ${r},-${r}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${h - r}z`;
}

interface Hover {
  row: StackRow;
  x: number;
  y: number;
}

/** Horizontal stacked bars: one row per category, segments per series. */
export function StackedBars({ rows, series, caption, onSelect, rowHeader }: { rows: StackRow[]; series: Series[]; caption: string; onSelect: (row: StackRow, series: Series) => void; rowHeader: string }) {
  const { t, number } = useI18n();
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<Hover | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const labelW = 150;
  const W = 640;
  const barH = 20;
  const rowH = 36;
  const top = 8;
  const max = niceMax(Math.max(1, ...rows.map((r) => series.reduce((n, s) => n + (r.values[s.key] ?? 0), 0))));
  const plotW = W - labelW - 40;
  const H = top + rows.length * rowH + 24;
  const ticks = [0, max / 2, max];
  const sx = (v: number) => (v / max) * plotW;

  return (
    <div className="chart" ref={wrap}>
      <div className="row between" style={{ marginBottom: 6 }}>
        <Legend series={series} />
        <button className="btn ghost sm" onClick={() => setTable(!table)} aria-pressed={table}>
          {table ? t('common.showChart') : t('common.showTable')}
        </button>
      </div>
      {table ? (
        <ChartTable caption={caption} rows={rows} series={series} rowHeader={rowHeader} />
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label={caption} onMouseLeave={() => setHover(null)}>
          {ticks.map((v) => (
            <g key={v}>
              <line className="gridline" x1={labelW + sx(v)} x2={labelW + sx(v)} y1={top} y2={H - 22} />
              <text className="tick" x={labelW + sx(v)} y={H - 6} textAnchor="middle">
                {number(v)}
              </text>
            </g>
          ))}
          {rows.map((r, i) => {
            const y = top + i * rowH + (rowH - barH) / 2;
            let x = labelW;
            const present = series.filter((s) => (r.values[s.key] ?? 0) > 0);
            const total = present.reduce((n, s) => n + r.values[s.key], 0);
            return (
              <g key={r.key} onMouseEnter={() => setHover({ row: r, x: labelW + sx(total), y })}>
                <text x={labelW - 10} y={y + barH / 2 + 4} textAnchor="end" style={{ fontSize: 12.5, fill: 'var(--text-2)' }}>
                  {r.label}
                </text>
                {present.map((s, j) => {
                  const w = sx(r.values[s.key]);
                  const gap = j < present.length - 1 ? 2 : 0; // 2px surface gap between segments
                  const last = j === present.length - 1;
                  const d = last ? endRoundedRect(x, y, Math.max(w - gap, 1), barH, 4, true) : `M${x},${y}h${Math.max(w - gap, 1)}v${barH}h-${Math.max(w - gap, 1)}z`;
                  const el = (
                    <path
                      key={s.key}
                      className="mark"
                      d={d}
                      fill={s.color}
                      tabIndex={0}
                      role="button"
                      aria-label={`${r.label}, ${s.label}: ${number(r.values[s.key])}`}
                      onClick={() => onSelect(r, s)}
                      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(r, s))}
                      onFocus={() => setHover({ row: r, x: labelW + sx(total), y })}
                    />
                  );
                  x += w;
                  return el;
                })}
                <text x={labelW + sx(total) + 6} y={y + barH / 2 + 4} style={{ fontSize: 12, fill: 'var(--text-2)', fontVariantNumeric: 'tabular-nums' }}>
                  {number(total)}
                </text>
              </g>
            );
          })}
          <line className="baseline" x1={labelW} x2={labelW} y1={top} y2={H - 22} />
        </svg>
      )}
      {hover && !table && <Tip wrap={wrap} x={hover.x} y={hover.y} W={W} H={H} title={hover.row.label} rows={series.map((s) => [s, hover.row.values[s.key] ?? 0] as const)} />}
    </div>
  );
}

/** Vertical stacked columns over time (weeks). */
export function StackedColumns({ rows, series, caption, onSelect, rowHeader }: { rows: StackRow[]; series: Series[]; caption: string; onSelect?: (row: StackRow, s: Series) => void; rowHeader: string }) {
  const { t, number } = useI18n();
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<Hover | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const W = 640;
  const H = 220;
  const left = 34;
  const bottom = 30;
  const top = 10;
  const plotW = W - left - 8;
  const plotH = H - top - bottom;
  const max = niceMax(Math.max(1, ...rows.map((r) => series.reduce((n, s) => n + (r.values[s.key] ?? 0), 0))));
  const band = plotW / Math.max(rows.length, 1);
  const barW = Math.min(24, band * 0.6);
  const sy = (v: number) => (v / max) * plotH;
  const ticks = [0, max / 2, max];
  return (
    <div className="chart" ref={wrap}>
      <div className="row between" style={{ marginBottom: 6 }}>
        <Legend series={series} />
        <button className="btn ghost sm" onClick={() => setTable(!table)} aria-pressed={table}>
          {table ? t('common.showChart') : t('common.showTable')}
        </button>
      </div>
      {table ? (
        <ChartTable caption={caption} rows={rows} series={series} rowHeader={rowHeader} />
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label={caption} onMouseLeave={() => setHover(null)}>
          {ticks.map((v) => (
            <g key={v}>
              <line className="gridline" x1={left} x2={W - 8} y1={top + plotH - sy(v)} y2={top + plotH - sy(v)} />
              <text className="tick" x={left - 6} y={top + plotH - sy(v) + 4} textAnchor="end">
                {number(v)}
              </text>
            </g>
          ))}
          {rows.map((r, i) => {
            const x = left + i * band + (band - barW) / 2;
            let y = top + plotH;
            const present = series.filter((s) => (r.values[s.key] ?? 0) > 0);
            const total = present.reduce((n, s) => n + r.values[s.key], 0);
            return (
              <g key={r.key} onMouseEnter={() => setHover({ row: r, x: x + barW / 2, y: top + plotH - sy(total) })}>
                {present.map((s, j) => {
                  const h = sy(r.values[s.key]);
                  const gap = j < present.length - 1 ? 2 : 0;
                  const last = j === present.length - 1;
                  y -= h;
                  const d = last ? endRoundedRect(x, y, barW, Math.max(h, 1), 4, false) : `M${x},${y + gap}h${barW}v${Math.max(h - gap, 1)}h-${barW}z`;
                  return (
                    <path
                      key={s.key}
                      className="mark"
                      d={d}
                      fill={s.color}
                      tabIndex={onSelect ? 0 : -1}
                      role={onSelect ? 'button' : 'img'}
                      aria-label={`${r.label}, ${s.label}: ${number(r.values[s.key])}`}
                      onClick={() => onSelect?.(r, s)}
                      onFocus={() => setHover({ row: r, x: x + barW / 2, y: top + plotH - sy(total) })}
                    />
                  );
                })}
                <text className="tick" x={x + barW / 2} y={H - 10} textAnchor="middle">
                  {r.label}
                </text>
              </g>
            );
          })}
          <line className="baseline" x1={left} x2={W - 8} y1={top + plotH} y2={top + plotH} />
        </svg>
      )}
      {hover && !table && <Tip wrap={wrap} x={hover.x} y={hover.y} W={W} H={H} title={hover.row.label} rows={series.map((s) => [s, hover.row.values[s.key] ?? 0] as const)} />}
    </div>
  );
}

function Tip({ wrap, x, y, W, H, title, rows }: { wrap: React.RefObject<HTMLDivElement | null>; x: number; y: number; W: number; H: number; title: ReactNode; rows: readonly (readonly [Series, number])[] }) {
  const { number } = useI18n();
  const box = wrap.current?.getBoundingClientRect();
  const scale = box ? box.width / W : 1;
  const left = Math.min(x * scale + 12, (box?.width ?? W) - 170);
  const top = Math.max(y * scale - 10, 0) + 30;
  void H;
  return (
    <div className="tooltip" style={{ left, top }} role="status">
      <div className="t">{title}</div>
      {rows.map(([s, v]) => (
        <div className="r" key={s.key}>
          <span>
            <span className="key" style={{ background: s.color, width: 8, height: 8, borderRadius: 2, display: 'inline-block', marginRight: 6 }} />
            {s.label}
          </span>
          <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{number(v)}</strong>
        </div>
      ))}
    </div>
  );
}

export function useStableSeries(series: Series[]) {
  return useMemo(() => series, [JSON.stringify(series)]); // eslint-disable-line react-hooks/exhaustive-deps
}
