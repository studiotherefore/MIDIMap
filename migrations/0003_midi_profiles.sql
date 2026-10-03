-- MIDI controller profiles for the editor (bindings "this knob → that control"),
-- shared by all projects, synced between browsers and the MIDIMap app.
CREATE TABLE IF NOT EXISTS midi_profiles (
  name TEXT PRIMARY KEY,
  data TEXT NOT NULL,          -- the profile as JSON (versioned: data.version)
  updated_at INTEGER NOT NULL  -- milliseconds since 1970
);
