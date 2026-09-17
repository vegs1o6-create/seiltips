// Proxies MET Norway's Locationforecast API (yr.no) and aggregates the raw
// timeseries into a 7-day forecast with sailing tips. Called from the Worker
// entry point (worker/index.js) for requests to /api/weather.
//
// MET Norway's Terms of Service require every client to send an identifying
// User-Agent header (https://api.met.no/doc/TermsOfService). Update the
// contact URL below if you fork this project for a different domain.
const MET_USER_AGENT = 'seiltips.no weather-proxy/1.0 (+https://seiltips.no)';
const UPSTREAM_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';

// Rough bounding box covering Oslofjorden south to Kosterøyene in Sweden, so
// this proxy can't be used as a general-purpose weather relay for arbitrary
// locations.
const BOUNDS = { minLat: 58.7, maxLat: 60.0, minLon: 10.0, maxLon: 11.6 };

const MS_TO_KNOTS = 1.943_844;

function jsonResponse(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      ...extraHeaders,
    },
  });
}

function dateKeyOslo(isoTime) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(isoTime));
}

function hourOslo(isoTime) {
  return Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Oslo',
      hour: '2-digit',
      hour12: false,
    }).format(new Date(isoTime))
  );
}

function buildSailingTips({ maxWindKnots, precipMm, minTemp }) {
  const tips = [];

  if (maxWindKnots >= 25) {
    tips.push('Kuling eller mer er varslet – vurder å holde deg i havn.');
  } else if (maxWindKnots >= 17) {
    tips.push('Frisk bris ventet – rev tidlig og dobbeltsjekk at alt er sikret.');
  } else if (maxWindKnots >= 8) {
    tips.push('Fine seilingsforhold med god og stabil drivkraft.');
  } else if (maxWindKnots < 4) {
    tips.push('Svak vind – ha motoren klar som backup.');
  }

  if (precipMm >= 5) {
    tips.push('Mye nedbør ventet – ta med godt regntøy.');
  } else if (precipMm >= 0.5) {
    tips.push('Litt nedbør i vente – ha regntøyet lett tilgjengelig.');
  }

  if (minTemp < 5) {
    tips.push('Kaldt på sjøen – kle deg i lag, og ha lue og hansker klart.');
  } else if (minTemp > 18) {
    tips.push('Godt sommervær – husk solkrem og nok å drikke.');
  }

  if (tips.length === 0) {
    tips.push('Rolige forhold – en fin dag for en tur på sjøen.');
  }

  return tips;
}

