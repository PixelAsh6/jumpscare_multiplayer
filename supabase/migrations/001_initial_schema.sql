-- Jumpscare Multiplayer — Supabase Schema
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor → New query)

-- 1. Lobbies table
CREATE TABLE IF NOT EXISTS lobbies (
  room_code    TEXT PRIMARY KEY,
  host_id      TEXT,
  admin_name   TEXT DEFAULT '',
  chance       REAL DEFAULT 1.0,
  video_url    TEXT DEFAULT '',
  random_mode  BOOLEAN DEFAULT false,
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- 2. Players table
CREATE TABLE IF NOT EXISTS players (
  id           TEXT PRIMARY KEY,
  room_code    TEXT NOT NULL REFERENCES lobbies(room_code) ON DELETE CASCADE,
  username     TEXT NOT NULL,
  is_admin     BOOLEAN DEFAULT false,
  online       BOOLEAN DEFAULT false,
  last_seen    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_players_room ON players(room_code);

-- 3. Jumpscare log (for triggering events)
CREATE TABLE IF NOT EXISTS jumpscares (
  id           BIGSERIAL PRIMARY KEY,
  room_code    TEXT NOT NULL REFERENCES lobbies(room_code) ON DELETE CASCADE,
  player_id    TEXT NOT NULL,
  username     TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jumpscares_room ON jumpscares(room_code);

-- 4. Enable Realtime on all tables
ALTER PUBLICATION supabase_realtime ADD TABLE lobbies;
ALTER PUBLICATION supabase_realtime ADD TABLE players;
ALTER PUBLICATION supabase_realtime ADD TABLE jumpscares;

-- 5. Row Level Security (open access for lobby app)
ALTER TABLE lobbies ENABLE ROW LEVEL SECURITY;
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE jumpscares ENABLE ROW LEVEL SECURITY;

-- Anyone can read/write (this is a public lobby app, no sensitive data)
CREATE POLICY "rl" ON lobbies FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "rl" ON players FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "rl" ON jumpscares FOR ALL USING (true) WITH CHECK (true);

-- 6. Auto-cleanup: remove offline players older than 5 minutes
CREATE OR REPLACE FUNCTION cleanup_stale_players()
RETURNS void AS $$
  DELETE FROM players
  WHERE online = false
    AND last_seen < now() - interval '5 minutes';
$$ LANGUAGE sql;

-- 7. Storage bucket for jumpscare videos
INSERT INTO storage.buckets (id, name, public)
VALUES ('jumpscare-assets', 'jumpscare-assets', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "up" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'jumpscare-assets');

CREATE POLICY "rd" ON storage.objects FOR SELECT
  USING (bucket_id = 'jumpscare-assets');

CREATE POLICY "upd" ON storage.objects FOR UPDATE
  USING (bucket_id = 'jumpscare-assets')
  WITH CHECK (bucket_id = 'jumpscare-assets');

CREATE POLICY "del" ON storage.objects FOR DELETE
  USING (bucket_id = 'jumpscare-assets');
