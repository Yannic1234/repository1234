const statusEl = document.getElementById('status');
const loadBtn = document.getElementById('loadBtn');
const hoursInput = document.getElementById('hoursInput');
const locationInput = document.getElementById('locationInput');
const DEFAULT_COORDS = { latitude: 52.52, longitude: 13.405 };
const DEFAULT_LOCATION_QUERY = 'Berlin';
const LINE_COLORS = ['#ef4444', '#3b82f6', '#eab308', '#10b981', '#a855f7'];

// DWD station lookup table (Stationskennung / WMO block station numbers with coordinates)
const DWD_STATIONS = [
  { id: '10384', lat: 52.47, lon: 13.40 }, // Berlin-Tempelhof
  { id: '10147', lat: 53.63, lon: 10.00 }, // Hamburg-Fuhlsbüttel
  { id: '10865', lat: 48.35, lon: 11.79 }, // München
  { id: '10487', lat: 51.13, lon: 13.75 }, // Dresden-Klotzsche
  { id: '10637', lat: 50.05, lon: 8.60 },  // Frankfurt/Main
  { id: '10513', lat: 50.87, lon: 7.16 },  // Köln/Bonn
  { id: '10738', lat: 48.69, lon: 9.22 },  // Stuttgart
  { id: '10469', lat: 51.42, lon: 12.24 }, // Leipzig
  { id: '10338', lat: 52.46, lon: 9.69 },  // Hannover
  { id: '10763', lat: 49.50, lon: 11.08 }, // Nürnberg
  { id: '10224', lat: 53.05, lon: 8.79 },  // Bremen
  { id: '10429', lat: 51.29, lon: 6.77 },  // Düsseldorf
  { id: '10446', lat: 51.52, lon: 7.61 },  // Dortmund
  { id: '10500', lat: 50.98, lon: 10.96 }, // Erfurt
  { id: '10908', lat: 48.02, lon: 7.83 },  // Freiburg
  { id: '10857', lat: 48.43, lon: 10.94 }  // Augsburg
];

const PROVIDERS = [
  {
    id: 'wetteronline',
    label: 'WetterOnline',
    unavailableReason: 'nur als Python-Bibliothek verfügbar (wetteronline.readthedocs.io), kein direkter Browser-Zugriff'
  },
  {
    id: 'open-meteo',
    label: 'Open-Meteo',
    fetchSeries: fetchOpenMeteoSeries
  },
  {
    id: 'dwd',
    label: 'DWD (Deutscher Wetterdienst)',
    fetchSeries: fetchDwdSeries
  },
  {
    id: 'kachelmann',
    label: 'Kachelmannwetter',
    unavailableReason: 'keine frei dokumentierte API'
  },
  {
    id: 'meteoblue',
    label: 'meteoblue',
    unavailableReason: 'API-Zugangsschlüssel erforderlich'
  },
  {
    id: 'windy',
    label: 'Windy',
    unavailableReason: 'API-Zugangsschlüssel erforderlich'
  }
];

let charts = {};

function setStatus(text) {
  statusEl.textContent = text;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findNearestDwdStation(lat, lon) {
  return DWD_STATIONS.reduce(
    (best, s) => {
      const d = haversineKm(lat, lon, s.lat, s.lon);
      return d < best.dist ? { ...s, dist: d } : best;
    },
    { dist: Infinity }
  );
}

async function fetchDwdSeries(hours, coords) {
  const station = findNearestDwdStation(coords.latitude, coords.longitude);
  const url = `https://dwd.api.proxy.bund.dev/v30/stationOverviewExtended?stationIds=${station.id}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DWD HTTP ${res.status}`);
  const data = await res.json();

  const stationData = data[station.id];
  if (!stationData?.forecast1) throw new Error('DWD: keine Vorhersagedaten');

  const f = stationData.forecast1;
  const start = f.start; // Unix ms
  const step = f.timeStep; // ms between values
  const temps = f.temperature ?? [];
  const precip = f.precipitationTotal ?? [];

  // DWD arrays for both fields should have the same length; fall back to temps length if precip is absent
  const maxLen = Math.min(hours, temps.length, precip.length > 0 ? precip.length : temps.length);

  // DWD API returns values in tenths of the base unit (0.1 °C, 0.1 mm/h)
  // and uses -999 as a missing-value sentinel
  const DWD_MISSING = -999;

  return Array.from({ length: maxLen }, (_, i) => {
    const rawTemp = temps[i];
    const rawPrecip = precip[i];
    const temperature_2m =
      rawTemp != null && rawTemp !== DWD_MISSING ? rawTemp / 10 : null;
    const precipitation =
      rawPrecip != null && rawPrecip !== DWD_MISSING && rawPrecip >= 0 ? rawPrecip / 10 : null;
    return {
      x: new Date(start + i * step),
      temperature_2m,
      precipitation,
      uv_index: null
    };
  }).filter(hasAnyValidMetric);
}

async function fetchOpenMeteoSeries(hours, coords) {
  const params = new URLSearchParams({
    latitude: String(coords.latitude),
    longitude: String(coords.longitude),
    hourly: 'temperature_2m,precipitation,uv_index',
    forecast_hours: String(hours),
    timezone: 'auto'
  });
  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  const times = data?.hourly?.time ?? [];
  const temperatures = data?.hourly?.temperature_2m ?? [];
  const precipitation = data?.hourly?.precipitation ?? [];
  const uvIndex = data?.hourly?.uv_index ?? [];
  const maxLen = Math.min(hours, times.length);

  return Array.from({ length: maxLen }, (_, idx) => ({
    x: new Date(times[idx]),
    temperature_2m: Number.isFinite(temperatures[idx]) ? temperatures[idx] : null,
    precipitation: Number.isFinite(precipitation[idx]) ? precipitation[idx] : null,
    uv_index: Number.isFinite(uvIndex[idx]) ? uvIndex[idx] : null
  })).filter(hasAnyValidMetric);
}

