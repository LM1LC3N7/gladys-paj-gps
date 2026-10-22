// -----------------------------------------------------------------------------
// Distance to home and presence (pure). The houses of Gladys (read with
// `location: true`) and the positions stay in memory: never logged, never
// written to /data.
// -----------------------------------------------------------------------------

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in meters (haversine). */
export function distanceMeters(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The distance in meters to the nearest house (rounded to the meter), or null. */
export function distanceHome(point, houses) {
  if (!point || !Array.isArray(houses) || houses.length === 0) return null;
  let best = null;
  for (const house of houses) {
    const d = distanceMeters(point, house);
    if (best === null || d < best) best = d;
  }
  return best === null ? null : Math.round(best);
}

/** Margin to leave home: a position jitters (half the radius, 100 m at least). */
export const leaveMargin = (radius) => Math.max(100, radius / 2);

/**
 * At home (1) or away (0), with a margin against the jitter of a position:
 * at home within the radius, away beyond the radius plus the margin, and in
 * between the previous value (away when there is none). Null without a
 * distance.
 */
export function presence(distance, radius, previous = null) {
  if (distance === null || distance === undefined) return null;
  if (distance <= radius) return 1;
  if (distance > radius + leaveMargin(radius)) return 0;
  return previous === 1 ? 1 : 0;
}

/** The located houses of `getHouses()`: [{ lat, lon }] (names and selectors not kept). */
export function housesOf(list) {
  if (!Array.isArray(list)) return [];
  const houses = [];
  for (const house of list) {
    const lat = Number(house?.latitude);
    const lon = Number(house?.longitude);
    if (house?.latitude === null || house?.longitude === null) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) continue;
    houses.push({ lat, lon });
  }
  return houses;
}
