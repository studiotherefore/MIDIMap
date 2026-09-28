// Stand-in for the Google Maps JavaScript API, served in place of
// maps.googleapis.com during tests. It imitates the behaviours that have
// bitten us with the real library:
//   - it overwrites the container's inline style (position: relative), which
//     once collapsed the viewer to 0px tall and left a black screen;
//   - addListener() returns a handle with remove();
//   - Google's car imagery and member-contributed photos are separate sources.
//     Contributed photos (lh3.googleusercontent.com) get rate-limited (HTTP 429)
//     and render black, so car imagery must be asked for first. Above 80° latitude
//     the mock has no car imagery, to exercise the fallback.
(() => {
  const listeners = {};
  let pov = { heading: 0, pitch: 0 };
  let pano = 'p0';
  let n = 0;
  window.__setPanoCalls = [];

  class StreetViewPanorama {
    constructor(el) {
      window.__pano = this;
      el.setAttribute('style', 'position: relative; background-color: rgb(229, 227, 223); overflow: hidden;');
    }
    addListener(ev, fn) {
      const l = (listeners[ev] ||= []);
      l.push(fn);
      return { remove() { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } };
    }
    fire(ev) { (listeners[ev] || []).forEach((f) => f()); }
    setPov(p) { pov = { ...p }; this.fire('pov_changed'); }
    getPov() { return pov; }
    setPano(id) { pano = id; window.__setPanoCalls.push(id); setTimeout(() => this.fire('pano_changed'), 50); }
    getPano() { return pano; }
    getLinks() { n += 1; return [{ heading: 10, pano: `fwd${n}` }, { heading: 190, pano: `back${n}` }]; }
    getStatus() { return 'OK'; }
    getPosition() { return { lat: () => 1, lng: () => 2 }; }
    getLocation() { return { description: 'Mock St' }; }
  }

  window.__svRequests = [];
  class StreetViewService {
    async getPanorama({ location, sources }) {
      window.__svRequests.push(sources.join(','));
      if (sources.includes('google')) {
        if (location.lat > 80) throw Object.assign(new Error('no car imagery'), { code: 'ZERO_RESULTS' });
        return { data: { location: { pano: 'car-start' } } };
      }
      return { data: { location: { pano: 'photo-start' } } };
    }
  }

  window.google = {
    maps: {
      StreetViewPreference: { NEAREST: 'nearest' },
      StreetViewSource: { OUTDOOR: 'outdoor', GOOGLE: 'google' },
      importLibrary: async () => ({ StreetViewPanorama, StreetViewService }),
    },
  };
  window.__midimapMapsReady();
})();
