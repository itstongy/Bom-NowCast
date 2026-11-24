'use strict';

const RADARS = {
  // Brisbane / SE Queensland
  IDR664: { name: 'Brisbane (Mt Stapylton 64 km)', radarLat: -27.718, radarLon: 153.240, radiusKm: 64, loopUrl: 'https://reg.bom.gov.au/products/IDR664.loop.shtml' },
  IDR663: { name: 'Brisbane (Mt Stapylton 128 km)', radarLat: -27.718, radarLon: 153.240, radiusKm: 128, loopUrl: 'https://reg.bom.gov.au/products/IDR663.loop.shtml' },
  IDR662: { name: 'Brisbane (Mt Stapylton 256 km)', radarLat: -27.718, radarLon: 153.240, radiusKm: 256, loopUrl: 'https://reg.bom.gov.au/products/IDR662.loop.shtml' },
  IDR503: { name: 'Brisbane (Marburg 128 km)', radarLat: -27.610, radarLon: 152.540, radiusKm: 128, loopUrl: 'https://reg.bom.gov.au/products/IDR503.loop.shtml' },
  IDR502: { name: 'Brisbane (Marburg 256 km)', radarLat: -27.610, radarLon: 152.540, radiusKm: 256, loopUrl: 'https://reg.bom.gov.au/products/IDR502.loop.shtml' },
  IDR083: { name: 'Gympie (Mt Kanigan 128 km)', radarLat: -25.957, radarLon: 152.577, radiusKm: 128, loopUrl: 'https://reg.bom.gov.au/products/IDR083.loop.shtml' },

  // Regional Queensland
  IDR193: { name: 'Cairns (Saddle Mtn 128 km)', radarLat: -16.817, radarLon: 145.683, radiusKm: 128, loopUrl: 'https://reg.bom.gov.au/products/IDR193.loop.shtml' },
  IDR733: { name: 'Townsville (Hervey Range 128 km)', radarLat: -19.420, radarLon: 146.551, radiusKm: 128, loopUrl: 'https://reg.bom.gov.au/products/IDR733.loop.shtml' },

  // Sydney / NSW / ACT
  IDR714: { name: 'Sydney (Terrey Hills 64 km)', radarLat: -33.707, radarLon: 151.210, radiusKm: 64, loopUrl: 'https://reg.bom.gov.au/products/IDR714.loop.shtml' },
  IDR713: { name: 'Sydney (Terrey Hills 128 km)', radarLat: -33.707, radarLon: 151.210, radiusKm: 128, loopUrl: 'https://reg.bom.gov.au/products/IDR713.loop.shtml' },
  IDR712: { name: 'Sydney (Terrey Hills 256 km)', radarLat: -33.707, radarLon: 151.210, radiusKm: 256, loopUrl: 'https://reg.bom.gov.au/products/IDR712.loop.shtml' },
  IDR043: { name: 'Newcastle (128 km)', radarLat: -32.730, radarLon: 152.027, radiusKm: 128, loopUrl: 'https://reg.bom.gov.au/products/IDR043.loop.shtml' },
  IDR033: { name: 'Wollongong (Appin 128 km)', radarLat: -34.264, radarLon: 150.874, radiusKm: 128, loopUrl: 'https://reg.bom.gov.au/products/IDR033.loop.shtml' },
  IDR403: { name: 'Canberra (Captains Flat 128 km)', radarLat: -35.661, radarLon: 149.512, radiusKm: 128, loopUrl: 'https://reg.bom.gov.au/products/IDR403.loop.shtml' },

  // Melbourne / VIC
  IDR024: { name: 'Melbourne (Laverton 64 km)', radarLat: -37.855, radarLon: 144.752, radiusKm: 64, loopUrl: 'https://reg.bom.gov.au/products/IDR024.loop.shtml' },
  IDR023: { name: 'Melbourne (Laverton 128 km)', radarLat: -37.855, radarLon: 144.752, radiusKm: 128, loopUrl: 'https://reg.bom.gov.au/products/IDR023.loop.shtml' },
  IDR022: { name: 'Melbourne (Laverton 256 km)', radarLat: -37.855, radarLon: 144.752, radiusKm: 256, loopUrl: 'https://reg.bom.gov.au/products/IDR022.loop.shtml' },

  // Adelaide / SA
  IDR644: { name: 'Adelaide (Buckland Park 64 km)', radarLat: -34.615, radarLon: 138.469, radiusKm: 64, loopUrl: 'https://reg.bom.gov.au/products/IDR644.loop.shtml' },
  IDR643: { name: 'Adelaide (Buckland Park 128 km)', radarLat: -34.615, radarLon: 138.469, radiusKm: 128, loopUrl: 'https://reg.bom.gov.au/products/IDR643.loop.shtml' },

  // Perth / WA
  IDR704: { name: 'Perth (Serpentine 64 km)', radarLat: -32.404, radarLon: 115.977, radiusKm: 64, loopUrl: 'https://reg.bom.gov.au/products/IDR704.loop.shtml' },
  IDR703: { name: 'Perth (Serpentine 128 km)', radarLat: -32.404, radarLon: 115.977, radiusKm: 128, loopUrl: 'https://reg.bom.gov.au/products/IDR703.loop.shtml' },

  // Darwin / NT
  IDR634: { name: 'Darwin (Berrimah 64 km)', radarLat: -12.457, radarLon: 130.926, radiusKm: 64, loopUrl: 'https://reg.bom.gov.au/products/IDR634.loop.shtml' },
  IDR633: { name: 'Darwin (Berrimah 128 km)', radarLat: -12.457, radarLon: 130.926, radiusKm: 128, loopUrl: 'https://reg.bom.gov.au/products/IDR633.loop.shtml' },

  // Hobart / TAS
  IDR764: { name: 'Hobart (Mt Koonya 64 km)', radarLat: -42.881, radarLon: 147.330, radiusKm: 64, loopUrl: 'https://reg.bom.gov.au/products/IDR764.loop.shtml' },
  IDR763: { name: 'Hobart (Mt Koonya 128 km)', radarLat: -42.881, radarLon: 147.330, radiusKm: 128, loopUrl: 'https://reg.bom.gov.au/products/IDR763.loop.shtml' },
};

