// מפת MapLibre עם אריחי OpenFreeMap. נטען רק כשמסך המפה מוצג.
import { Map as MapLibreMap, NavigationControl, GeolocateControl, AttributionControl } from 'maplibre-gl';

// כתובת הסגנון היא המקום היחיד להחלפת ספק המפה (למשל PMTiles, ראו CLAUDE.md סעיף 3)
export const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const REQUIRED_ATTRIBUTION = '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> '
  + '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> '
  + 'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
const FONT = ['Noto Sans Bold'];

export function createMap(container, { center, zoom, accent, muted, t, onSelect, onError }) {
  let map;
  try {
    map = new MapLibreMap({
      container, style: STYLE_URL, center, zoom, attributionControl: false,
      maxPitch: 0, dragRotate: false, touchPitch: false,
    });
  } catch (e) {
    onError(e);
    return null;
  }
  map.touchZoomRotate.disableRotation();
  map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new GeolocateControl({ positionOptions: { enableHighAccuracy: false }, fitBoundsOptions: { maxZoom: 13 } }), 'top-right');

  let data = { type: 'FeatureCollection', features: [] };
  let selected = null;
  let loaded = false;

  map.on('error', (e) => {
    if (!loaded) onError(e.error || e);
    else console.warn('[map]', e.error?.message || e);
  });

  map.on('load', () => {
    loaded = true;
    const sources = Object.values(map.getStyle().sources || {});
    const styleHasOsm = sources.some((s) => /openstreetmap/i.test(s.attribution || ''));
    map.addControl(new AttributionControl({ compact: false, customAttribution: styleHasOsm ? undefined : REQUIRED_ATTRIBUTION }), 'bottom-right');

    map.addSource('places', { type: 'geojson', data, cluster: true, clusterMaxZoom: 11, clusterRadius: 48 });
    map.addLayer({
      id: 'clusters', type: 'circle', source: 'places', filter: ['has', 'point_count'],
      paint: {
        'circle-color': accent,
        'circle-opacity': 0.92,
        'circle-radius': ['step', ['get', 'point_count'], 18, 10, 23, 50, 29],
        'circle-stroke-width': 3,
        'circle-stroke-color': '#FFFBF4',
      },
    });
    map.addLayer({
      id: 'cluster-count', type: 'symbol', source: 'places', filter: ['has', 'point_count'],
      layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': FONT, 'text-size': 14, 'text-allow-overlap': true },
      paint: { 'text-color': '#FFFFFF' },
    });
    map.addLayer({
      id: 'selected', type: 'circle', source: 'places', filter: ['==', ['get', 'id'], -1],
      paint: { 'circle-radius': 25, 'circle-color': accent, 'circle-opacity': 0.25 },
    });
    map.addLayer({
      id: 'points', type: 'circle', source: 'places', filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': ['case', ['get', 'published'], accent, muted],
        'circle-radius': 17,
        'circle-stroke-width': 2.5,
        'circle-stroke-color': '#FFFBF4',
      },
    });
    map.addLayer({
      id: 'point-score', type: 'symbol', source: 'places', filter: ['!', ['has', 'point_count']],
      layout: { 'text-field': ['get', 'scoreText'], 'text-font': FONT, 'text-size': 13, 'text-allow-overlap': true },
      paint: { 'text-color': '#FFFFFF' },
    });
    if (selected !== null) setSelected(selected);
  });

  map.on('click', 'clusters', async (e) => {
    const f = e.features[0];
    const zoomTo = await map.getSource('places').getClusterExpansionZoom(f.properties.cluster_id);
    map.easeTo({ center: f.geometry.coordinates, zoom: zoomTo + 0.5 });
  });
  map.on('click', 'points', (e) => {
    const id = e.features[0].properties.id;
    setSelected(id);
    onSelect(id);
  });
  map.on('click', (e) => {
    if (!map.queryRenderedFeatures(e.point, { layers: ['points', 'clusters'].filter((l) => map.getLayer(l)) }).length) {
      setSelected(null);
      onSelect(null);
    }
  });
  for (const layer of ['clusters', 'points']) {
    map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
  }

  function setSelected(id) {
    selected = id;
    if (map.getLayer('selected')) map.setFilter('selected', ['all', ['!', ['has', 'point_count']], ['==', ['get', 'id'], id ?? -1]]);
  }

  return {
    map,
    setPlaces(places, isPublished) {
      data = {
        type: 'FeatureCollection',
        features: places.filter((p) => p.lonlat).map((p) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: p.lonlat },
          properties: { id: p.place_id, scoreText: p.score !== null ? p.score.toFixed(1) : '·', published: isPublished(p) },
        })),
      };
      map.getSource('places')?.setData(data);
    },
    focus(place) {
      if (!place?.lonlat) return;
      setSelected(place.place_id);
      map.flyTo({ center: place.lonlat, zoom: Math.max(map.getZoom(), 14), essential: false });
    },
    select: setSelected,
    resize: () => map.resize(),
  };
}
