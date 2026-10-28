// The journey map on the web page: the planned route (blue, with a casing),
// the road taken so far (green), trail dots, start and end markers, and the
// last known place with its heading arrow and accuracy halo. MapLibre GL is
// loaded only when a map is shown; without WebGL the Leaflet map is used.
import { mapConfig } from "./map-config.js";

const dark = () => globalThis.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches;

function webgl() {
  try {
    const c = document.createElement("canvas");
    return Boolean(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

/** Metres to screen pixels on a 512 px tile map, as a zoom expression. */
export function haloRadius(metres, lat) {
  const base = 78271.517 * Math.cos((lat * Math.PI) / 180);
  return ["interpolate", ["exponential", 2], ["zoom"], 0, metres / base, 22, (metres * 4194304) / base];
}

/** GeoJSON for what the map draws (exported for tests). */
export function mapFeatures(data) {
  const line = (pts) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pts.map(([lat, lng]) => [lng, lat]) } });
  const driven = [...data.trail.map(([lat, lng]) => [lat, lng]), ...(data.last ? [[data.last.lat, data.last.lng]] : [])];
  return {
    route: { type: "FeatureCollection", features: data.route.length > 1 ? [line(data.route)] : [] },
    driven: { type: "FeatureCollection", features: driven.length > 1 ? [line(driven)] : [] },
    dots: { type: "FeatureCollection", features: data.trail.map(([lat, lng], i) => ({ type: "Feature", properties: { age: (i + 1) / data.trail.length }, geometry: { type: "Point", coordinates: [lng, lat] } })) },
    halo: { type: "FeatureCollection", features: data.last && data.last.acc ? [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [data.last.lng, data.last.lat] } }] : [] },
  };
}

/** All points to fit, as [lng, lat] bounds or null. */
export function boundsOf(data) {
  const pts = [...data.route, ...data.trail, ...(data.last ? [[data.last.lat, data.last.lng]] : [])];
  if (!pts.length) return null;
  let s = 90, n = -90, w = 180, e = -180;
  for (const [lat, lng] of pts) {
    s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lng); e = Math.max(e, lng);
  }
  return [[w, s], [e, n]];
}

function pin(kind, colors) {
  const el = document.createElement("div");
  el.className = `hm-pin hm-${kind}`;
  el.setAttribute("aria-hidden", "true");
  if (kind === "end") el.innerHTML = `<svg width="30" height="38" viewBox="0 0 30 38"><path d="M15 37C15 37 2 22 2 14a13 13 0 0 1 26 0c0 8-13 23-13 23z" fill="${colors.end}" stroke="#fff" stroke-width="2"/><circle cx="15" cy="14" r="5" fill="#fff"/></svg>`;
  return el;
}

function vehicle() {
  const el = document.createElement("div");
  el.className = "hm-vehicle";
  el.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20" class="hm-arrow"><path d="M10 2 16 17 10 13.5 4 17z" fill="#fff"/></svg>`;
  return el;
}

/**
 * Creates the map in [el]. Returns { draw(data, label), fit() } or null when
 * no engine could start. [onFallback] is told when Leaflet is used.
 */
export async function createMap(el, { leaflet } = {}) {
  if (mapConfig.engine === "maplibre" && webgl()) {
    try {
      if (!document.querySelector("link[data-maplibre]")) {
        const css = document.createElement("link");
        css.rel = "stylesheet";
        css.href = new URL("./vendor/maplibre-gl.css", import.meta.url).href;
        css.dataset.maplibre = "1";
        document.head.append(css);
      }
      const gl = await import("./vendor/maplibre-gl.mjs");
      return maplibreMap(gl, el);
    } catch {
      // Fall through to Leaflet.
    }
  }
  return leaflet ? leaflet(el) : null;
}