function latlonDeltaKm(lat0, lon0, lat1, lon1) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const lat0r = toRad(lat0);
  const lat1r = toRad(lat1);
  const dlat = toRad(lat1 - lat0);
  const dlon = toRad(lon1 - lon0);
  const x = dlon * Math.cos((lat0r + lat1r) / 2);
  const y = dlat;
  return { dxKm: x * R, dyKm: y * R };
}

function distanceKm(lat0, lon0, lat1, lon1) {
  const { dxKm, dyKm } = latlonDeltaKm(lat0, lon0, lat1, lon1);
  return Math.hypot(dxKm, dyKm);
}

function latlonToPixel({ radarLat, radarLon, radiusKm }, targetLat, targetLon, width, height) {
  if (width !== height) throw new Error('expected square radar image');
  const { dxKm, dyKm } = latlonDeltaKm(radarLat, radarLon, targetLat, targetLon);
  const radiusPx = width / 2;
  const kmPerPx = radiusKm / radiusPx;
  const cx = width / 2;
  const cy = height / 2;
  const x = Math.round(cx + dxKm / kmPerPx);
  const y = Math.round(cy - dyKm / kmPerPx);
  if (x < 0 || y < 0 || x >= width || y >= height) {
    throw new Error('target outside image bounds');
  }
  return { x, y, kmPerPx };
}

function orderedRadarsForLocation(preferred, targetLoc) {
  const result = [];
  if (preferred && RADARS[preferred]) {
    result.push(preferred);
  }

  const others = Object.keys(RADARS).filter((id) => id !== preferred);
  if (targetLoc && typeof targetLoc.lat === 'number' && typeof targetLoc.lon === 'number') {
    const scored = others.map((id) => {
      const r = RADARS[id];
      const dist = distanceKm(r.radarLat, r.radarLon, targetLoc.lat, targetLoc.lon);
      const inside = dist <= r.radiusKm * 0.95;
      return { id, dist, inside, radiusKm: r.radiusKm };
    });
    scored.sort((a, b) => {
      if (a.inside !== b.inside) return a.inside ? -1 : 1;
      if (a.inside && b.inside) {
        // Both cover the target: prefer higher resolution (smaller radius), then closer radar.
        if (a.radiusKm !== b.radiusKm) return a.radiusKm - b.radiusKm;
        return a.dist - b.dist;
      }
      return a.dist - b.dist;
    });
    // Prefer radars that cover the location; only include up to 4 candidates so fallback stays fast.
    const covering = scored.filter((s) => s.inside).map((s) => s.id);
    if (covering.length > 0) {
      result.push(...covering);
    } else {
      result.push(...scored.slice(0, 4).map((s) => s.id));
    }
  } else {
    result.push(...others.slice(0, 4));
  }

  return result;
}

module.exports = {
  RADARS,
  latlonDeltaKm,
  distanceKm,
  latlonToPixel,
  orderedRadarsForLocation,
};
