const statusEl = document.getElementById('status');
const loadBtn = document.getElementById('loadBtn');
const hoursInput = document.getElementById('hoursInput');
const locationInput = document.getElementById('locationInput');
const DEFAULT_COORDS = { latitude: 52.52, longitude: 13.405 };
const DEFAULT_LOCATION_QUERY = 'Berlin';
const LINE_COLORS = ['#ef4444', '#3b82f6', '#eab308', '#10b981', '#a855f7'];

const PROVIDERS = [
  {
    id: 'wetteronline',
    label: 'WetterOnline',
    unavailableReason: 'keine frei dokumentierte API'
  },
  {
    id: 'open-meteo',
    label: 'Open-Meteo',
    fetchSeries: fetchOpenMeteoSeries
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
    count: '1',
    language: 'de',
    format: 'json'
  });
  const url = `https://geocoding-api.open-meteo.com/v1/search?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Standortsuche fehlgeschlagen (HTTP ${res.status})`);
  const data = await res.json();
  const bestMatch = data?.results?.[0];

  if (!bestMatch || !Number.isFinite(bestMatch.latitude) || !Number.isFinite(bestMatch.longitude)) {
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
