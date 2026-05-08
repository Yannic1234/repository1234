const statusEl = document.getElementById('status');
const loadBtn = document.getElementById('loadBtn');
const hoursInput = document.getElementById('hoursInput');
const locationInput = document.getElementById('locationInput');
const DEFAULT_COORDS = { latitude: 52.52, longitude: 13.405 };
const DEFAULT_LOCATION_QUERY = 'Berlin';
const LINE_COLORS     = ['#ef4444', '#3b82f6', '#eab308', '#10b981', '#a855f7', '#f97316', '#06b6d4', '#84cc16'];
const LINE_COLORS_RGB = [
  '239,68,68',   // red
  '59,130,246',  // blue
  '234,179,8',   // yellow
  '16,185,129',  // green
  '168,85,247',  // purple
  '249,115,22',  // orange
  '6,182,212',   // cyan
  '132,204,22'   // lime
];

// Dash patterns for distinguishing overlapping series
const DASH_PATTERNS = [
  [],              // solid
  [8, 4],          // dashed
  [2, 4],          // dotted
  [10, 4, 2, 4],   // dash-dot
  [14, 4, 2, 4, 2, 4], // dash-dot-dot
  [6, 2],          // short dash
  [16, 4],         // long dash
  [6, 4, 2, 4]     // short dash-dot
];

// Global Chart.js defaults – dark theme
Chart.defaults.color                     = 'rgba(255,255,255,0.55)';
Chart.defaults.borderColor               = 'rgba(255,255,255,0.07)';
Chart.defaults.font.family               = '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';
Chart.defaults.font.size                 = 11;

