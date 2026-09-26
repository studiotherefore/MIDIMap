// Preset locations, one per number key (slots 1–9, then 0).
// heading: compass direction the camera faces on arrival (0 = north, 90 = east).
// pitch:   vertical angle (-90 = down, 0 = horizon, 90 = up).
// mode:    optional, 'drift' (camera turns in place) or 'travel' (camera walks the road).
// pano:    optional Street View panorama id; if present it is used instead of lat/lng.
//
// Shift + number stores the current view into that slot (saved in the browser).

export const DEFAULT_LOCATIONS = {
  1: { name: 'Times Square, New York', lat: 40.7580, lng: -73.9855, heading: 20, pitch: 5 },
  2: { name: 'Shibuya Crossing, Tokyo', lat: 35.6595, lng: 139.7005, heading: 300, pitch: 0 },
  3: { name: 'Pripyat, Ukraine', lat: 51.4058, lng: 30.0561, heading: 90, pitch: 0 },
  4: { name: 'Badwater Road, Death Valley', lat: 36.2305, lng: -116.7670, heading: 180, pitch: 0, mode: 'travel' },
  5: { name: 'Piazza San Marco, Venice', lat: 45.4341, lng: 12.3388, heading: 90, pitch: 5 },
  6: { name: 'Nathan Road, Hong Kong', lat: 22.3080, lng: 114.1717, heading: 0, pitch: 5, mode: 'travel' },
  7: { name: 'US-163, Monument Valley', lat: 37.1011, lng: -109.9895, heading: 180, pitch: 0, mode: 'travel' },
  8: { name: 'Karl-Marx-Allee, Berlin', lat: 52.5178, lng: 13.4350, heading: 90, pitch: 0 },
  9: { name: 'Ring Road near Vík, Iceland', lat: 63.4194, lng: -19.0060, heading: 90, pitch: 0, mode: 'travel' },
  0: { name: 'Champs-Élysées, Paris', lat: 48.8698, lng: 2.3078, heading: 120, pitch: 0 },
};

export const SLOTS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

const STORAGE_KEY = 'midimap.locations.v1';

export function loadLocations() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    saved = {};
  }
  return { ...DEFAULT_LOCATIONS, ...saved };
}

export function saveLocationOverride(slot, loc) {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    saved[slot] = loc;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    /* storage unavailable: the override lives for this session only */
  }
}

export function resetLocations() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_LOCATIONS };
}
