// Turn the fragmented MP4 that Chrome's MediaRecorder writes into an ordinary
// ("progressive") MP4: one moov with full sample tables, placed before one
// mdat. QuickTime Player plays fragmented files but refuses to trim or export
// them ("Clip is not editable / not exportable"); after this it does both.
//
// Nothing is decoded or re-encoded: the sample data is referenced from the
// original Blob by slices, so even a 1 GB recording costs only a few small reads.
//
//   const fixed = await flattenMp4(blob, { fps: 30 });   // a new Blob, type video/mp4
//   (fps, optional: put the pictures' times on a steady 1/fps grid)
//
// Handles what Chrome writes (H.264 + AAC or Opus, one moof/mdat per
// timeslice); anything it doesn't understand throws, and the caller keeps
// the original file.

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'mvex', 'moof', 'traf']);

const str4 = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
const u64 = (dv, o) => dv.getUint32(o) * 2 ** 32 + dv.getUint32(o + 4);

// The boxes inside [start, end) of a buffer: { type, start, size, body }.
function boxes(buf, start = 0, end = buf.byteLength) {
  const dv = new DataView(buf);
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = str4(dv, p + 4);
    let hdr = 8;
    if (size === 1) { size = u64(dv, p + 8); hdr = 16; } else if (size === 0) size = end - p;
    if (size < hdr) throw new Error(`bad box ${type}`);
    out.push({ type, start: p, size, body: p + hdr, end: p + size });
    p += size;
  }
  return out;
}
const child = (buf, box, type) => boxes(buf, box.body, box.end).find((b) => b.type === type);
const children = (buf, box, type) => boxes(buf, box.body, box.end).filter((b) => b.type === type);

// Read the top level of the file without loading the media data.
async function topLevel(blob) {
  const out = [];
  let p = 0;
  while (p + 8 <= blob.size) {
    const dv = new DataView(await blob.slice(p, p + 16).arrayBuffer());
    let size = dv.getUint32(0);
    const type = str4(dv, 4);
    let hdr = 8;
    if (size === 1) { size = u64(dv, 8); hdr = 16; } else if (size === 0) size = blob.size - p;
    if (size < hdr) throw new Error(`bad box ${type} at ${p}`);
    out.push({ type, start: p, size, body: p + hdr });
    p += size;
  }
  return out;
}

// ---- writing boxes ----

function box(type, ...parts) {
  const len = 8 + parts.reduce((n, x) => n + x.byteLength, 0);
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let o = 8;
  for (const x of parts) { out.set(x instanceof Uint8Array ? x : new Uint8Array(x), o); o += x.byteLength; }
  return out;
}
function fullbox(type, version, flags, ...parts) {
  const head = new Uint8Array([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]);
  return box(type, head, ...parts);
}
function u32s(values) {
  const out = new Uint8Array(values.length * 4);
  const dv = new DataView(out.buffer);
  values.forEach((v, i) => dv.setUint32(i * 4, v >>> 0));
  return out;
}
const copy = (buf, b) => new Uint8Array(buf.slice(b.start, b.end));

// Put a duration into an mvhd / tkhd / mdhd (copied), in its own timescale.
function withDuration(buf, b, duration) {
  const out = copy(buf, b);
  const dv = new DataView(out.buffer);
  const hdr = b.body - b.start;
  const v = dv.getUint8(hdr);
  // mvhd/mdhd: version, flags, created, modified, timescale, duration. tkhd: version, flags, created, modified, track id, reserved, duration.
  const at = { mvhd: v ? hdr + 4 + 16 + 4 : hdr + 4 + 8 + 4, mdhd: v ? hdr + 4 + 16 + 4 : hdr + 4 + 8 + 4, tkhd: v ? hdr + 4 + 16 + 8 : hdr + 4 + 8 + 8 }[b.type];
  if (v) { dv.setUint32(at, Math.floor(duration / 2 ** 32)); dv.setUint32(at + 4, duration >>> 0); } else dv.setUint32(at, Math.min(duration, 0xffffffff));
  return out;
}
function timescaleOf(buf, b) { // mvhd or mdhd
  const dv = new DataView(buf);
  const v = dv.getUint8(b.body);
  return dv.getUint32(b.body + 4 + (v ? 16 : 8));
}

