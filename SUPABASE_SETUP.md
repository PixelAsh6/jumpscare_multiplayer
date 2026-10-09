# Jumpscare Multiplayer - Supabase Setup Guide

This app uses [Supabase](https://supabase.com) (free) to connect all players. You don't need to run a server, forward ports, or use a VPN.

---

## What you need

1. A free [Supabase](https://supabase.com) account (sign up with GitHub)
2. The SQL script below

---

## Step 1 - Create a Supabase project

1. Go to **https://supabase.com** → **Start your project** → Sign up with GitHub
2. Click **New project**
   - **Name**: `jumpscare-multiplayer` (or anything)
   - **Database password**: choose one (save it)
   - **Region**: pick the closest to you
3. Wait ~2 minutes for it to be ready

## Step 2 - Run the SQL schema

1. In your project dashboard, go to **SQL Editor** (left sidebar)
2. Click **New query**
3. Paste the entire script below
4. Click **Run** → you should see "Success. No rows returned"

```sql
-- ── Jumpscare Multiplayer - Supabase Schema ──────────────

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

-- 3. Jumpscare log
CREATE TABLE IF NOT EXISTS jumpscares (
  id           BIGSERIAL PRIMARY KEY,
  room_code    TEXT NOT NULL REFERENCES lobbies(room_code) ON DELETE CASCADE,
  player_id    TEXT NOT NULL,
  username     TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jumpscares_room ON jumpscares(room_code);

-- 4. Enable Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE lobbies;
ALTER PUBLICATION supabase_realtime ADD TABLE players;
ALTER PUBLICATION supabase_realtime ADD TABLE jumpscares;

-- 5. Row Level Security
ALTER TABLE lobbies ENABLE ROW LEVEL SECURITY;
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE jumpscares ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rl" ON lobbies FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "rl" ON players FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "rl" ON jumpscares FOR ALL USING (true) WITH CHECK (true);

-- 6. Storage bucket for jumpscare videos
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
```

## Step 3 - Get your API keys

1. Go to **Settings** (gear icon, bottom left) → **API**
2. Copy these two values:

| Field | Where to find it |
|-------|-----------------|
| **Project URL** | `https://xxxxxxxx.supabase.co` |
| **Anon key** | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...` |

3. In the app, paste both values into Settings, and set a **Share Password** (required - share strings only appear once it's set, and guests must enter it to join).

## Step 4 - Enable Realtime

1. Go to **Database** → **Replication**
2. Make sure these tables are toggled **ON**:
   - `lobbies`
   - `players`
   - `jumpscares`

If you ran the SQL in Step 2, they should already be enabled.

---

## That's it!

No server, no port forwarding, no VPN. Open the app, enter your details, and either **Create Lobby** (you become admin) or **Join Lobby** (paste the share string your friend gave you).

---

## How it works

- **Host** creates a lobby → their username is stored as `admin_name` in Supabase
- **Guest** joins via share string → if their username matches `admin_name`, they get admin too
- This means the same person can get admin from any device by using the same username

---

## Free tier limits

| Resource | Free tier | This app uses |
|----------|-----------|---------------|
| Database | 500 MB | ~1 KB per lobby |
| Storage | 1 GB | videos per lobby |
| Bandwidth | 2 GB/month | ~10 KB per action |
| Realtime msgs | 500K/month | ~5 per minute per player |

You can have **thousands of concurrent lobbies** before hitting free limits.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Invalid API key" | Double-check the anon key in Settings. No extra spaces. |
| Players can't see each other | Go to Database → Replication → make sure all 3 tables are enabled |
| Realtime not working | Make sure you're using the `anon` key, not `service_role` |
| Storage upload fails | Go to Storage → `jumpscare-assets` → Policies → make sure upload/update/delete policies exist (rerun the Step 2 SQL if unsure) |
| No share string shown | Set a **Share Password** in the app Settings first |
| Admin not working on other device | Make sure you're using the same username |
