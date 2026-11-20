/**
 * Audio-reactive spectrum row (feature 15). A pure renderer and the only
 * subscriber of high-rate band frames: the 20 Hz updates rerender this child
 * alone, never the App/metadata tree. No fake animation — without fresh
 * measured bands this row shows status text, not invented bars.
 */
import type { BoxRenderable } from '@opentui/core';
import { useTerminalDimensions } from '@opentui/react';
import { useAtomValue } from 'jotai';
import { useEffect, useRef, useState } from 'react';
import { spectrumFrameAtom, spectrumStatusAtom } from '../store/spectrum';
import { usePresentation } from './usePresentation';
import { useTheme } from './useTheme';

/** Single-row Unicode ramp; the same band data drives the ASCII variant. */
const UNICODE_RAMP = '▁▂▃▄▅▆▇█';
const ASCII_RAMP = ' .:-=+*#%@';
/** Below this many graph columns the row degrades to a static status. */
const MIN_GRAPH_COLUMNS = 8;

/**
 * Aggregate 32 band values into `columns` buckets without dropping peaks:
 * each bucket keeps the maximum of its neighboring bands.
 */
export function aggregateBands(values: readonly number[], columns: number): number[] {
  const buckets = new Array<number>(columns).fill(0);
  if (values.length === 0 || columns <= 0) return buckets;
  for (let band = 0; band < values.length; band++) {
    const column = Math.min(columns - 1, Math.floor((band * columns) / values.length));
    const value = values[band];
    if (Number.isFinite(value) && value > buckets[column]) buckets[column] = value;
  }
  return buckets;
}

function rampFor(value: number, ramp: string): string {
  const clamped = Math.max(0, Math.min(1, value));
  return ramp[Math.round(clamped * (ramp.length - 1))];
}

export function Spectrum() {
  const t = useTheme();
  const p = usePresentation();
  const status = useAtomValue(spectrumStatusAtom);
  const frame = useAtomValue(spectrumFrameAtom);
  const boxRef = useRef<BoxRenderable | null>(null);
  const [componentWidth, setComponentWidth] = useState(0);
  const terminal = useTerminalDimensions();

  // Actual component width from the pinned renderer's onSizeChange API, with
  // the terminal dimensions as the verified fallback until it reports.
  const syncWidth = () => {
    const measured = boxRef.current?.width ?? 0;
    setComponentWidth((current) => (current === measured ? current : measured));
  };
  useEffect(syncWidth);
  const width = componentWidth > 0 ? componentWidth : terminal.width;

  if (p.reducedMotion) return null;
  if (status.kind === 'off') return null;

  if (status.kind === 'suppressed') {
    return (
      <text fg={t.dim}>
        spectrum: {status.reason === 'reduced-motion' ? 'reduced motion' : 'paused'}
      </text>
    );
  }
  if (status.kind === 'starting' || (status.kind === 'active' && frame === null)) {
    return <text fg={t.yellow}>spectrum: starting{p.text('…')}</text>;
  }
  if (status.kind === 'unavailable') {
    return (
      <text fg={t.red} truncate>
        spectrum unavailable: {p.text(status.message)}
      </text>
    );
  }

  if (width < MIN_GRAPH_COLUMNS) {
    return <text fg={t.dim}>spectrum: terminal too narrow for a graph</text>;
  }
  const ramp = p.ascii ? ASCII_RAMP : UNICODE_RAMP;
  const buckets = aggregateBands(frame?.values ?? [], width);
  const bars = buckets.map((value) => rampFor(value, ramp)).join('');
  return (
    <box ref={boxRef} flexDirection="row" width="100%" height={1} onSizeChange={syncWidth}>
      <text fg={t.green}>{bars}</text>
    </box>
  );
}
