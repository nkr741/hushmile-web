// The web viewer's map. Change here, not in app.js.
//
// engine "maplibre": MapLibre GL (vendored in vendor/, BSD-3-Clause) with
//   OpenFreeMap vector tiles: free, no key, no limits on map views, commercial
//   use allowed (https://openfreemap.org, attribution shown on the map).
// engine "leaflet": the older raster map (OpenStreetMap tiles); also used
//   on its own when a browser has no WebGL or the module fails to load.
// Another style URL (a MapTiler or self-hosted OpenFreeMap style) can be put
// in styles; add its host to the page's Content-Security-Policy too.
export const mapConfig = {
  engine: "maplibre",
  styles: {
    light: "https://tiles.openfreemap.org/styles/positron",
    dark: "https://tiles.openfreemap.org/styles/dark",
  },
  // Map labels: Latin names (English). MapLibre cannot yet join Telugu or
  // Hindi letters correctly, so labels in those scripts would look broken.
  labels: ["coalesce", ["get", "name:latin"], ["get", "name_en"], ["get", "name:en"], ""],
  rasterTiles: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  colors: { route: "#2d69fc", driven: "#0e7c66", drivenDark: "#34c99a", stale: "#5f6673", start: "#1b7f4e", end: "#e5484d" },
};
