/**
 * Web Worker for parsing and normalizing flight log data.
 * Handles JSON parse + coordinate conversion without blocking the main thread.
 *
 * Usage:
 *   const worker = new Worker('flight-data-worker.js');
 *   worker.postMessage({ type: 'parse', raw: fileText, fileName: 'flight.json' });
 *   worker.onmessage = (e) => {
 *     if (e.data.type === 'result') handleFlightData(e.data.points);
 *     if (e.data.type === 'error') showError(e.data.message);
 *     if (e.data.type === 'progress') updateProgress(e.data.percent);
 *   };
 */

// --- Constants ---
const METERS_PER_DEG_LAT = 111320;

function metersPerDegLng(lat) {
  return 111320 * Math.cos(lat * Math.PI / 180);
}

function gpsToLocal(lat, lng, alt, refLat, refLng) {
  const latM = (lat - refLat) * METERS_PER_DEG_LAT;
  const lngM = (lng - refLng) * metersPerDegLng(refLat);
  return { x: lngM, y: alt, z: -latM };
}

/**
 * Parse CSV content into flight data points.
 * Supports common formats:
 * - DJI: time,lat,lng,alt,heading,speed,pitch,roll
 * - ArduPilot: timestamp,lat,lng,alt,yaw,groundspeed,pitch,roll
 * - Generic: columns with headers
 */
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return null;

  // Detect if first line is header or data
  const firstLine = lines[0].toLowerCase();
  const hasHeader = /[a-z]/.test(firstLine) && !/^-?[\d.]+/.test(firstLine.split(',')[0].trim());

  const headers = hasHeader ? lines[0].split(',').map(h => h.trim().toLowerCase()) : null;
  const dataStart = hasHeader ? 1 : 0;

  // Map common column names to our field names
  const fieldMap = {
    t: ['t', 'time', 'timestamp', 'time_ms', 'time(s)', 'elapsed'],
    lat: ['lat', 'latitude', 'gps_lat'],
    lng: ['lng', 'lon', 'long', 'longitude', 'gps_lng', 'gps_lon'],
    alt: ['alt', 'altitude', 'alt_m', 'height', 'rel_alt', 'relative_altitude', 'baro_alt'],
    heading: ['heading', 'yaw', 'hdg', 'course', 'direction'],
    speed: ['speed', 'gs', 'groundspeed', 'velocity', 'spd', 'ground_speed'],
    pitch: ['pitch', 'pitch_angle'],
    roll: ['roll', 'roll_angle', 'bank'],
  };

  function findColumnIndex(fieldNames) {
    if (!headers) return -1;
    for (const name of fieldNames) {
      const idx = headers.indexOf(name);
      if (idx !== -1) return idx;
    }
    return -1;
  }

  // Build column index map
  let colMap;
  if (headers) {
    colMap = {};
    for (const [key, names] of Object.entries(fieldMap)) {
      colMap[key] = findColumnIndex(names);
    }
  } else {
    // No header: assume standard column order
    // t, lat, lng, alt, heading, speed, pitch, roll
    colMap = { t: 0, lat: 1, lng: 2, alt: 3, heading: 4, speed: 5, pitch: 6, roll: 7 };
  }

  const points = [];
  for (let i = dataStart; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    const cols = line.split(',').map(c => c.trim());
    if (cols.length < 2) continue;

    const getVal = (key, defaultVal) => {
      const idx = colMap[key];
      if (idx === undefined || idx === -1 || idx >= cols.length) return defaultVal;
      const v = parseFloat(cols[idx]);
      return isNaN(v) ? defaultVal : v;
    };

    const lat = getVal('lat', 0);
    const lng = getVal('lng', 0);
    const alt = getVal('alt', 0);

    points.push({
      t: getVal('t', i - dataStart),
      lat,
      lng,
      alt,
      heading: getVal('heading', 0),
      speed: getVal('speed', 0),
      pitch: getVal('pitch', 0),
      roll: getVal('roll', 0),
    });
  }

  return points.length > 0 ? points : null;
}

/**
 * Normalize raw points into internal flight data format.
 */
function normalizePoints(rawPoints, refLat, refLng) {
  if (!refLat) refLat = rawPoints[0]?.lat || 39.992;
  if (!refLng) refLng = rawPoints[0]?.lng || 116.305;

  const result = rawPoints.map((p, i) => {
    const lat = p.lat != null ? p.lat : refLat;
    const lng = p.lng != null ? p.lng : refLng;
    const y = p.alt != null ? p.alt : (p.y != null ? p.y : 0);

    let x, z;
    if (p.x != null && p.z != null) {
      x = p.x;
      z = p.z;
    } else {
      const local = gpsToLocal(lat, lng, y, refLat, refLng);
      x = local.x;
      z = local.z;
    }

    return {
      t: p.t != null ? p.t : (p.timestamp != null ? p.timestamp : i),
      x, y, z,
      heading: p.heading || p.yaw || 0,
      speed: p.speed || 0,
      pitch: p.pitch || 0,
      roll: p.roll || 0,
      lat, lng,
      alt: y,
    };
  });

  // Normalize time to start from 0
  const t0 = result[0].t;
  result.forEach(p => p.t -= t0);

  return result;
}

// --- Message Handler ---
self.onmessage = function (e) {
  const { type, raw, fileName } = e.data;

  if (type !== 'parse') return;

  try {
    let rawPoints;
    const isCSV = fileName ? /\.csv$/i.test(fileName) : false;

    if (isCSV) {
      rawPoints = parseCSV(raw);
      if (!rawPoints) {
        self.postMessage({ type: 'error', message: 'CSV 解析失败 — 未识别格式 / Failed to parse CSV — unrecognized format' });
        return;
      }
    } else {
      // JSON
      const parsed = JSON.parse(raw);
      rawPoints = Array.isArray(parsed) ? parsed : (parsed.points || parsed.trajectory || []);

      if (rawPoints.length < 2) {
        self.postMessage({ type: 'error', message: '数据点数不足 / Not enough data points (need >= 2)' });
        return;
      }
    }

    self.postMessage({ type: 'progress', percent: 50 });

    const points = normalizePoints(rawPoints);

    self.postMessage({ type: 'progress', percent: 90 });

    // Compute stats
    let maxAlt = 0, maxSpeed = 0, totalDist = 0;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.alt > maxAlt) maxAlt = p.alt;
      if (p.speed > maxSpeed) maxSpeed = p.speed;
      if (i > 0) {
        const dx = p.x - points[i - 1].x;
        const dy = p.y - points[i - 1].y;
        const dz = p.z - points[i - 1].z;
        totalDist += Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
    }

    self.postMessage({
      type: 'result',
      points,
      stats: {
        totalDist: Math.round(totalDist),
        maxAlt: Math.round(maxAlt),
        maxSpeed: maxSpeed,
        pointCount: points.length,
        duration: points[points.length - 1].t,
      },
    });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
