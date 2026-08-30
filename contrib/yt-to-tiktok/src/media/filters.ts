export type VerticalMode = "blur" | "crop" | "pad";

/**
 * FFmpeg colours are permissive (names, #rrggbb, 0xRRGGBB@alpha). The value
 * lands inside a filtergraph string, so anything that could terminate a filter
 * and start another - commas, semicolons, brackets, quotes - is rejected.
 */
const SAFE_COLOR = /^[A-Za-z0-9#@.]{1,32}$/;

export function assertSafeColor(color: string): string {
  if (!SAFE_COLOR.test(color)) {
    throw new Error(
      `Unsafe PAD_COLOR ${JSON.stringify(color)}: expected a plain colour name or hex value`
    );
  }
  return color;
}

export interface VerticalFilterOptions {
  mode: VerticalMode;
  width: number;
  height: number;
  padColor?: string;
  blurSigma?: number;
}

/**
 * Builds the video half of the filtergraph, ending in a labelled `[v]` pad.
 *
 * `blur` keeps the whole frame visible over a filled, blurred copy of itself -
 * the standard way to move 16:9 to 9:16 without losing the edges of the shot.
 * `crop` fills the frame and loses the sides. `pad` letterboxes onto a flat
 * colour.
 */
export function buildVerticalVideoFilter(opts: VerticalFilterOptions): string {
  const { mode, width: w, height: h } = opts;
  const sigma = opts.blurSigma ?? 20;

  switch (mode) {
    case "crop":
      return `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,format=yuv420p[v]`;

    case "pad": {
      const color = assertSafeColor(opts.padColor ?? "black");
      return (
        `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${color},setsar=1,format=yuv420p[v]`
      );
    }

    case "blur":
    default:
      return (
        `[0:v]split=2[bgsrc][fgsrc];` +
        `[bgsrc]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},` +
        `gblur=sigma=${sigma},eq=brightness=-0.08[bg];` +
        `[fgsrc]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg];` +
        `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[v]`
      );
  }
}

export interface LoudnormTargets {
  i: number;
  tp: number;
  lra: number;
}

export interface LoudnormMeasured {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

/** Pass-1 analysis filter: measures the source without producing output. */
export function buildLoudnormAnalysisFilter(t: LoudnormTargets): string {
  return `loudnorm=I=${t.i}:TP=${t.tp}:LRA=${t.lra}:print_format=json`;
}

/**
 * Pass-2 filter. With measurements it runs linear (transparent gain), which
 * preserves dynamics; without them it falls back to the dynamic single-pass
 * mode, which is the correct behaviour for silent or unmeasurable audio.
 */
export function buildLoudnormApplyFilter(
  t: LoudnormTargets,
  measured?: LoudnormMeasured | null
): string {
  const base = `loudnorm=I=${t.i}:TP=${t.tp}:LRA=${t.lra}`;
  if (!measured || !isMeasurable(measured)) return base;
  return (
    `${base}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}` +
    `:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}` +
    `:offset=${measured.target_offset}:linear=true`
  );
}

/**
 * Digital silence measures as -inf, and feeding that back as `measured_I`
 * makes pass 2 fail. Treat any non-finite measurement as unusable.
 */
export function isMeasurable(m: LoudnormMeasured): boolean {
  return [m.input_i, m.input_tp, m.input_lra, m.input_thresh, m.target_offset].every((v) => {
    const n = Number(v);
    return Number.isFinite(n);
  });
}