function maplibreMap(gl, el) {
  const colors = mapConfig.colors;
  gl.setWorkerUrl(new URL("./vendor/maplibre-gl-worker.mjs", import.meta.url).href);
  const isDark = dark();
  const map = new gl.Map({
    container: el,
    style: isDark ? mapConfig.styles.dark : mapConfig.styles.light,
    center: [78.4867, 17.385],
    zoom: 10,
    attributionControl: { compact: true },
    dragRotate: false,
    pitchWithRotate: false,
    cooperativeGestures: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new gl.NavigationControl({ showCompass: false }), "top-right");
  let fitted = false;
  let current = null;
  const markers = { start: null, end: null, vehicle: null };
  const ready = new Promise((resolve) => map.on("load", resolve));

  function fit() {
    const b = current && boundsOf(current);
    if (!b) return;
    const pad = { top: 56, bottom: 64, left: 48, right: 64 };
    if (b[0][0] === b[1][0] && b[0][1] === b[1][1]) map.jumpTo({ center: b[0], zoom: 14 });
    else map.fitBounds(b, { padding: pad, maxZoom: 15, duration: fitted ? 400 : 0 });
  }

  // A "show the whole route" button under the zoom buttons.
  class FitControl {
    onAdd() {
      const box = document.createElement("div");
      box.className = "maplibregl-ctrl maplibregl-ctrl-group";
      const b = document.createElement("button");
      b.type = "button";
      b.className = "hm-fit";
      b.id = "map-fit";
      b.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M5 15H3v4a2 2 0 0 0 2 2h4v-2H5zM5 5h4V3H5a2 2 0 0 0-2 2v4h2zm14-2h-4v2h4v4h2V5a2 2 0 0 0-2-2zm0 16h-4v2h4a2 2 0 0 0 2-2v-4h-2zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/></svg>`;
      b.addEventListener("click", fit);
      box.append(b);
      return box;
    }
    onRemove() {}
  }
  map.addControl(new FitControl(), "top-right");

  ready.then(() => {
    // Latin labels only (see map-config.js).
    for (const layer of map.getStyle().layers) {
      // Place and road names only; road numbers in shields stay as they are.
      if (layer.type === "symbol" && layer.layout && /"name/.test(JSON.stringify(layer.layout["text-field"] ?? "")) && !/shield/.test(layer.id)) {
        try {
          map.setLayoutProperty(layer.id, "text-field", mapConfig.labels);
        } catch {}
      }
    }
    const casing = isDark ? "#0b1220" : "#ffffff";
    for (const id of ["route", "driven", "dots", "halo"]) map.addSource(id, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "halo", type: "circle", source: "halo", paint: { "circle-color": colors.driven, "circle-opacity": 0.14, "circle-stroke-color": colors.driven, "circle-stroke-opacity": 0.4, "circle-stroke-width": 1, "circle-radius": 0 } });
    map.addLayer({ id: "route-casing", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": casing, "line-width": 9 } });
    map.addLayer({ id: "route", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": colors.route, "line-width": 5, "line-opacity": 0.85 } });
    map.addLayer({ id: "driven-casing", type: "line", source: "driven", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": casing, "line-width": 8 } });
    map.addLayer({ id: "driven", type: "line", source: "driven", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": isDark ? colors.drivenDark : colors.driven, "line-width": 4 } });
    map.addLayer({ id: "dots", type: "circle", source: "dots", paint: { "circle-radius": 4, "circle-color": isDark ? colors.drivenDark : colors.driven, "circle-opacity": ["+", 0.4, ["*", 0.55, ["get", "age"]]], "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } });
  });

  async function draw(data, label) {
    current = data;
    await ready;
    const f = mapFeatures(data);
    for (const id of Object.keys(f)) map.getSource(id).setData(f[id]);
    if (data.last && data.last.acc) map.setPaintProperty("halo", "circle-radius", haloRadius(data.last.acc, data.last.lat));
    const stale = data.last && data.last.at != null && Date.now() - data.last.at > 15 * 60000;
    if (data.last) map.setPaintProperty("halo", "circle-color", stale ? colors.stale : colors.driven);
    const place = (key, el, lngLat, opts = {}) => {
      if (!lngLat) {
        markers[key]?.remove();
        markers[key] = null;
        return null;
      }
      if (!markers[key]) markers[key] = new gl.Marker({ element: el(), ...opts }).setLngLat(lngLat).addTo(map);
      else markers[key].setLngLat(lngLat);
      return markers[key];
    };
    const first = data.route.length > 1 ? data.route[0] : null;
    const lastR = data.route.length > 1 ? data.route[data.route.length - 1] : null;
    place("start", () => pin("start", colors), first && [first[1], first[0]]);
    place("end", () => pin("end", colors), lastR && [lastR[1], lastR[0]], { anchor: "bottom" });
    const v = place("vehicle", vehicle, data.last && [data.last.lng, data.last.lat], { rotationAlignment: "map" });
    if (v) {
      const el = v.getElement();
      el.classList.toggle("stale", Boolean(stale));
      el.classList.toggle("no-heading", stale || typeof data.last.hdg !== "number");
      v.setRotation(!stale && typeof data.last.hdg === "number" ? data.last.hdg : 0);
      el.title = label || "";
      el.setAttribute("aria-label", label || "");
    }
    if (!fitted) {
      fit();
      fitted = true;
    }
  }

  return { draw, fit, reset: () => (fitted = false), engine: "maplibre" };
}
