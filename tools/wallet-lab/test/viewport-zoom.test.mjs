import assert from "node:assert/strict";
import test from "node:test";
import { MAX_GRAPH_ZOOM, MIN_GRAPH_ZOOM, zoomScrollAtPoint, zoomTransformAtPoint } from "../ui/viewport-zoom.mjs";

test("canvas zoom keeps the graph coordinate under the mouse stationary", () => {
  const point = { x: 420, y: 260 };
  const before = { x: 35, y: -20, scale: 1 };
  const graphPoint = { x: (point.x - before.x) / before.scale, y: (point.y - before.y) / before.scale };
  const after = zoomTransformAtPoint(before, 1.4, point);

  assert.equal(after.x + graphPoint.x * after.scale, point.x);
  assert.equal(after.y + graphPoint.y * after.scale, point.y);
});

test("scrollable lifecycle zoom preserves the content under the mouse", () => {
  const point = { x: 300, y: 180 };
  const before = { scrollLeft: 480, scrollTop: 90, zoom: 1 };
  const worldPoint = { x: (before.scrollLeft + point.x) / before.zoom, y: (before.scrollTop + point.y) / before.zoom };
  const after = zoomScrollAtPoint(before, 1.5, point);

  assert.equal((after.scrollLeft + point.x) / after.zoom, worldPoint.x);
  assert.equal((after.scrollTop + point.y) / after.zoom, worldPoint.y);
});

test("wheel zoom clamps hostile or excessive scale input", () => {
  assert.equal(zoomTransformAtPoint({ x: 0, y: 0, scale: 1 }, 99).scale, MAX_GRAPH_ZOOM);
  assert.equal(zoomScrollAtPoint({ scrollLeft: 0, scrollTop: 0, zoom: 1 }, -10, { x: 0, y: 0 }).zoom, MIN_GRAPH_ZOOM);
});