function aggregateByDay(timeseries) {
  const days = new Map();

  for (const entry of timeseries) {
    const key = dateKeyOslo(entry.time);
    if (!days.has(key)) {
      days.set(key, {
        date: key,
        temps: [],
        windSpeeds: [],
        windDirections: [],
        precipitation: 0,
        symbolCandidates: [],
      });
    }
    const day = days.get(key);

    const instant = entry.data?.instant?.details;
    if (instant) {
      if (typeof instant.air_temperature === 'number') day.temps.push(instant.air_temperature);
      if (typeof instant.wind_speed === 'number') day.windSpeeds.push(instant.wind_speed);
      if (typeof instant.wind_from_direction === 'number')
        day.windDirections.push({ hour: hourOslo(entry.time), dir: instant.wind_from_direction });
    }

    const next6 = entry.data?.next_6_hours;
    if (next6?.details && typeof next6.details.precipitation_amount === 'number') {
      day.precipitation += next6.details.precipitation_amount;
    }
    if (next6?.summary?.symbol_code) {
      day.symbolCandidates.push({ hour: hourOslo(entry.time), symbol: next6.summary.symbol_code, weight: 2 });
    }

    const next1 = entry.data?.next_1_hours;
    if (next1?.details && typeof next1.details.precipitation_amount === 'number' && !next6) {
      day.precipitation += next1.details.precipitation_amount;
    }
    if (next1?.summary?.symbol_code) {
      day.symbolCandidates.push({ hour: hourOslo(entry.time), symbol: next1.summary.symbol_code, weight: 1 });
    }
  }

  return [...days.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((day) => {
      const minTemp = day.temps.length ? Math.min(...day.temps) : null;
      const maxTemp = day.temps.length ? Math.max(...day.temps) : null;
      const maxWindMs = day.windSpeeds.length ? Math.max(...day.windSpeeds) : null;
      const maxWindKnots = maxWindMs !== null ? maxWindMs * MS_TO_KNOTS : null;

      const closestToNoon = day.symbolCandidates.length
        ? day.symbolCandidates.reduce((best, candidate) => {
            const bestDistance = Math.abs(best.hour - 12) - best.weight * 0.1;
            const candidateDistance = Math.abs(candidate.hour - 12) - candidate.weight * 0.1;
            return candidateDistance < bestDistance ? candidate : best;
          })
        : null;

      const windDirection = day.windDirections.length
        ? day.windDirections.reduce((best, candidate) =>
            Math.abs(candidate.hour - 12) < Math.abs(best.hour - 12) ? candidate : best
          ).dir
        : null;

      const precipitation = Math.round(day.precipitation * 10) / 10;

      return {
        date: day.date,
        minTemp: minTemp !== null ? Math.round(minTemp) : null,
        maxTemp: maxTemp !== null ? Math.round(maxTemp) : null,
        maxWindMs: maxWindMs !== null ? Math.round(maxWindMs * 10) / 10 : null,
        maxWindKnots: maxWindKnots !== null ? Math.round(maxWindKnots) : null,
        windDirection,
        precipitation,
        symbolCode: closestToNoon?.symbol ?? null,
        tips: buildSailingTips({
          maxWindKnots: maxWindKnots ?? 0,
          precipMm: precipitation,
          minTemp: minTemp ?? 10,
        }),
      };
    })
    .slice(0, 7);
}

export async function handleWeatherRequest(request, waitUntil) {
  const { searchParams } = new URL(request.url);
  const lat = Number.parseFloat(searchParams.get('lat') ?? '');
  const lon = Number.parseFloat(searchParams.get('lon') ?? '');

  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return jsonResponse({ error: 'Mangler eller ugyldig lat/lon.' }, 400);
  }
  if (lat < BOUNDS.minLat || lat > BOUNDS.maxLat || lon < BOUNDS.minLon || lon > BOUNDS.maxLon) {
    return jsonResponse({ error: 'Posisjonen er utenfor støttet område (Oslofjorden til Kosterøyene).' }, 400);
  }

  // Round to 4 decimals as recommended by MET Norway, both for cache-friendliness
  // and to respect their guidance on coordinate precision.
  const roundedLat = lat.toFixed(4);
  const roundedLon = lon.toFixed(4);

  const cacheKey = new Request(
    `https://cache.seiltips.no/weather?lat=${roundedLat}&lon=${roundedLon}`,
    request
  );
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const upstreamUrl = `${UPSTREAM_URL}?lat=${roundedLat}&lon=${roundedLon}`;
  const upstreamResponse = await fetch(upstreamUrl, {
    headers: { 'User-Agent': MET_USER_AGENT },
  });

  if (!upstreamResponse.ok) {
    return jsonResponse(
      { error: 'Klarte ikke å hente værdata fra MET Norway akkurat nå.' },
      upstreamResponse.status === 429 ? 429 : 502
    );
  }

  const data = await upstreamResponse.json();
  const timeseries = data?.properties?.timeseries ?? [];
  const days = aggregateByDay(timeseries);

  const response = jsonResponse(
    {
      lat: Number(roundedLat),
      lon: Number(roundedLon),
      updatedAt: data?.properties?.meta?.updated_at ?? null,
      days,
      attribution: 'Værdata fra MET Norway (yr.no), lisensiert under NLOD.',
    },
    200,
    { 'cache-control': 'public, max-age=600' }
  );

  waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