export async function flattenMp4(blob, { fps } = {}) {
  const top = await topLevel(blob);
  const moovBox = top.find((b) => b.type === 'moov');
  if (!moovBox) throw new Error('no moov');
  if (!top.some((b) => b.type === 'moof')) return blob; // already an ordinary MP4
  const mbuf = await blob.slice(moovBox.start, moovBox.start + moovBox.size).arrayBuffer();
  const moov = boxes(mbuf)[0];
  const mvhd = child(mbuf, moov, 'mvhd');
  const movieScale = timescaleOf(mbuf, mvhd);

  // Tracks and their defaults (trex).
  const tracks = new Map();
  for (const trak of children(mbuf, moov, 'trak')) {
    const tkhd = child(mbuf, trak, 'tkhd');
    const dv = new DataView(mbuf);
    const id = dv.getUint32(tkhd.body + 4 + (dv.getUint8(tkhd.body) ? 16 : 8));
    const mdia = child(mbuf, trak, 'mdia');
    const hdlr = child(mbuf, mdia, 'hdlr');
    const video = !!hdlr && new TextDecoder().decode(new Uint8Array(mbuf, hdlr.body + 8, 4)) === 'vide';
    tracks.set(id, { id, trak, tkhd, mdia, video, scale: timescaleOf(mbuf, child(mbuf, mdia, 'mdhd')), samples: [], chunks: [], firstDts: null, def: {} });
  }
  const mvex = child(mbuf, moov, 'mvex');
  if (mvex) {
    const dv = new DataView(mbuf);
    for (const trex of children(mbuf, mvex, 'trex')) {
      const t = tracks.get(dv.getUint32(trex.body + 4));
      if (t) t.def = { duration: dv.getUint32(trex.body + 12), size: dv.getUint32(trex.body + 16), flags: dv.getUint32(trex.body + 20) };
    }
  }

  // Every fragment: where each sample is, how long, whether it's a key frame.
  for (const mf of top.filter((b) => b.type === 'moof')) {
    const fbuf = await blob.slice(mf.start, mf.start + mf.size).arrayBuffer();
    const dv = new DataView(fbuf);
    const moof = boxes(fbuf)[0];
    for (const traf of children(fbuf, moof, 'traf')) {
      const tfhd = child(fbuf, traf, 'tfhd');
      const tf = dv.getUint32(tfhd.body) & 0xffffff;
      const t = tracks.get(dv.getUint32(tfhd.body + 4));
      if (!t) continue;
      let o = tfhd.body + 8;
      let base = mf.start; // default-base-is-moof (and the usual case without a base offset)
      if (tf & 0x1) { base = u64(dv, o); o += 8; }
      if (tf & 0x2) o += 4;
      const dDur = tf & 0x8 ? dv.getUint32((o += 4) - 4) : t.def.duration;
      const dSize = tf & 0x10 ? dv.getUint32((o += 4) - 4) : t.def.size;
      const dFlags = tf & 0x20 ? dv.getUint32((o += 4) - 4) : t.def.flags;
      const tfdt = child(fbuf, traf, 'tfdt');
      let dts = tfdt ? (dv.getUint8(tfdt.body) ? u64(dv, tfdt.body + 4) : dv.getUint32(tfdt.body + 4)) : null;
      if (dts === null) dts = t.samples.length ? t.nextDts : 0;
      if (t.firstDts === null) t.firstDts = dts;
      for (const trun of children(fbuf, traf, 'trun')) {
        const v = dv.getUint8(trun.body);
        const rf = dv.getUint32(trun.body) & 0xffffff;
        const n = dv.getUint32(trun.body + 4);
        let q = trun.body + 8;
        let dataOffset = 0;
        if (rf & 0x1) { dataOffset = dv.getInt32(q); q += 4; }
        let firstFlags = null;
        if (rf & 0x4) { firstFlags = dv.getUint32(q); q += 4; }
        let pos = base + dataOffset;
        const chunk = { offset: pos, size: 0, count: 0 };
        for (let i = 0; i < n; i++) {
          const dur = rf & 0x100 ? dv.getUint32((q += 4) - 4) : dDur;
          const size = rf & 0x200 ? dv.getUint32((q += 4) - 4) : dSize;
          let flags = rf & 0x400 ? dv.getUint32((q += 4) - 4) : dFlags;
          if (i === 0 && firstFlags !== null) flags = firstFlags;
          const cto = rf & 0x800 ? (v ? dv.getInt32((q += 4) - 4) : dv.getUint32((q += 4) - 4)) : 0;
          t.samples.push({ dur, size, sync: !(flags & 0x10000), cto });
          pos += size;
          chunk.size += size;
          chunk.count++;
          dts += dur;
        }
        if (chunk.count) t.chunks.push(chunk);
      }
      t.nextDts = dts;
    }
  }

  // A steady frame rate: each picture's time put on the nearest step of the
  // 1/fps grid (counted from the first picture, so it keeps its place against
  // the sound). Two pictures never share a step; a dropped one leaves a
  // picture on screen for two steps.
  if (fps) {
    for (const t of tracks.values()) {
      if (!t.video || !t.samples.length) continue;
      const g = t.scale / fps;
      let dts = 0;
      let prev = -1;
      const steps = t.samples.map((s) => { const k = Math.max(prev + 1, Math.round(dts / g)); dts += s.dur; return (prev = k); });
      t.samples.forEach((s, i) => { s.dur = i + 1 < steps.length ? Math.round(steps[i + 1] * g) - Math.round(steps[i] * g) : Math.round(g); });
    }
  }

  // Lay the data out: each fragment's run of samples becomes a chunk, in file order.
  const allChunks = [...tracks.values()].flatMap((t) => t.chunks.map((c) => ({ c, t }))).sort((a, b) => a.c.offset - b.c.offset);
  const mdatBody = allChunks.reduce((n, { c }) => n + c.size, 0);
  const mdatHdr = mdatBody + 8 > 0xffffffff ? 16 : 8;

  const ftyp = box('ftyp', new TextEncoder().encode('isom'), u32s([0x200]), new TextEncoder().encode('isomiso2avc1mp41'));

  const buildMoov = (big, chunkStart) => {
    // Where each chunk lands in the new file.
    let p = chunkStart;
    for (const { c } of allChunks) { c.out = p; p += c.size; }
    let movieDur = 0;
    const traks = [];
    for (const t of tracks.values()) {
      if (!t.samples.length) continue;
      const S = t.samples;
      const mediaDur = S.reduce((n, s) => n + s.dur, 0);
      const lead = t.firstDts ? Math.round((t.firstDts / t.scale) * movieScale) : 0; // a track that starts late keeps its place
      const dur = Math.round((mediaDur / t.scale) * movieScale) + lead;
      movieDur = Math.max(movieDur, dur);
      const stts = [];
      for (const s of S) { const last = stts.at(-1); if (last && last[1] === s.dur) last[0]++; else stts.push([1, s.dur]); }
      const hasCto = S.some((s) => s.cto);
      const ctts = [];
      if (hasCto) for (const s of S) { const last = ctts.at(-1); if (last && last[1] === s.cto) last[0]++; else ctts.push([1, s.cto]); }
      const stsc = [];
      t.chunks.forEach((c, i) => { if (!stsc.length || stsc.at(-1)[1] !== c.count) stsc.push([i + 1, c.count, 1]); });
      const sync = S.map((s, i) => (s.sync ? i + 1 : 0)).filter(Boolean);
      const stbl = box('stbl',
        copy(mbuf, child(mbuf, child(mbuf, child(mbuf, t.mdia, 'minf'), 'stbl'), 'stsd')),
        fullbox('stts', 0, 0, u32s([stts.length, ...stts.flat()])),
        ...(hasCto ? [fullbox('ctts', S.some((s) => s.cto < 0) ? 1 : 0, 0, u32s([ctts.length, ...ctts.flat()]))] : []),
        ...(sync.length < S.length ? [fullbox('stss', 0, 0, u32s([sync.length, ...sync]))] : []),
        fullbox('stsc', 0, 0, u32s([stsc.length, ...stsc.flat()])),
        fullbox('stsz', 0, 0, u32s([0, S.length, ...S.map((s) => s.size)])),
        big ? fullbox('co64', 0, 0, u32s([t.chunks.length, ...t.chunks.flatMap((c) => [Math.floor(c.out / 2 ** 32), c.out >>> 0])]))
          : fullbox('stco', 0, 0, u32s([t.chunks.length, ...t.chunks.map((c) => c.out)])));
      const minf = child(mbuf, t.mdia, 'minf');
      const minfParts = boxes(mbuf, minf.body, minf.end).filter((b) => b.type !== 'stbl').map((b) => copy(mbuf, b));
      const mdiaParts = boxes(mbuf, t.mdia.body, t.mdia.end).map((b) => (b.type === 'mdhd' ? withDuration(mbuf, b, mediaDur) : b.type === 'minf' ? box('minf', ...minfParts, stbl) : copy(mbuf, b)));
      const edts = lead ? [box('edts', fullbox('elst', 0, 0, u32s([2, lead, 0xffffffff, 0x10000, dur - lead, 0, 0x10000])))] : [];
      const trakParts = boxes(mbuf, t.trak.body, t.trak.end).filter((b) => b.type !== 'edts').map((b) => (b.type === 'tkhd' ? withDuration(mbuf, b, dur) : b.type === 'mdia' ? box('mdia', ...mdiaParts) : copy(mbuf, b)));
      traks.push(box('trak', trakParts[0], ...edts, ...trakParts.slice(1)));
    }
    const rest = boxes(mbuf, moov.body, moov.end).filter((b) => !['mvhd', 'trak', 'mvex'].includes(b.type)).map((b) => copy(mbuf, b));
    return box('moov', withDuration(mbuf, mvhd, movieDur), ...traks, ...rest);
  };

  // Twice: the moov's own size decides where the data starts.
  let big = false;
  let moovOut = buildMoov(big, 0);
  if (ftyp.byteLength + moovOut.byteLength + mdatHdr + mdatBody > 0xffffffff) { big = true; moovOut = buildMoov(big, 0); }
  moovOut = buildMoov(big, ftyp.byteLength + moovOut.byteLength + mdatHdr);

  const mdatHead = new Uint8Array(mdatHdr);
  const hv = new DataView(mdatHead.buffer);
  if (mdatHdr === 16) { hv.setUint32(0, 1); hv.setUint32(8, Math.floor((mdatBody + 16) / 2 ** 32)); hv.setUint32(12, (mdatBody + 16) >>> 0); } else hv.setUint32(0, mdatBody + 8);
  mdatHead.set([0x6d, 0x64, 0x61, 0x74], 4); // 'mdat'
  return new Blob([ftyp, moovOut, mdatHead, ...allChunks.map(({ c }) => blob.slice(c.offset, c.offset + c.size))], { type: 'video/mp4' });
}
