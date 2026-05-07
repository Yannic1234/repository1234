const statusEl = document.getElementById('status');
const loadBtn = document.getElementById('loadBtn');
const hoursInput = document.getElementById('hoursInput');
const DEFAULT_COORDS = { latitude: 52.52, longitude: 13.405 };
const DWD_STATION_ID = '10865';
const LINE_COLORS = ['#ef4444', '#3b82f6', '#eab308', '#10b981', '#a855f7'];

const PROVIDERS = [
  {
    id: 'wetteronline',
    label: 'WetterOnline',
    unavailableReason: 'keine frei dokumentierte API'
  },
  {
    id: 'dwd',
    label: 'Deutscher Wetterdienst (DWD)',
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

function buildForecastTimeAxis(series) {
  if (Array.isArray(series.time) && series.time.length > 0) {
    return series.time.map((t) => new Date(t));
  }

  const maxLen = Math.max(
    series.temperature?.length || 0,
    series.precipitationTotal?.length || 0,
    series.precipitation?.length || 0,
    series.uvIndex?.length || 0,
    series.uvi?.length || 0
  );

  if (Number.isFinite(series.start) && Number.isFinite(series.timeStep) && maxLen > 0) {
    return Array.from({ length: maxLen }, (_, idx) => new Date(series.start + idx * series.timeStep));
  }

  return [];
}

function findForecastSeriesCandidates(node, out = []) {
  if (!node || typeof node !== 'object') return out;

  const hasTemp = Array.isArray(node.temperature);
  const hasTime =
    (Array.isArray(node.time) && node.time.length > 0) ||
    (Number.isFinite(node.start) && Number.isFinite(node.timeStep));

  if (hasTemp && hasTime) out.push(node);

  Object.values(node).forEach((value) => {
    if (value && typeof value === 'object') findForecastSeriesCandidates(value, out);
  });

  return out;
}

function parseDwdForecast(data, stationId, hours) {
  const stationData = data?.[stationId] ?? Object.values(data || {}).find((v) => v && typeof v === 'object');
  if (!stationData) throw new Error('DWD Station nicht gefunden.');

  const candidates = findForecastSeriesCandidates(stationData);
  const selected = candidates.find((c) => Array.isArray(c.temperature));
  if (!selected) throw new Error('DWD Vorhersageformat nicht erkannt.');

  const times = buildForecastTimeAxis(selected);
  if (!times.length) throw new Error('DWD Vorhersagezeiten fehlen.');

  const precipitationArray = selected.precipitationTotal ?? selected.precipitation ?? [];
  const uvArray = selected.uvIndex ?? selected.uvi ?? selected.uv_index ?? [];
  const maxLen = Math.min(hours, times.length);

  return Array.from({ length: maxLen }, (_, idx) => {
    const temperature = selected.temperature?.[idx];
    const precipitation = precipitationArray?.[idx];
    const uvIndex = uvArray?.[idx];

    return {
      x: times[idx],
      temperature_2m: Number.isFinite(temperature) ? temperature / 10 : null,
      precipitation: Number.isFinite(precipitation) ? precipitation / 10 : null,
      uv_index: Number.isFinite(uvIndex) ? uvIndex : null
    };
  }).filter((point) =>
    Number.isFinite(point.temperature_2m) || Number.isFinite(point.precipitation) || Number.isFinite(point.uv_index)
  );
}

async function fetchDwdSeries(hours) {
  const params = new URLSearchParams({ stationIds: DWD_STATION_ID });
  const url = `https://app-prod-ws.warnwetter.de/v30/stationOverviewExtended?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return parseDwdForecast(data, DWD_STATION_ID, hours);
}

async function loadAvailableSeries(hours) {
  const available = [];
  const unavailable = [];

  for (const provider of PROVIDERS) {
    if (!provider.fetchSeries) {
      unavailable.push(`${provider.label} (${provider.unavailableReason})`);
      continue;
    }

    try {
      const points = await provider.fetchSeries(hours, DEFAULT_COORDS);
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
    setStatus('Quellen werden geladen …');
    const { available, unavailable } = await loadAvailableSeries(hours);

    if (available.length === 0) {
      throw new Error('Keine verfügbare Wetterquelle lieferte Daten.');
    }

    renderOverlayChart('tempChart', 'Temperatur', available, 'temperature_2m');
    renderOverlayChart('rainChart', 'Regen', available, 'precipitation');
    renderOverlayChart('uvChart', 'UV-Index', available, 'uv_index');

    const loadedNames = available.map((p) => p.label).join(', ');
    const unavailableText = unavailable.length ? ` | Nicht verfügbar: ${unavailable.join('; ')}` : '';
    setStatus(`Fertig: ${available.length} Quelle(n) geladen (${loadedNames})${unavailableText}`);
  } catch (error) {
    setStatus(`Fehler: ${error.message}`);
  }
}

loadBtn.addEventListener('click', loadAndRender);
