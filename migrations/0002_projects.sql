-- Editor projects (the whole setup: places, layers, effects, camera, tempo,
-- audio, output), shared between browsers and the MIDIMap app.
CREATE TABLE IF NOT EXISTS projects (
  name TEXT PRIMARY KEY,
  data TEXT NOT NULL,          -- the project as JSON (versioned: data.version)
  updated_at INTEGER NOT NULL  -- milliseconds since 1970
);
