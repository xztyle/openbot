/**
 * The dot grid of a canvas, as on the Higgsfield canvas, and the screen offsets of its world. The
 * workflow canvas and the org chart share them.
 */

import type { JSX } from "@solidjs/web";
import { createMemo, createUniqueId } from "solid-js";
import type { Camera } from "./workflow-camera";

/** The step of the grid at 100%, in world pixels. */
export const GRID = 20;

/** Smooth Hermite step from 0 to 1 while the value goes from `from` to `to`. */
function smoothstep(from: number, to: number, value: number) {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

/**
 * The dot grid follows the Higgsfield canvas. A dot is 1 screen pixel at every zoom. Above 100% the
 * dots spread with the zoom. Below it, each halving of the zoom doubles the world step, so the screen
 * step stays between one and two grid steps; the dots of the half step fade in as they spread from
 * two thirds of a grid step to a full one. One dot in each tile is on the world origin.
 */
function dotGrid(camera: Camera) {
  const level = Math.max(0, Math.ceil(Math.log2(1 / camera.scale) - 1e-9));
  const step = GRID * 2 ** level * camera.scale;
  const quarter = step / 4;
  const wrap = (value: number) => (((value - quarter) % step) + step) % step;
  return {
    x: wrap(camera.x),
    y: wrap(camera.y),
    step,
    quarter,
    minor: level === 0 ? 0 : smoothstep((GRID * 2) / 3, GRID, step / 2),
  };
}

export function DotGrid(props: { camera: Camera }): JSX.Element {
  const id = createUniqueId();
  const grid = createMemo(() => dotGrid(props.camera));
  const far = () => grid().quarter * 3;
  return (
    <svg class="wfn-dots" aria-hidden="true">
      <pattern id={id} x={grid().x} y={grid().y} width={grid().step} height={grid().step} patternUnits="userSpaceOnUse">
        <circle cx={grid().quarter} cy={grid().quarter} r="1" />
        <g opacity={grid().minor}>
          <circle cx={far()} cy={grid().quarter} r="1" />
          <circle cx={grid().quarter} cy={far()} r="1" />
          <circle cx={far()} cy={far()} r="1" />
        </g>
      </pattern>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}

/** A screen offset on a whole device pixel. On a half pixel, the icons and text of the world blur. */
export const devicePixel = (value: number) => Math.round(value * window.devicePixelRatio) / window.devicePixelRatio;
