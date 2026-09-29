-- Saved presets for the experiments, shared between browsers and the MIDIMap app.
CREATE TABLE IF NOT EXISTS presets (
  name TEXT PRIMARY KEY,
  data TEXT NOT NULL,          -- the preset as JSON (effects, scene settings, photo)
  updated_at INTEGER NOT NULL  -- milliseconds since 1970
);
