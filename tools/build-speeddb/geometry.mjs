/**
 * Geometry helpers for the database build.
 *
 * Coordinates are GeoJSON order, `[lon, lat]`, matching the osmium export.
 */

const METRES_PER_DEGREE_LAT = 110_574;
const METRES_PER_DEGREE_LON_EQUATOR = 111_320;
const DEG_TO_RAD = Math.PI / 180;

/** Grid cell size in degrees; 0.01 deg is about 1.1 km north-south. */
export const CELL_DEGREES = 0.01;
const CELL_LAT_OFFSET = 9_000;
const CELL_LON_OFFSET = 18_000;
const CELL_LON_SPAN = 40_000;

/** Fixed-point scale used to store coordinates as integers. */
export const COORD_SCALE = 1e7;

/** Initial bearing from one point to another, in degrees clockwise from north. */
export function bearingDegrees(lon1, lat1, lon2, lat2) {
  const phi1 = lat1 * DEG_TO_RAD;
  const phi2 = lat2 * DEG_TO_RAD;
  const deltaLambda = (lon2 - lon1) * DEG_TO_RAD;

  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);

  const degrees = Math.atan2(y, x) / DEG_TO_RAD;
  return Math.round((degrees + 360) % 360) % 360;
}

/**
 * Simplifies a polyline with the Douglas-Peucker algorithm.
 *
 * Distances are computed in a local equirectangular projection, which is
 * accurate to well under a metre over the length of a single OSM way.
 *
 * @param {Array<[number, number]>} points `[lon, lat]` pairs
 * @param {number} toleranceMetres maximum allowed deviation from the original line
 * @returns {Array<[number, number]>}
 */
export function simplify(points, toleranceMetres) {
  if (points.length <= 2) return points;

  const latScale = METRES_PER_DEGREE_LAT;
  const lonScale = METRES_PER_DEGREE_LON_EQUATOR * Math.cos(points[0][1] * DEG_TO_RAD);
  const toleranceSquared = toleranceMetres * toleranceMetres;

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  // Explicit stack: some OSM ways carry thousands of nodes.
  const stack = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [first, last] = stack.pop();
    if (last - first < 2) continue;

    let farthest = -1;
    let farthestDistance = -1;

    const ax = points[first][0] * lonScale;
    const ay = points[first][1] * latScale;
    const bx = points[last][0] * lonScale;
    const by = points[last][1] * latScale;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;

    for (let index = first + 1; index < last; index += 1) {
      const px = points[index][0] * lonScale;
      const py = points[index][1] * latScale;

      let distanceSquared;
      if (lengthSquared === 0) {
        distanceSquared = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        let t = ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        distanceSquared = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
      }

      if (distanceSquared > farthestDistance) {
        farthestDistance = distanceSquared;
        farthest = index;
      }
    }

    if (farthestDistance > toleranceSquared) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }

  const result = [];
  for (let index = 0; index < points.length; index += 1) {
    if (keep[index] === 1) result.push(points[index]);
  }
  return result;
}

/** Encodes a coordinate into a grid cell identifier. */
export function cellId(lon, lat) {
  const latIndex = Math.floor(lat / CELL_DEGREES) + CELL_LAT_OFFSET;
  const lonIndex = Math.floor(lon / CELL_DEGREES) + CELL_LON_OFFSET;
  return latIndex * CELL_LON_SPAN + lonIndex;
}

/**
 * Every grid cell touched by a segment's bounding box.
 *
 * A simplified segment can be kilometres long, so it must be registered in all
 * the cells it crosses rather than only the one holding its midpoint.
 */
export function cellIdsForSegment(lon1, lat1, lon2, lat2) {
  const minLatIndex = Math.floor(Math.min(lat1, lat2) / CELL_DEGREES);
  const maxLatIndex = Math.floor(Math.max(lat1, lat2) / CELL_DEGREES);
  const minLonIndex = Math.floor(Math.min(lon1, lon2) / CELL_DEGREES);
  const maxLonIndex = Math.floor(Math.max(lon1, lon2) / CELL_DEGREES);

  const ids = [];
  for (let latIndex = minLatIndex; latIndex <= maxLatIndex; latIndex += 1) {
    for (let lonIndex = minLonIndex; lonIndex <= maxLonIndex; lonIndex += 1) {
      ids.push((latIndex + CELL_LAT_OFFSET) * CELL_LON_SPAN + (lonIndex + CELL_LON_OFFSET));
    }
  }
  return ids;
}

/** Converts a degree value into the fixed-point integer stored in the database. */
export function toFixed(degrees) {
  return Math.round(degrees * COORD_SCALE);
}