async function geocodeLocation(query) {
  const params = new URLSearchParams({
    name: query,
    count: '10',
    language: 'de',
    format: 'json'
  });
  const url = `https://geocoding-api.open-meteo.com/v1/search?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Standortsuche fehlgeschlagen (HTTP ${res.status})`);
  const data = await res.json();
  const results = data?.results ?? [];

  if (results.length === 0) {
    throw new Error('Standort nicht gefunden.');
  }

  // Prefer German cities; fall back to first result for international queries
  const bestMatch =
    results.find((r) => r.country_code === 'DE') ?? results[0];

  if (!Number.isFinite(bestMatch.latitude) || !Number.isFinite(bestMatch.longitude)) {
    throw new Error('Standort nicht gefunden.');
  }

  const region = bestMatch.admin1;
  const parts = [bestMatch.name, region, bestMatch.country].filter(Boolean);
  return {
    latitude: bestMatch.latitude,
    longitude: bestMatch.longitude,
    label: parts.join(', ')
  };
}

async function loadAvailableSeries(hours, coords) {
  const available = [];
  const unavailable = [];

  for (const provider of PROVIDERS) {
    if (!provider.fetchSeries) {
      unavailable.push(`${provider.label} (${provider.unavailableReason})`);
      continue;
    }

    try {
      const points = await provider.fetchSeries(hours, coords);
      if (points.length > 0) {
        available.push({
          id: provider.id,
          label: provider.label,
          points
        });
      } else {
        unavailable.push(`${provider.label} (keine Daten)`);
      }
    } catch (error) {
      unavailable.push(`${provider.label} (${error.message})`);
    }
  }

  return { available, unavailable };
}

function getMetricSeries(points, key) {
  return points
    .filter((p) => Number.isFinite(p[key]))
    .map((p) => ({
      x: p.x,
      y: p[key]
    }));
}

function hasAnyValidMetric(point) {
  return Number.isFinite(point.temperature_2m) || Number.isFinite(point.precipitation) || Number.isFinite(point.uv_index);
}

function renderOverlayChart(canvasId, metricLabel, seriesByProvider, metricKey) {
  const ctx = document.getElementById(canvasId);

  if (charts[canvasId]) charts[canvasId].destroy();

  const datasets = seriesByProvider
    .map((provider, idx) => {
      const data = getMetricSeries(provider.points, metricKey);
      if (data.length === 0) return null;
      return {
        label: provider.label,
        data,
        borderColor: LINE_COLORS[idx % LINE_COLORS.length],
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.25
      };
    })
    .filter(Boolean);

  if (datasets.length === 0) {
    throw new Error(`Keine Datenreihen für ${metricLabel} verfügbar.`);
  }

  // Determine the full time range across all datasets so the x-axis shows all loaded data
  let xMin = Infinity;
  let xMax = -Infinity;
  for (const ds of datasets) {
    for (const pt of ds.data) {
      const t = pt.x instanceof Date ? pt.x.getTime() : new Date(pt.x).getTime();
      if (t < xMin) xMin = t;
      if (t > xMax) xMax = t;
    }
  }

  charts[canvasId] = new Chart(ctx, {
    type: 'line',
    data: {
      datasets
    },
    options: {
      parsing: false,
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      // Sichtbare Legende ist erforderlich, um die überlagerten Quellenlinien zu unterscheiden.
      plugins: { legend: { display: true } },
      scales: {
        x: {
          type: 'time',
          min: xMin === Infinity ? undefined : xMin,
          max: xMax === -Infinity ? undefined : xMax,
          time: { unit: 'hour', tooltipFormat: 'dd.MM.yyyy HH:mm' }
        }
      }
    }
  });
}

async function loadAndRender() {
  try {
    const hours = Math.min(72, Math.max(6, Number(hoursInput.value) || 24));
    const query = locationInput.value.trim() || DEFAULT_LOCATION_QUERY;
    setStatus('Standort wird gesucht …');
    const location = await geocodeLocation(query);
    locationInput.value = location.label;
    setStatus(`Quellen werden geladen … (${location.label})`);
    const { available, unavailable } = await loadAvailableSeries(hours, location);

    if (available.length === 0) {
      throw new Error('Keine verfügbare Wetterquelle lieferte Daten.');
    }

    renderOverlayChart('tempChart', 'Temperatur', available, 'temperature_2m');
    renderOverlayChart('rainChart', 'Regen', available, 'precipitation');
    renderOverlayChart('uvChart', 'UV-Index', available, 'uv_index');

    const loadedNames = available.map((p) => p.label).join(', ');
    const unavailableText = unavailable.length ? ` | Nicht verfügbar: ${unavailable.join('; ')}` : '';
    setStatus(`Fertig: ${available.length} Quelle(n) geladen für ${location.label} (${loadedNames})${unavailableText}`);
  } catch (error) {
    setStatus(`Fehler: ${error.message}`);
  }
}

loadBtn.addEventListener('click', loadAndRender);