const MS_PER_HOUR = 3_600_000;

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
    label: 'Open-Meteo (ICON)',
    fetchSeries: fetchOpenMeteoSeries
  },
  {
    id: 'open-meteo-ecmwf',
    label: 'ECMWF IFS (Open-Meteo)',
    fetchSeries: (hours, coords) => fetchOpenMeteoSeries(hours, coords, 'ecmwf_ifs025')
  },
  {
    id: 'open-meteo-gfs',
    label: 'GFS/NOAA (Open-Meteo)',
    fetchSeries: (hours, coords) => fetchOpenMeteoSeries(hours, coords, 'gfs_seamless')
  },
  {
    id: 'dwd',
    label: 'DWD (Proxy)',
    fetchSeries: fetchDwdSeries
  },
  {
    id: 'brightsky',
    label: 'BrightSky (DWD)',
    fetchSeries: fetchBrightSkySeries
  },
  {
    id: 'dwd-opendata',
    label: 'DWD Opendata (MOSMIX)',
    fetchSeries: fetchDwdOpenDataSeries
  },
  {
    id: 'metno',
    label: 'MET Norway (Yr)',
    fetchSeries: fetchMetNorwaySeries
  },
  {
    id: '7timer',
    label: '7Timer!',
    fetchSeries: fetch7TimerSeries
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

async function fetchOpenMeteoSeries(hours, coords, model = null) {
  const params = new URLSearchParams({
    latitude: String(coords.latitude),
    longitude: String(coords.longitude),
    hourly: 'temperature_2m,precipitation,uv_index',
    forecast_hours: String(hours),
    timezone: 'auto'
  });
  if (model) params.set('models', model);
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

async function fetchMetNorwaySeries(hours, coords) {
  const url =
    `https://api.met.no/weatherapi/locationforecast/2.0/compact` +
    `?lat=${coords.latitude}&lon=${coords.longitude}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MET Norway HTTP ${res.status}`);
  const data = await res.json();

  const timeseries = data?.properties?.timeseries ?? [];
  const now = Date.now();
  const result = [];
  for (const entry of timeseries) {
    const x = new Date(entry.time);
    if (x.getTime() < now - 3_600_000) continue;
    if (result.length >= hours) break;
    const instant = entry?.data?.instant?.details ?? {};
    const next1h = entry?.data?.next_1_hours?.details ?? {};
    const temperature_2m = Number.isFinite(instant.air_temperature) ? instant.air_temperature : null;
    const precipitation = Number.isFinite(next1h.precipitation_amount) ? next1h.precipitation_amount : null;
    if (temperature_2m !== null || precipitation !== null) {
      result.push({ x, temperature_2m, precipitation, uv_index: null });
    }
  }
  return result.filter(hasAnyValidMetric);
}

// Mapping von 7Timer! prec_amount (Ordinalskala 1–9) auf Midpoint-mm-Werte
const SEVEN_TIMER_PRECIP_MM = [0, 0, 0.5, 1.5, 3, 6, 12, 23, 40, 60];

async function fetch7TimerSeries(hours, coords) {
  const url =
    `https://www.7timer.info/bin/api.pl` +
    `?lon=${coords.longitude}&lat=${coords.latitude}&product=civil&output=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`7Timer! HTTP ${res.status}`);
  const data = await res.json();

  // init: "YYYYMMDDHH" UTC
  const initStr = String(data.init);
  const initDate = new Date(
    `${initStr.slice(0, 4)}-${initStr.slice(4, 6)}-${initStr.slice(6, 8)}T${initStr.slice(8, 10)}:00:00Z`
  );

  return (data.dataseries ?? [])
    .slice(0, hours)
    .map((entry) => ({
      x: new Date(initDate.getTime() + entry.timepoint * 3_600_000),
      temperature_2m: Number.isFinite(entry.temp2m) ? entry.temp2m : null,
      precipitation: SEVEN_TIMER_PRECIP_MM[entry.prec_amount] ?? null,
      uv_index: null
    }))
    .filter(hasAnyValidMetric);
}

async function fetchBrightSkySeries(hours, coords) {
  const now = new Date();
  const lastDate = new Date(now.getTime() + hours * 3_600_000);
  const params = new URLSearchParams({
    lat: String(coords.latitude),
    lon: String(coords.longitude),
    date: now.toISOString(),
    last_date: lastDate.toISOString()
  });
  const url = `https://api.brightsky.dev/weather?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`BrightSky HTTP ${res.status}`);
  const data = await res.json();

  const weather = data?.weather ?? [];
  return weather
    .slice(0, hours)
    .map((w) => ({
      x: new Date(w.timestamp),
      temperature_2m: Number.isFinite(w.temperature) ? w.temperature : null,
      precipitation: Number.isFinite(w.precipitation) ? w.precipitation : null,
      uv_index: null // BrightSky liefert keinen UV-Index
    }))
    .filter(hasAnyValidMetric);
}

// Namespace-URI der DWD MOSMIX KML-Erweiterung
const DWD_NS = 'https://opendata.dwd.de/weather/lib/pointforecast_dwd_extension_V1_0.xsd';

async function fetchDwdOpenDataSeries(hours, coords) {
  if (typeof JSZip === 'undefined') throw new Error('JSZip nicht geladen');

  const station = findNearestDwdStation(coords.latitude, coords.longitude);
  const kmzUrl =
    `https://opendata.dwd.de/weather/local_forecasts/mos/MOSMIX_L/single_stations/` +
    `${station.id}/kml/MOSMIX_L_LATEST_${station.id}.kmz`;

  const res = await fetch(kmzUrl);
  if (!res.ok) throw new Error(`DWD opendata HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();

  const zip = await JSZip.loadAsync(buffer);
  const kmlFileName = Object.keys(zip.files).find((n) => n.endsWith('.kml'));
  if (!kmlFileName) throw new Error('DWD opendata: keine KML-Datei im KMZ-Archiv');
  const kmlText = await zip.files[kmlFileName].async('string');

  const parser = new DOMParser();
  const doc = parser.parseFromString(kmlText, 'application/xml');

  // Zeitschritte auslesen
  const timeStepEls = doc.getElementsByTagNameNS(DWD_NS, 'TimeStep');
  const timeSteps = Array.from(timeStepEls).map((el) => new Date(el.textContent.trim()));
  if (timeSteps.length === 0) throw new Error('DWD opendata: keine Zeitschritte gefunden');

  // Helfer: Forecast-Element nach elementName suchen
  function findForecast(name) {
    const forecasts = doc.getElementsByTagName('Forecast');
    for (const el of forecasts) {
      const n =
        el.getAttribute('dwd:elementName') ??
        el.getAttributeNS(DWD_NS, 'elementName');
      if (n === name) return el;
    }
    return null;
  }

  // Helfer: dwd:value-Werte als Float-Array parsen ('-' = null)
  function parseDwdValues(forecastEl) {
    if (!forecastEl) return [];
    const valueEl = forecastEl.getElementsByTagNameNS(DWD_NS, 'value')[0];
    if (!valueEl) return [];
    return valueEl.textContent
      .trim()
      .split(/\s+/)
      .map((v) => (v === '-' || v === '' ? null : parseFloat(v)));
  }

  const tttVals = parseDwdValues(findForecast('TTT'));   // Temperatur in K
  const rr1cVals = parseDwdValues(findForecast('RR1c')); // Niederschlag in mm

  const now = Date.now();
  return timeSteps
    .slice(0, Math.min(timeSteps.length, hours + 24)) // Puffer für Filterung
    .map((ts, i) => ({
      x: ts,
      temperature_2m: tttVals[i] != null ? tttVals[i] - 273.15 : null,
      precipitation: rr1cVals[i] != null && rr1cVals[i] >= 0 ? rr1cVals[i] : null,
      uv_index: null
    }))
    .filter((p) => p.x.getTime() >= now - 3_600_000)
    .slice(0, hours)
    .filter(hasAnyValidMetric);
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

// ─── Weather background ───────────────────────────────────────────────────────

const WEATHER_META = {
  sunny:          { icon: '☀️',  label: 'Sonnig' },
  'partly-cloudy':{ icon: '⛅', label: 'Leicht bewölkt' },
  cloudy:         { icon: '☁️',  label: 'Bewölkt' },
  rainy:          { icon: '🌧️', label: 'Regen' },
  snow:           { icon: '❄️',  label: 'Schnee' },
  stormy:         { icon: '⛈️', label: 'Gewitter' },
  fog:            { icon: '🌫️', label: 'Nebel' },
  night:          { icon: '🌙',  label: 'Nacht' }
};

function weatherCodeToClass(code, isDay) {
  if (!isDay) return 'night';
  if (code <= 1)                          return 'sunny';          // 0-1: Clear sky / mainly clear
  if (code === 2 || code === 3)           return 'cloudy';         // 2-3: Partly/fully overcast
  if (code === 45 || code === 48)         return 'fog';            // 45/48: Fog / rime fog
  if (code >= 51 && code <= 67)           return 'rainy';          // 51-67: Drizzle / rain / freezing rain
  if (code >= 71 && code <= 77)           return 'snow';           // 71-77: Snow fall / snow grains / ice
  if (code >= 80 && code <= 82)           return 'rainy';          // 80-82: Rain showers
  if (code === 85 || code === 86)         return 'snow';           // 85-86: Snow showers
  if (code >= 95)                         return 'stormy';         // 95-99: Thunderstorm
  return 'cloudy';
}

async function applyWeatherBackground(coords) {
  try {
    const params = new URLSearchParams({
      latitude:  String(coords.latitude),
      longitude: String(coords.longitude),
      current: 'weather_code,is_day'
    });
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
    if (!res.ok) return;
    const data = await res.json();
    const code  = data?.current?.weather_code ?? 0;
    const isDay = Boolean(data?.current?.is_day ?? 1);
    const cls   = weatherCodeToClass(code, isDay);
    setWeatherUI(cls);
  } catch (err) {
    console.warn('[weather] background fetch failed:', err);
    /* silent fallback – background stays at initialised default */
  }
}

function setWeatherUI(cls) {
  const bg        = document.getElementById('weatherBg');
  const indicator = document.getElementById('weatherIndicator');
  const iconEl    = document.getElementById('weatherIcon');
  const labelEl   = document.getElementById('weatherLabel');
  if (bg)        { bg.className = cls; }
  const meta = WEATHER_META[cls];
  if (indicator && meta) {
    iconEl.textContent  = meta.icon;
    labelEl.textContent = meta.label;
    indicator.classList.remove('hidden');
  }
}

// Initialise background from local time before any fetch
(function initWeatherBackground() {
  const h = new Date().getHours();
  setWeatherUI(h >= 6 && h < 20 ? 'sunny' : 'night');
})();

// ─── Vertical midnight / noon grid-line plugin ────────────────────────────────

const midnightNoonPlugin = {
  id: 'midnightNoon',
  beforeDatasetsDraw(chart) {
    const { ctx, scales, chartArea } = chart;
    const xScale = scales.x;
    if (!xScale || !chartArea) return;
    const { top, bottom } = chartArea;
    const xMin = xScale.min;
    const xMax = xScale.max;

    ctx.save();
    ctx.lineWidth = 1;

    const startDay = new Date(xMin);
    startDay.setHours(0, 0, 0, 0);

    for (let d = new Date(startDay); d.getTime() <= xMax; d.setDate(d.getDate() + 1)) {
      // Midnight  (0:00)
      const midMs = d.getTime();
      if (midMs >= xMin && midMs <= xMax) {
        const px = xScale.getPixelForValue(midMs);
        ctx.setLineDash([5, 6]);
        ctx.strokeStyle = 'rgba(110,160,255,0.38)';
        ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, bottom); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(110,160,255,0.52)';
        ctx.font = `10px ${Chart.defaults.font.family}`;
        ctx.textAlign = 'center';
        ctx.fillText('0:00', px, top + 11);
      }
      // Noon  (12:00)
      const noonMs = d.getTime() + 12 * MS_PER_HOUR;
      if (noonMs >= xMin && noonMs <= xMax) {
        const px = xScale.getPixelForValue(noonMs);
        ctx.setLineDash([5, 6]);
        ctx.strokeStyle = 'rgba(255,215,60,0.32)';
        ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, bottom); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255,215,60,0.50)';
        ctx.font = `10px ${Chart.defaults.font.family}`;
        ctx.textAlign = 'center';
        ctx.fillText('12:00', px, top + 11);
      }
    }
    ctx.restore();
  }
};

// ─── Chart rendering ──────────────────────────────────────────────────────────

function renderOverlayChart(canvasId, metricLabel, seriesByProvider, metricKey) {
  const ctx = document.getElementById(canvasId);

  if (charts[canvasId]) charts[canvasId].destroy();

  const hours       = Math.min(72, Math.max(6, Number(hoursInput.value) || 24));
  const now         = Date.now();
  const xRangeEnd   = now + hours * MS_PER_HOUR;

  const sharedScales = {
    x: {
      type: 'time',
      min: now,
      max: xRangeEnd,
      time: {
        unit: 'hour',
        displayFormats: { hour: 'HH:mm', day: 'dd.MM.' },
        tooltipFormat: 'dd.MM.yyyy HH:mm'
      },
      ticks: {
        color: 'rgba(255,255,255,0.48)',
        maxRotation: 0,
        font: { size: 11 }
      },
      grid: { display: false }  // vertical lines handled by midnightNoonPlugin
    },
    y: {
      grid: {
        color: 'rgba(255,255,255,0.08)',
        drawTicks: false
      },
      ticks: {
        color: 'rgba(255,255,255,0.48)',
        font: { size: 11 },
        padding: 8
      },
      border: { dash: [4, 4] }
    }
  };

  const datasets = seriesByProvider
    .map((provider, idx) => {
      const data = getMetricSeries(provider.points, metricKey);
      if (data.length === 0) return null;
      const rgb = LINE_COLORS_RGB[idx % LINE_COLORS_RGB.length];
      return {
        label: provider.label,
        data,
        borderColor: LINE_COLORS[idx % LINE_COLORS.length],
        borderWidth: 2,
        borderDash: DASH_PATTERNS[idx % DASH_PATTERNS.length],
        fill: 'origin',
        backgroundColor(context) {
          const chart = context.chart;
          const { ctx: c, chartArea } = chart;
          if (!chartArea) return `rgba(${rgb},0.08)`;
          const g = c.createLinearGradient(0, chartArea.bottom, 0, chartArea.top);
          g.addColorStop(0, 'rgba(255,255,255,0.03)');
          g.addColorStop(1, `rgba(${rgb},0.28)`);
          return g;
        },
        pointRadius: 0,
        tension: 0.25
      };
    })
    .filter(Boolean);

  if (datasets.length === 0) {
    charts[canvasId] = new Chart(ctx, {
      type: 'line',
      data: { datasets: [] },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: sharedScales
      },
      plugins: [
        midnightNoonPlugin,
        {
          id: 'noDataLabel',
          afterDraw(chart) {
            const { ctx: c, width, height } = chart;
            c.save();
            c.textAlign = 'center';
            c.textBaseline = 'middle';
            c.fillStyle = 'rgba(255,255,255,0.40)';
            c.font = `14px ${Chart.defaults.font.family}`;
            c.fillText(`${metricLabel}: keine Daten von den geladenen Quellen`, width / 2, height / 2);
            c.restore();
          }
        }
      ]
    });
    return;
  }

  charts[canvasId] = new Chart(ctx, {
    type: 'line',
    data: { datasets },
    options: {
      parsing: false,
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          labels: {
            color: 'rgba(255,255,255,0.80)',
            font: { size: 11 },
            usePointStyle: true,
            pointStyle: 'line',
            boxWidth: 32,
            padding: 16
          }
        }
      },
      scales: sharedScales
    },
    plugins: [midnightNoonPlugin]
  });
}

async function loadAndRender() {
  try {
    const hours = Math.min(72, Math.max(6, Number(hoursInput.value) || 24));
    const query = locationInput.value.trim() || DEFAULT_LOCATION_QUERY;
    setStatus('Standort wird gesucht …');
    const location = await geocodeLocation(query);
    locationInput.value = location.label;

    // Update weather background without blocking the main data load
    applyWeatherBackground(location);

    setStatus(`Quellen werden geladen … (${location.label})`);
    const { available, unavailable } = await loadAvailableSeries(hours, location);

    if (available.length === 0) {
      throw new Error('Keine verfügbare Wetterquelle lieferte Daten.');
    }

    renderOverlayChart('tempChart', 'Temperatur', available, 'temperature_2m');
    renderOverlayChart('rainChart', 'Regen',      available, 'precipitation');
    renderOverlayChart('uvChart',   'UV-Index',   available, 'uv_index');

    const loadedNames     = available.map((p) => p.label).join(', ');
    const unavailableText = unavailable.length ? ` | Nicht verfügbar: ${unavailable.join('; ')}` : '';
    setStatus(`Fertig: ${available.length} Quelle(n) geladen für ${location.label} (${loadedNames})${unavailableText}`);
  } catch (error) {
    setStatus(`Fehler: ${error.message}`);
  }
}

loadBtn.addEventListener('click', loadAndRender);
hoursInput.addEventListener('change', loadAndRender);
