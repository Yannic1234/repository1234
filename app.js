const statusEl = document.getElementById('status');
const loadBtn = document.getElementById('loadBtn');
const hoursInput = document.getElementById('hoursInput');
const postalCodeInput = document.getElementById('postalCodeInput');

const MODELS = ['ecmwf_ifs04', 'gfs_seamless', 'icon_seamless', 'meteofrance_seamless'];

let charts = {};

function setStatus(text) {
  statusEl.textContent = text;
}

function mean(values) {
  const valid = values.filter((v) => Number.isFinite(v));
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
}

function stddev(values, m) {
  const valid = values.filter((v) => Number.isFinite(v));
  if (valid.length < 2 || m == null) return 0;
  const variance = valid.reduce((acc, v) => acc + (v - m) ** 2, 0) / valid.length;
  return Math.sqrt(variance);
}

async function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation wird nicht unterstützt.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos.coords),
      (err) => reject(new Error(`Standort konnte nicht ermittelt werden: ${err.message}`)),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

async function getPositionFromPostalCode(postalCode) {
  const params = new URLSearchParams({
    name: postalCode,
    count: '1',
    language: 'de',
    format: 'json',
    countryCode: 'DE'
  });
  const url = `https://geocoding-api.open-meteo.com/v1/search?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`PLZ-Suche fehlgeschlagen: ${res.status}`);

  const data = await res.json();
  const bestMatch = data?.results?.[0];
  if (!bestMatch || !Number.isFinite(bestMatch.latitude) || !Number.isFinite(bestMatch.longitude)) {
    throw new Error(`Keine Position für PLZ ${postalCode} gefunden.`);
  }

  return {
    latitude: bestMatch.latitude,
    longitude: bestMatch.longitude
  };
}

async function fetchForecast(lat, lon, hours) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    hourly: 'temperature_2m,precipitation,uv_index',
    models: MODELS.join(','),
    forecast_hours: String(hours),
    timezone: 'auto'
  });

  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo Fehler: ${res.status}`);
  return res.json();
}

function combineByTime(hourlyArray, key) {
  const timeMap = new Map();

  for (const modelData of hourlyArray) {
    const times = modelData.time;
    const values = modelData[key];
    times.forEach((t, idx) => {
      if (!timeMap.has(t)) timeMap.set(t, []);
      timeMap.get(t).push(values[idx]);
    });
  }

  return [...timeMap.entries()]
    .sort((a, b) => new Date(a[0]) - new Date(b[0]))
    .map(([time, values]) => {
      const m = mean(values);
      const s = stddev(values, m);
      return {
        x: new Date(time),
        mean: m,
        low: m - s,
        high: m + s
      };
    });
}

function chartDataFromStats(stats) {
  return {
    mean: stats.map((p) => ({ x: p.x, y: p.mean })),
    low: stats.map((p) => ({ x: p.x, y: p.low })),
    high: stats.map((p) => ({ x: p.x, y: p.high }))
  };
}

function renderChart(canvasId, label, stats, color) {
  const ctx = document.getElementById(canvasId);
  const { mean, low, high } = chartDataFromStats(stats);

  if (charts[canvasId]) charts[canvasId].destroy();

  charts[canvasId] = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        {
          label: `${label} Unsicherheit (−1σ)` ,
          data: low,
          borderColor: 'rgba(0,0,0,0)',
          pointRadius: 0
        },
        {
          label: `${label} Unsicherheit (+1σ)`,
          data: high,
          borderColor: 'rgba(0,0,0,0)',
          backgroundColor: color.replace('1)', '0.2)'),
          fill: '-1',
          pointRadius: 0
        },
        {
          label: `${label} Mittelwert`,
          data: mean,
          borderColor: color,
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.25
        }
      ]
    },
    options: {
      parsing: false,
      responsive: true,
      interaction: { mode: 'index', intersect: false },
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
    const postalCode = (postalCodeInput.value || '').trim();
    const isPostalCode = /^\d{5}$/.test(postalCode);
    let coords;

    if (postalCode && !isPostalCode) {
      throw new Error('Bitte eine gültige 5-stellige PLZ eingeben.');
    }

    if (isPostalCode) {
      setStatus(`Standort für PLZ ${postalCode} wird ermittelt …`);
      coords = await getPositionFromPostalCode(postalCode);
    } else {
      setStatus('Standort wird ermittelt …');
      coords = await getPosition();
    }

    setStatus('Vorhersagen werden geladen …');
    const data = await fetchForecast(coords.latitude, coords.longitude, hours);

    if (!Array.isArray(data) || data.length === 0) {
      throw new Error('Keine Daten von der Wetter-API erhalten.');
    }

    const hourlyArray = data.map((m) => m.hourly).filter(Boolean);

    const tempStats = combineByTime(hourlyArray, 'temperature_2m');
    const rainStats = combineByTime(hourlyArray, 'precipitation');
    const uvStats = combineByTime(hourlyArray, 'uv_index');

    renderChart('tempChart', 'Temperatur', tempStats, 'rgba(239, 68, 68, 1)');
    renderChart('rainChart', 'Regen', rainStats, 'rgba(59, 130, 246, 1)');
    renderChart('uvChart', 'UV-Index', uvStats, 'rgba(234, 179, 8, 1)');

    const sourceText = isPostalCode ? `PLZ ${postalCode}` : 'GPS';
    setStatus(
      `Fertig: ${hourlyArray.length} Modelle für ${hours} Stunden. Standort (${sourceText}): ${coords.latitude.toFixed(3)}, ${coords.longitude.toFixed(3)}`
    );
  } catch (error) {
    setStatus(`Fehler: ${error.message}`);
  }
}

loadBtn.addEventListener('click', loadAndRender);
