const EARTH_RADIUS_KM = 6371;
const DEFAULT_SPEED_KMH = 40;

export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

export function haversineEtaMinutes(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
  speedKmh = DEFAULT_SPEED_KMH,
): number {
  const km = haversineKm(lat1, lng1, lat2, lng2);
  return Math.max(1, (km / speedKmh) * 60);
}

export function inBoundingBox(
  lat: number,
  lng: number,
  minLat: number,
  maxLat: number,
  minLng: number,
  maxLng: number,
  pad = 0.15,
): boolean {
  return (
    lat >= minLat - pad &&
    lat <= maxLat + pad &&
    lng >= minLng - pad &&
    lng <= maxLng + pad
  );
}
