export const MIN_GRAPH_ZOOM = 0.65;
export const MAX_GRAPH_ZOOM = 1.8;

export function clampGraphZoom(value) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_GRAPH_ZOOM, Math.max(MIN_GRAPH_ZOOM, Number(value.toFixed(2))));
}

export function zoomTransformAtPoint(transform, nextScale, point = null) {
  const scale = clampGraphZoom(nextScale);
  if (!point || scale === transform.scale) return { ...transform, scale };
  const graphX = (point.x - transform.x) / transform.scale;
  const graphY = (point.y - transform.y) / transform.scale;
  return {
    x: point.x - graphX * scale,
    y: point.y - graphY * scale,
    scale
  };
}

export function zoomScrollAtPoint(viewport, nextZoom, point) {
  const zoom = clampGraphZoom(nextZoom);
  if (zoom === viewport.zoom) return { ...viewport, zoom };
  const worldX = (viewport.scrollLeft + point.x) / viewport.zoom;
  const worldY = (viewport.scrollTop + point.y) / viewport.zoom;
  return {
    zoom,
    scrollLeft: Math.max(0, worldX * zoom - point.x),
    scrollTop: Math.max(0, worldY * zoom - point.y)
  };
}
