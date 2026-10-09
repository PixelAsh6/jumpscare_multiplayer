// Debug logging
async function dbg(msg) {
  var ts = new Date().toISOString().slice(11, 23);
  var line = "[" + ts + "] " + msg;
  console.log(line);
  try {
    if (window.__TAURI__ && window.__TAURI__.core) {
      await window.__TAURI__.core.invoke("log_write", { msg: line });
    }
  } catch (_) {}
}

document.addEventListener("DOMContentLoaded", async function() {
  await dbg("DOMContentLoaded fired");

  var invoke, emit;
  try {
    invoke = window.__TAURI__.core.invoke;
    emit = window.__TAURI__.event.emit;
    await dbg("Tauri API: OK");
  } catch (e) {
    await dbg("Tauri API MISSING: " + e);
    return;
  }

  await dbg("Supabase available: " + (typeof window.supabase !== "undefined"));
  if (typeof window.supabase === "undefined") {
    await dbg("ERROR: Supabase JS not loaded!");
    return;
  }

  var supabase = null;
  var myPlayerId = localStorage.getItem('jm_player_id') || null;
  function savePlayerId() { localStorage.setItem('jm_player_id', myPlayerId); }
  async function cleanupOldRows(roomCode) {
    if (!supabase || !myUsername) return;
    await withTimeout(supabase.from('players').delete()
      .eq('room_code', roomCode).eq('username', myUsername).neq('id', myPlayerId), 20000, "Cleanup");
  }
  // ponytail: supabase-js has no request timeout — a stalled request must surface, never hang the UI
  function withTimeout(promise, ms, label) {
    var timer = null;
    var timeout = new Promise(function(_, reject) {
      timer = setTimeout(function() { reject(new Error((label || "Request") + " timed out.")); }, ms);
    });
    return Promise.race([promise, timeout]).then(function(v) { clearTimeout(timer); return v; }, function(e) { clearTimeout(timer); throw e; });
  }
  var myUsername = "";
  var currentLobby = null;
  var isAdmin = false;
  var lobbyChannel = null;
  var players = [];
  var assetPollInterval = null;
  var autoRollInterval = null;
  var pingInterval = null;
  var cleanupInterval = null;
  var lastAssetVideoUrl = null;
  var syncedChance = 1;
  var syncedVideoUrl = "";

  function loadSettings() { try { return JSON.parse(localStorage.getItem("jm_settings")); } catch(e) { return null; } }
  function saveSettings(s) { localStorage.setItem("jm_settings", JSON.stringify(s)); }
  function loadLobbies() { try { return JSON.parse(localStorage.getItem("jm_lobbies")) || []; } catch(e) { return []; } }
  function saveLobbies(list) { localStorage.setItem("jm_lobbies", JSON.stringify(list)); }
  function loadLastLobby() { return localStorage.getItem("jm_last_lobby"); }
  function saveLastLobby(name) { localStorage.setItem("jm_last_lobby", name); }
  function $(id) { return document.getElementById(id); }
  function esc(t) { var d = document.createElement("div"); d.textContent = t; return d.innerHTML; }
  function initSupabase(url, key) {
    if (supabase && lobbyChannel) { try { supabase.removeChannel(lobbyChannel); } catch (_) {} lobbyChannel = null; }
    supabase = window.supabase.createClient(url, key);
  }
  function getShareString(lobby) { return "JUMPCARE:" + lobby.name + ":" + lobby.supabase_url + ":" + lobby.supabase_key; }

  // Encrypted share strings (JUMPCARE2) — AES-GCM via WebCrypto, password shared out-of-band
  function b64url(bytes) { var bin = ""; bytes.forEach(function(b) { bin += String.fromCharCode(b); }); return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
  function unb64url(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; var bin = atob(s); var out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  async function encShare(url, key, password) {
    var enc = new TextEncoder();
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var km = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
    var aes = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" }, km, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    var ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, aes, enc.encode(url + "\n" + key));
    var all = new Uint8Array(16 + 12 + ct.byteLength);
    all.set(salt, 0); all.set(iv, 16); all.set(new Uint8Array(ct), 28);
    return b64url(all);
  }
  async function decShare(payload, password) {
    var all = unb64url(payload);
    if (all.length < 29) throw new Error("bad share string");
    var salt = all.slice(0, 16);
    var iv = all.slice(16, 28);
    var ct = all.slice(28);
    var enc = new TextEncoder();
    var km = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
    var aes = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" }, km, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    var pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, aes, ct);
    var parts = new TextDecoder().decode(pt).split("\n");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("bad share string");
    return { url: parts[0], key: parts[1] };
  }
  window.__cryptoTest = { encShare: encShare, decShare: decShare }; // ponytail: test hook mirroring __showJumpscare
  async function renderShareString() {
    var el = $("share-string");
    if (!currentLobby) return;
    var s = loadSettings();
    var pw = s && s.share_password ? s.share_password : "";
    var name = currentLobby.name;
    if (!pw) {
      el.textContent = "Set a share password in Settings to get your share string.";
      return;
    }
    try {
      var b64 = await encShare(currentLobby.supabase_url, currentLobby.supabase_key, pw);
      if (currentLobby && currentLobby.name === name) el.textContent = "JUMPCARE2:" + name + ":" + b64;
    } catch (_) {
      if (currentLobby && currentLobby.name === name) el.textContent = getShareString(currentLobby);
    }
  }

  var viewSetup = $("view-setup");
  var viewJoinString = $("view-join-string");
  var viewMenu = $("view-menu");
  var allViews = [viewSetup, viewJoinString, viewMenu];
  await dbg("DOM refs: setup=" + !!viewSetup + " join=" + !!viewJoinString + " menu=" + !!viewMenu);

  function showView(name) {
    allViews.forEach(function(v) { v.classList.remove("active"); });
    var map = { setup: viewSetup, joinString: viewJoinString, menu: viewMenu };
    if (map[name]) map[name].classList.add("active");
  }

  function showStatus(el, msg, isErr) {
    if (!el) return;
    el.textContent = msg;
    el.className = "status " + (isErr ? "error" : "success");
    el.classList.remove("hidden");
  }

  var modalOpen = false;
  function showModal(title, buttonText, noInput) {
    if (modalOpen) return Promise.resolve(null); // ponytail: ignore double-clicks, first promise wins
    modalOpen = true;
    return new Promise(function(resolve) {
      $("modal-title").textContent = title;
      $("modal-ok").textContent = buttonText;
      $("modal-input").value = "";
      $("modal-input").style.display = noInput ? "none" : "";
      $("modal-overlay").classList.remove("hidden");
      if (!noInput) $("modal-input").focus(); else $("modal-ok").focus();
      function close(val) {
        modalOpen = false;
        $("modal-overlay").classList.add("hidden");
        $("modal-ok").removeEventListener("click", onOk);
        $("modal-cancel").removeEventListener("click", onCancel);
        $("modal-overlay").removeEventListener("keydown", onKey);
        resolve(val);
      }
      function onOk() { close(noInput ? true : $("modal-input").value); }
      function onCancel() { close(null); }
      function onKey(e) { if (e.key === "Enter") close(noInput ? true : $("modal-input").value); if (e.key === "Escape") close(null); }
      $("modal-ok").addEventListener("click", onOk);
      $("modal-cancel").addEventListener("click", onCancel);
      $("modal-overlay").addEventListener("keydown", onKey); // ponytail: on overlay (bubbles) so Escape works with no text input too
    });
  }

  var btnSetupSave = $("btn-setup-save");
  var setupUsername = $("setup-username");
  var setupStatus = $("setup-status");
  await dbg("Setup elements: btn=" + !!btnSetupSave + " input=" + !!setupUsername);

  btnSetupSave.addEventListener("click", async function() {
    await dbg("Setup: Continue clicked");
    var username = setupUsername.value.trim();
    if (!username) { showStatus(setupStatus, "Enter a username", true); return; }
    saveSettings({ username: username, supabase_url: "", supabase_key: "", share_password: "", volume: 80 });
    myUsername = username;
    showView("menu");
    renderLobbyList();
    showSettingsPanel();
  });

  setupUsername.addEventListener("keydown", function(e) {
    if (e.key === "Enter") btnSetupSave.click();
  });
  await dbg("Setup listeners bound");

  var settingsPanel = $("settings-panel");
  var lobbyDetails = $("lobby-details");
  var noLobbySelected = $("no-lobby-selected");

  function showSettingsPanel() {
    var s = loadSettings();
    if (!s) return;
    $("settings-username").value = s.username || "";
    $("settings-supabase-url").value = s.supabase_url || "";
    $("settings-supabase-key").value = s.supabase_key || "";
    $("settings-share-password").value = s.share_password || "";
    var vol = s.volume !== undefined ? s.volume : 80;
    $("settings-volume").value = vol;
    $("settings-volume-text").value = vol;
    settingsPanel.classList.remove("hidden");
    lobbyDetails.classList.add("hidden");
    noLobbySelected.classList.add("hidden");
    // Autostart checkbox reflects live OS state
    invoke("plugin:autostart|is_enabled").then(function(on) {
      $("settings-autostart").checked = !!on;
    }).catch(function() {});
  }

  $("btn-settings").addEventListener("click", async function() {
    await dbg("Settings button clicked");
    showSettingsPanel();
  });

  $("btn-settings-close").addEventListener("click", async function() {
    await dbg("Settings close clicked");
    settingsPanel.classList.add("hidden");
    if (currentLobby) { lobbyDetails.classList.remove("hidden"); }
    else { noLobbySelected.classList.remove("hidden"); }
  });

  $("btn-settings-save").addEventListener("click", async function() {
    await dbg("Settings save clicked");
    var username = $("settings-username").value.trim();
    var url = $("settings-supabase-url").value.trim().replace(/\/+$/, "");
    var key = $("settings-supabase-key").value.trim();
    var sharePw = $("settings-share-password").value;
    var vol = parseInt($("settings-volume-text").value, 10);
    if (isNaN(vol)) vol = 80;
    vol = Math.max(0, Math.min(100, vol));
    if (!username) { showStatus($("settings-status"), "Enter a username", true); return; }
    saveSettings({ username: username, supabase_url: url, supabase_key: key, share_password: sharePw, volume: vol });
    myUsername = username;
    showStatus($("settings-status"), "Settings saved!", false);
    renderShareString();
  });

  // Volume slider ↔ text box sync
  $("settings-volume").addEventListener("input", function() {
    $("settings-volume-text").value = this.value;
  });
  $("settings-volume-text").addEventListener("input", function() {
    var v = parseInt(this.value, 10);
    if (!isNaN(v)) { $("settings-volume").value = Math.max(0, Math.min(100, v)); }
  });
  $("btn-share-pw-toggle").addEventListener("click", function() {
    var inp = $("settings-share-password");
    var show = inp.type === "password";
    inp.type = show ? "text" : "password";
    this.textContent = show ? "Hide" : "Show";
  });
  $("settings-autostart").addEventListener("change", async function() {
    try {
      await invoke(this.checked ? "plugin:autostart|enable" : "plugin:autostart|disable");
      showStatus($("settings-status"), this.checked ? "App will start with Windows." : "Autostart disabled.", false);
    } catch (e) {
      this.checked = !this.checked;
      showStatus($("settings-status"), "Autostart failed: " + e, true);
    }
  });
  await dbg("Settings listeners bound");

  // FFMPEG STATUS + DOWNLOAD
  async function checkFfmpeg() {
    try {
      await invoke("ffmpeg_status");
      $("ffmpeg-status-text").textContent = "Installed";
      $("ffmpeg-status-text").style.color = "#2ecc71";
      $("btn-download-ffmpeg").style.display = "none";
      $("btn-check-ffmpeg").style.display = "none";
    } catch (e) {
      $("ffmpeg-status-text").textContent = "Not installed (needed for Video Editor)";
      $("ffmpeg-status-text").style.color = "#e74c3c";
      $("btn-download-ffmpeg").style.display = "inline-flex";
      $("btn-check-ffmpeg").style.display = "inline-flex";
    }
  }
  checkFfmpeg();

  $("btn-check-ffmpeg").addEventListener("click", async function() {
    await checkFfmpeg();
  });

  // YT-DLP STATUS + DOWNLOAD (mirrors FFmpeg, but silent — no terminal)
  async function checkYtdlp() {
    try {
      await invoke("ytdlp_status");
      $("ytdlp-status-text").textContent = "Installed";
      $("ytdlp-status-text").style.color = "#2ecc71";
      $("btn-download-ytdlp").style.display = "none";
      $("btn-check-ytdlp").style.display = "none";
    } catch (e) {
      $("ytdlp-status-text").textContent = "Not installed (needed for URL downloads)";
      $("ytdlp-status-text").style.color = "#e74c3c";
      $("btn-download-ytdlp").style.display = "inline-flex";
      $("btn-check-ytdlp").style.display = "inline-flex";
    }
  }
  checkYtdlp();

  $("btn-check-ytdlp").addEventListener("click", async function() {
    await checkYtdlp();
  });

  $("btn-download-ytdlp").addEventListener("click", async function() {
    var btn = $("btn-download-ytdlp");
    var statusEl = $("ytdlp-status-text");
    btn.disabled = true;
    statusEl.textContent = "Downloading yt-dlp...";
    statusEl.style.color = "#e67e22";
    try {
      await invoke("download_ytdlp");
      await checkYtdlp();
    } catch (e) {
      statusEl.textContent = "Error: " + e;
      statusEl.style.color = "#e74c3c";
    }
    btn.disabled = false;
    btn.textContent = "Install yt-dlp";
  });

  $("btn-download-ffmpeg").addEventListener("click", async function() {
    var btn = $("btn-download-ffmpeg");
    var statusEl = $("ffmpeg-status-text");
    btn.disabled = true;
    try {
      await invoke("download_ffmpeg");
      statusEl.textContent = "Installer opened in terminal. Install FFmpeg there, then come back and click Check.";
      statusEl.style.color = "#e67e22";
    } catch (e) {
      statusEl.textContent = "Error: " + e;
      statusEl.style.color = "#e74c3c";
    }
    btn.disabled = false;
    btn.textContent = "Download FFmpeg";
  });

  // JOIN BY SHARE STRING
  var btnGotoJoin = $("btn-goto-join");
  if (btnGotoJoin) {
    btnGotoJoin.addEventListener("click", async function() {
      await dbg("Goto join clicked");
      showView("joinString");
    });
  }

  $("link-back-to-setup").addEventListener("click", async function(e) {
    e.preventDefault();
    await dbg("Back to menu");
    showView("menu");
  });

  $("btn-join-by-string").addEventListener("click", async function() {
    await dbg("Join by string clicked");
    var btn = $("btn-join-by-string");
    btn.disabled = true;
    try {
      if (!myUsername) { showStatus($("join-status"), "Set your username first (go Back, then Continue).", true); return; }
      var input = $("join-string-input").value.trim();
      if (!input) { showStatus($("join-status"), "Paste the share string", true); return; }
      var parts = input.split(":");
      var isV2 = parts[0] === "JUMPCARE2";
      if ((!isV2 && (parts.length < 4 || parts[0] !== "JUMPCARE")) || (isV2 && parts.length < 3)) {
        showStatus($("join-status"), "Invalid share string format", true); return;
      }
      var lobbyName = parts[1];
      if (!lobbyName) { showStatus($("join-status"), "Invalid share string (empty lobby name)", true); return; }
      var supabaseUrl = "";
      var supabaseKey = "";
      if (isV2) {
        var pw = await showModal("Enter the share password", "Join");
        if (!pw) return;
        try {
          var dec = await decShare(parts.slice(2).join(":"), pw);
          supabaseUrl = dec.url;
          supabaseKey = dec.key;
        } catch (_) {
          showStatus($("join-status"), "Wrong password or corrupted share string.", true); return;
        }
      } else {
        supabaseUrl = parts.slice(2, parts.length - 1).join(":");
        supabaseKey = parts[parts.length - 1];
      }
      if (!supabaseUrl || !supabaseKey) { showStatus($("join-status"), "Invalid share string (missing URL or key)", true); return; }
      myPlayerId = myPlayerId || crypto.randomUUID(); savePlayerId();
      initSupabase(supabaseUrl, supabaseKey);
      await cleanupOldRows(lobbyName);
      var result = await withTimeout(supabase.from("lobbies").select("*").eq("room_code", lobbyName).single(), 20000, "Find lobby");
      if (result.error || !result.data) {
        showStatus($("join-status"), "Join failed: " + friendlyJoinError(result.error), true); return;
      }
      isAdmin = result.data.admin_name === myUsername;
      var up = await withTimeout(supabase.from("players").upsert({
        id: myPlayerId, room_code: lobbyName, username: myUsername,
        is_admin: isAdmin, online: true, last_seen: new Date().toISOString()
      }), 20000, "Join lobby");
      if (up.error) { showStatus($("join-status"), "Join failed: " + up.error.message, true); return; }
      currentLobby = { name: lobbyName, supabase_url: supabaseUrl, supabase_key: supabaseKey };
      saveLastLobby(lobbyName);
      addLobbyToHistory(currentLobby);
      showView("menu");
      renderLobbyList();
      showLobbyDetails();
      subscribeToLobby();
      startAssetPolling();
      startAutoRoll();
      startPing();
      startCleanup();
    } catch (err) {
      showStatus($("join-status"), "Join failed: " + (err && err.message ? err.message : err), true);
    } finally {
      btn.disabled = false;
    }
  });
  await dbg("Join listeners bound");

  // LOBBY LIST
  function renderLobbyList() {
    var list = loadLobbies();
    var el = $("lobby-list");
    el.innerHTML = "";
    if (list.length === 0) {
      el.innerHTML = "<p style=\"color:#555;font-size:13px;padding:12px;\">No lobbies yet.</p>";
      return;
    }
    list.forEach(function(lobby) {
      var div = document.createElement("div");
      div.className = "lobby-item" + (currentLobby && currentLobby.name === lobby.name ? " active" : "");
      div.innerHTML = "<span class=\"name\">" + esc(lobby.name) + "</span><button class=\"delete-btn\" title=\"Delete\" aria-label=\"Delete lobby\">&times;</button>";
      div.addEventListener("click", function() { joinExistingLobby(lobby); });
      div.querySelector(".delete-btn").addEventListener("click", function(e) {
        e.stopPropagation();
        deleteLobby(lobby.name);
      });
      el.appendChild(div);
    });
  }

  var joiningLobby = false;
  function friendlyJoinError(err) {
    if (err && err.code === "PGRST116") return "lobby not found on Supabase (was it deleted?).";
    return err && err.message ? err.message : "lobby not found on Supabase.";
  }
  async function joinExistingLobby(lobby, silent) {
    if (joiningLobby) return false;
    joiningLobby = true;
    try {
      await dbg("Joining existing lobby: " + lobby.name);
      if (!myUsername) { if (!silent) alert("Set your username in Settings first."); return false; }
      myPlayerId = myPlayerId || crypto.randomUUID(); savePlayerId();
      initSupabase(lobby.supabase_url, lobby.supabase_key);
      await cleanupOldRows(lobby.name);
      var result = await withTimeout(supabase.from("lobbies").select("*").eq("room_code", lobby.name).single(), 20000, "Find lobby");
      if (result.error || !result.data) {
        if (!silent) alert("Could not join '" + lobby.name + "': " + friendlyJoinError(result.error));
        return false;
      }
      var up = await withTimeout(supabase.from("players").upsert({
        id: myPlayerId, room_code: lobby.name, username: myUsername,
        is_admin: result.data.admin_name === myUsername, online: true, last_seen: new Date().toISOString()
      }), 20000, "Join lobby");
      if (up.error) { if (!silent) alert("Could not join '" + lobby.name + "': " + up.error.message); return false; }
      currentLobby = lobby;
      saveLastLobby(lobby.name);
      isAdmin = result.data.admin_name === myUsername;
      settingsPanel.classList.add("hidden");
      showLobbyDetails();
      renderLobbyList();
      subscribeToLobby();
      startAssetPolling();
      startAutoRoll();
      startPing();
      startCleanup();
      return true;
    } catch (err) {
      if (!silent) alert("Could not join '" + lobby.name + "': " + (err && err.message ? err.message : err));
      return false;
    } finally {
      joiningLobby = false;
    }
  }

  function addLobbyToHistory(lobby) {
    var list = loadLobbies();
    var exists = list.find(function(l) { return l.name === lobby.name; });
    if (!exists) {
      list.push({ name: lobby.name, supabase_url: lobby.supabase_url, supabase_key: lobby.supabase_key });
      saveLobbies(list);
    }
  }

  function deleteLobby(name) {
    var list = loadLobbies().filter(function(l) { return l.name !== name; });
    saveLobbies(list);
    if (loadLastLobby() === name) localStorage.removeItem("jm_last_lobby"); // ponytail: else auto-join silently no-ops
    if (currentLobby && currentLobby.name === name) { leaveLobby(); }
    renderLobbyList();
    lobbyDetails.classList.add("hidden");
    noLobbySelected.classList.remove("hidden");
  }

  await dbg("Lobby list functions defined");
  // LOBBY DETAILS
  function showLobbyDetails() {
    lobbyDetails.classList.remove("hidden");
    noLobbySelected.classList.add("hidden");
    settingsPanel.classList.add("hidden");
    $("detail-name").textContent = currentLobby.name;
    $("detail-role").textContent = isAdmin ? "Admin" : "Guest";
    $("detail-role").className = "badge " + (isAdmin ? "admin" : "guest");
    renderShareString();
    if (isAdmin) {
      $("admin-panel").classList.remove("hidden");
      $("btn-delete-lobby").classList.remove("hidden");
    } else {
      $("admin-panel").classList.add("hidden");
      $("btn-delete-lobby").classList.add("hidden");
    }
    refreshLobbyData();
    renderVideoList();
  }

  async function refreshLobbyData() {
    if (!currentLobby || !supabase) return;
    try {
      var result = await supabase.from("lobbies").select("*").eq("room_code", currentLobby.name).single();
      var lobby = result.data;
    if (lobby) {
      $("detail-chance").textContent = Number(lobby.chance).toFixed(2) + "%";
      $("admin-chance").value = lobby.chance;
      syncedChance = Number(lobby.chance); // ponytail: snapshot for sync-what-changed
      syncedVideoUrl = lobby.video_url || "";
      $("random-mode").checked = !!lobby.random_mode;
    }
      var plResult = await supabase.from("players").select("*").eq("room_code", currentLobby.name).eq("online", true);
      var pl = plResult.data;
      if (pl) {
        players = pl;
        renderPlayersSidebar();
        var count = pl.length || 1;
        var perPlayer = (lobby ? lobby.chance : 1) / count;
        $("detail-my-chance").textContent = Number(perPlayer).toFixed(2) + "%";
        $("detail-online-count").textContent = pl.length;
      }
    } catch (_) {}
  }

  function renderPlayersSidebar() {
    var el = $("player-list-sidebar");
    el.innerHTML = "";
    players.forEach(function(p) {
      var div = document.createElement("div");
      div.className = "player-item";
      div.innerHTML = "<span>" + esc(p.username) + "</span>" + (p.is_admin ? '<span class="badge admin">Admin</span>' : "");
      el.appendChild(div);
    });
  }

  // REALTIME
  function subscribeToLobby() {
    if (!supabase) return;
    if (lobbyChannel) { try { supabase.removeChannel(lobbyChannel); } catch (_) {} }
    if (!currentLobby) return;
    lobbyChannel = supabase.channel(currentLobby.name);
    lobbyChannel
      .on("postgres_changes", { event: "*", schema: "public", table: "players", filter: "room_code=eq." + currentLobby.name }, function() { refreshLobbyData(); })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "lobbies", filter: "room_code=eq." + currentLobby.name }, function(payload) {
        var l = payload.new;
        $("detail-chance").textContent = Number(l.chance).toFixed(2) + "%";
        $("admin-chance").value = l.chance;
        refreshLobbyData();
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "jumpscares", filter: "room_code=eq." + currentLobby.name }, function(payload) {
        if (payload.new.player_id !== myPlayerId) {
          triggerJumpscare(payload.new.username);
        }
      })
      .subscribe();
  }

  // VIDEO LIBRARY — click a row to switch instantly, × deletes from Supabase
  async function renderVideoList() {
    var el = $("video-list");
    if (!el) return;
    el.innerHTML = "";
    if (!currentLobby || !supabase) return;
    var vids = [];
    try {
      var res = await supabase.storage.from("jumpscare-assets").list(currentLobby.name);
      vids = ((res.data) || [])
        .filter(function(f) { return f.id && /\.(webm|mp4|mov|m4v|gif|png|webp)$/i.test(f.name); })
        .map(function(f) {
          var pub = supabase.storage.from("jumpscare-assets").getPublicUrl(currentLobby.name + "/" + f.name);
          return { name: f.name, path: currentLobby.name + "/" + f.name, url: pub.data.publicUrl };
        });
    } catch (_) {}
    var cur = baseUrl(syncedVideoUrl);
    if (!vids.length) {
      el.innerHTML = "<p style=\"color:#555;font-size:12px;padding:8px;\">No videos yet — choose files above and Sync.</p>";
      return;
    }
    vids.forEach(function(v) {
      var div = document.createElement("div");
      var isCur = baseUrl(v.url) === cur;
      div.className = "player-item video-item" + (isCur ? " current" : "");
      div.innerHTML = "<span title=\"" + esc(v.name) + "\">" + esc(v.name) + (isCur ? " ●" : "") + "</span>";
      var del = document.createElement("button");
      del.className = "tiny danger";
      del.textContent = "×";
      del.title = "Delete from Supabase";
      (function(vv) {
        del.addEventListener("click", function(e) { e.stopPropagation(); deleteVideo(vv); });
      })(v);
      div.appendChild(del);
      (function(url) {
        div.addEventListener("click", function() { switchVideo(url); });
      })(v.url);
      el.appendChild(div);
    });
  }

  var switchingVideo = false;
  async function switchVideo(url) {
    if (switchingVideo || !currentLobby || !supabase) return;
    if (baseUrl(url) === baseUrl(syncedVideoUrl)) return; // already current
    switchingVideo = true;
    var statusEl = $("asset-status");
    statusEl.textContent = "Switching video...";
    statusEl.style.color = "#999";
    try {
      var fresh = baseUrl(url) + "?t=" + Date.now();
      var res = await supabase.from("lobbies").update({ video_url: fresh }).eq("room_code", currentLobby.name);
      if (res.error) throw new Error(res.error.message);
      syncedVideoUrl = fresh;
      statusEl.textContent = "Video switched.";
      statusEl.style.color = "#2ecc71";
      renderVideoList();
      refreshLobbyData();
    } catch (err) {
      statusEl.textContent = "Switch failed: " + (err && err.message ? err.message : err);
      statusEl.style.color = "#e74c3c";
    }
    switchingVideo = false;
  }

  async function deleteVideo(v) {
    if (!currentLobby || !supabase) return;
    if (!await showModal("Delete '" + v.name + "' from Supabase storage?", "Delete", true)) return;
    var statusEl = $("asset-status");
    try {
      statusEl.textContent = "Deleting video...";
      statusEl.style.color = "#999";
      var del = await supabase.storage.from("jumpscare-assets").remove([v.path]);
      if (del.error) throw new Error(del.error.message);
      if (baseUrl(v.url) === baseUrl(syncedVideoUrl)) {
        var up = await supabase.from("lobbies").update({ video_url: "" }).eq("room_code", currentLobby.name);
        if (up.error) throw new Error(up.error.message);
        syncedVideoUrl = "";
      }
      statusEl.textContent = "Video deleted.";
      statusEl.style.color = "#2ecc71";
      renderVideoList();
      refreshLobbyData();
    } catch (err) {
      statusEl.textContent = "Delete failed: " + (err && err.message ? err.message : err);
      statusEl.style.color = "#e74c3c";
    }
  }

  $("random-mode").addEventListener("change", async function() {
    if (!currentLobby || !supabase) return;
    var on = this.checked;
    try {
      var res = await supabase.from("lobbies").update({ random_mode: on }).eq("room_code", currentLobby.name);
      if (res.error) throw new Error(res.error.message);
      showStatus($("asset-status"), on ? "Random mode on." : "Random mode off.", false);
    } catch (err) {
      this.checked = !on;
      showStatus($("asset-status"), "Error: " + (err && err.message ? err.message : err), true);
    }
  });

  // ADMIN - SYNC ALL
  var clearVideo = false;
  var pendingExportFile = null; // File handed from the editor's Use button; sync uploads it
  $("btn-clear-video").addEventListener("click", function() {
    clearVideo = true;
    $("video-file").value = "";
    this.textContent = "Will remove ✓";
  });
  $("btn-sync-all").addEventListener("click", async function() {
    await dbg("Sync all clicked");
    var btn = $("btn-sync-all");
    if (btn.disabled) return;
    if (!currentLobby || !supabase) {
      $("asset-status").textContent = "Join a lobby first.";
      $("asset-status").style.color = "#e74c3c";
      return;
    }
    btn.disabled = true;
    var statusEl = $("asset-status");
    statusEl.textContent = "Syncing...";
    statusEl.style.color = "#999";
    try {
      var chance = parseFloat($("admin-chance").value);
      if (isNaN(chance) || chance <= 0 || chance > 100) {
        statusEl.textContent = "Chance must be between 0.01 and 100.";
        statusEl.style.color = "#e74c3c";
        return;
      }
      var update = {};
      var didAnything = false;
      if (chance !== syncedChance) { update.chance = chance; didAnything = true; }
      var newUrls = [];
      var opaqueNote = false;
      if (pendingExportFile) {
        statusEl.textContent = "Uploading exported video...";
        var efile = pendingExportFile;
        var epath = currentLobby.name + "/video_" + efile.name.replace(/[^\w.\-]+/g, "_");
        var eup = await supabase.storage.from("jumpscare-assets").upload(epath, efile, { upsert: true });
        if (eup.error) {
          statusEl.textContent = "Video upload failed: " + eup.error.message;
          statusEl.style.color = "#e74c3c";
          return;
        }
        var eurl = supabase.storage.from("jumpscare-assets").getPublicUrl(epath);
        newUrls.push(eurl.data.publicUrl.split("?")[0]);
        pendingExportFile = null;
      }
      var videoInput = $("video-file");
      if (videoInput.files.length) {
        var files = Array.prototype.slice.call(videoInput.files);
        for (var fi = 0; fi < files.length; fi++) {
          statusEl.textContent = "Uploading video " + (fi + 1) + "/" + files.length + "...";
          var file = files[fi];
          var fext = (file.name.split(".").pop() || "").toLowerCase();
          if (fext === "mp4" || fext === "m4v" || fext === "avi" || fext === "mkv" || fext === "mov") opaqueNote = true;
          var safeBase = file.name.replace(/[^\w.\-]+/g, "_");
          var path = currentLobby.name + "/video_" + safeBase;
          var upResult = await supabase.storage.from("jumpscare-assets").upload(path, file, { upsert: true });
          if (upResult.error) {
            statusEl.textContent = "Video upload failed: " + upResult.error.message;
            statusEl.style.color = "#e74c3c";
            return;
          }
          var urlResult = supabase.storage.from("jumpscare-assets").getPublicUrl(path);
          newUrls.push(urlResult.data.publicUrl.split("?")[0]);
        }
      }
      var picked = null;
      if (newUrls.length) picked = newUrls[0];
      if (picked) { update.video_url = picked.split("?")[0] + "?t=" + Date.now(); didAnything = true; }
      else if (clearVideo) { update.video_url = ""; didAnything = true; }
      if (!didAnything) {
        statusEl.textContent = "Nothing changed.";
        statusEl.style.color = "#999";
        return;
      }
      statusEl.textContent = "Saving...";
      var errResult = await supabase.from("lobbies").update(update).eq("room_code", currentLobby.name);
      if (errResult.error) {
        statusEl.textContent = "Error: " + errResult.error.message;
        statusEl.style.color = "#e74c3c";
        return;
      }
      if (update.chance !== undefined) syncedChance = update.chance;
      if (update.video_url !== undefined) syncedVideoUrl = update.video_url;
      var onlyChance = update.chance !== undefined && update.video_url === undefined;
      statusEl.textContent = onlyChance ? "Chance synced." : "Synced!" + (opaqueNote ? " (note: MP4-style video has no transparency — export via Video Editor first)" : "");
      statusEl.style.color = "#2ecc71";
      clearVideo = false;
      $("btn-clear-video").textContent = "Clear";
      $("video-file").value = ""; // chosen files are now synced — clear so they aren't re-uploaded next time
      refreshLobbyData();
      renderVideoList();
    } catch (err) {
      statusEl.textContent = "Sync failed: " + (err && err.message ? err.message : err);
      statusEl.style.color = "#e74c3c";
    } finally {
      btn.disabled = false;
    }
  });

  // ADMIN - DELETE ALL SYNCED ASSETS (Supabase storage + lobby row reset)
  $("btn-delete-assets").addEventListener("click", async function() {
    await dbg("Delete assets clicked");
    var btn = $("btn-delete-assets");
    if (btn.disabled) return;
    if (!currentLobby || !supabase) return;
    if (!await showModal("Delete ALL synced assets for '" + currentLobby.name + "' (video files, chance reset to 1%)? This cannot be undone.", "Delete", true)) return;
    btn.disabled = true;
    var statusEl = $("asset-status");
    try {
      statusEl.textContent = "Deleting...";
      statusEl.style.color = "#999";
      var listed = await supabase.storage.from("jumpscare-assets").list(currentLobby.name);
      if (listed.error) throw new Error(listed.error.message);
      if (listed.data && listed.data.length) {
        var paths = listed.data.map(function(f) { return currentLobby.name + "/" + f.name; });
        var del = await supabase.storage.from("jumpscare-assets").remove(paths);
        if (del.error) throw new Error(del.error.message);
      }
      var up = await supabase.from("lobbies").update({ chance: 1.0, video_url: "" }).eq("room_code", currentLobby.name);
      if (up.error) throw new Error(up.error.message);
      $("video-file").value = "";
      clearVideo = false;
      $("btn-clear-video").textContent = "Clear";
      $("admin-chance").value = 1.0;
      syncedChance = 1.0;
      syncedVideoUrl = "";
      statusEl.textContent = "All assets deleted.";
      statusEl.style.color = "#2ecc71";
      refreshLobbyData();
      renderVideoList();
    } catch (err) {
      statusEl.textContent = "Delete failed: " + (err && err.message ? err.message : err);
      statusEl.style.color = "#e74c3c";
    } finally {
      btn.disabled = false;
    }
  });

  // ADMIN - FORCE JUMPSCARE (shared by button + F12 hotkey)
  async function forceJumpscare() {
    await dbg("Force jumpscare");
    if (!currentLobby || !supabase || !isAdmin) return;
    try {
      var ins = await supabase.from("jumpscares").insert({
        room_code: currentLobby.name,
        player_id: myPlayerId,
        username: myUsername
      });
      if (ins.error) { console.error("Force jumpscare failed:", ins.error.message); return; }
      triggerJumpscare(myUsername);
    } catch (err) { console.error("Force jumpscare failed:", err); }
  }
  $("btn-force-jumpscare").addEventListener("click", forceJumpscare);
  $("btn-preview-scare").addEventListener("click", async function() {
    if (!currentLobby) return;
    if (!syncedVideoUrl) { showStatus($("asset-status"), "Sync a video first.", true); return; }
    await dbg("Preview scare");
    triggerJumpscare(myUsername + " (preview)", true);
  });
  window.__TAURI__.event.listen("force-hotkey", function() { forceJumpscare(); });

  // ASSET POLLING
  function startAssetPolling() {
    stopAssetPolling();
    // Seed so the first poll doesn't fire a spurious "Asset Updated" scare
    if (currentLobby && supabase) {
      supabase.from("lobbies").select("video_url").eq("room_code", currentLobby.name).single()
        .then(function(res) {
          if (res.data) { lastAssetVideoUrl = res.data.video_url || null; }
        }).catch(function() {});
    }
    assetPollInterval = setInterval(async function() {
      if (!currentLobby || isAdmin || !supabase) return;
      try {
        var result = await supabase.from("lobbies").select("video_url").eq("room_code", currentLobby.name).single();
        var lobby = result.data;
        if (lobby && lobby.video_url && lobby.video_url !== lastAssetVideoUrl) {
          lastAssetVideoUrl = lobby.video_url || null;
          triggerJumpscare("Asset Updated");
        }
      } catch (_) {}
    }, 60000);
  }
  function stopAssetPolling() {
    if (assetPollInterval) clearInterval(assetPollInterval);
  }

  // AUTO-ROLL: every 5s each player rolls against chance
  function startAutoRoll() {
    stopAutoRoll();
    autoRollInterval = setInterval(async function() {
      if (!currentLobby || !supabase) return;
      try {
        var result = await supabase.from("lobbies").select("chance").eq("room_code", currentLobby.name).single();
        var lobby = result.data;
        if (!lobby) return;
        var plResult = await supabase.from("players").select("id").eq("room_code", currentLobby.name).eq("online", true);
        var pl = plResult.data;
        var count = (pl && pl.length) || 1;
        var perPlayer = lobby.chance / count;
        var roll = Math.random() * 100;
        if (roll <= perPlayer) {
          await supabase.from("jumpscares").insert({
            room_code: currentLobby.name,
            player_id: myPlayerId,
            username: myUsername
          });
      triggerJumpscare(myUsername, true); // manual force bypasses the auto-scare cooldown
        }
      } catch (_) {}
    }, 5000);
  }
  function stopAutoRoll() {
    if (autoRollInterval) clearInterval(autoRollInterval);
  }

  // PLAYER PING — update last_seen every 30s so others can detect stale players
  function startPing() {
    stopPing();
    pingInterval = setInterval(async function() {
      if (!currentLobby || !supabase || !myPlayerId) return;
      try {
        await supabase.from("players").update({ last_seen: new Date().toISOString() }).eq("id", myPlayerId);
      } catch (_) {}
    }, 30000);
  }
  function stopPing() {
    if (pingInterval) clearInterval(pingInterval);
  }

  // STALE CLEANUP — mark players offline if last_seen > 60s ago
  function startCleanup() {
    stopCleanup();
    cleanupInterval = setInterval(async function() {
      if (!currentLobby || !supabase) return;
      try {
        var cutoff = new Date(Date.now() - 60000).toISOString();
        await supabase.from("players").update({ online: false })
          .eq("room_code", currentLobby.name)
          .eq("online", true)
          .lt("last_seen", cutoff);
        refreshLobbyData();
      } catch (_) {}
    }, 30000);
  }
  function stopCleanup() {
    if (cleanupInterval) clearInterval(cleanupInterval);
  }

  // JUMPSCARE
  var lastScareAt = 0;
  var lastRandomUrl = null;
  function baseUrl(u) { return (u || "").split("?")[0]; }
  async function pickRandomVideo(current) {
    try {
      var listRes = await supabase.storage.from("jumpscare-assets").list(currentLobby.name);
      var vids = ((listRes.data) || [])
        .filter(function(f) { return f.id && /\.(webm|mp4|mov|m4v)$/i.test(f.name); })
        .map(function(f) { return currentLobby.name + "/" + f.name; });
      if (!vids.length) return null;
      var pool = vids.length > 1 ? vids.filter(function(p) { return baseUrl(p) !== baseUrl(lastRandomUrl); }) : vids;
      var pick = pool[Math.floor(Math.random() * pool.length)];
      lastRandomUrl = pick;
      var pub = supabase.storage.from("jumpscare-assets").getPublicUrl(pick);
      return pub.data.publicUrl.split("?")[0] + "?t=" + Date.now();
    } catch (_) { return null; }
  }
  async function triggerJumpscare(username, skipCooldown) {
    if (!currentLobby || !supabase) return;
    try {
      var result = await supabase.from("lobbies").select("video_url, random_mode").eq("room_code", currentLobby.name).single();
      var lobby = result.data;
      var vid = lobby ? lobby.video_url : "";
      if (lobby && lobby.random_mode) {
        vid = await pickRandomVideo(vid) || vid;
      }
      if (!vid) return; // nothing synced yet — skip empty fullscreen flash
      if (!skipCooldown) {
        var now = Date.now();
        if (now - lastScareAt < 10000) return; // ponytail: 10s cooldown for auto scares only
        lastScareAt = now;
      }
      var settings = loadSettings();
      var volume = (settings && settings.volume !== undefined) ? settings.volume : 80;
      await invoke("show_overlay");
      emit("show-jumpscare", {
        username: username,
        video_url: vid,
        volume: volume / 100
      });
      // Safety net: force hide after 30s if overlay fails to hide itself
      setTimeout(function() { invoke("hide_overlay").catch(function() {}); }, 30000);
    } catch (e) { console.error("Overlay error:", e); }
  }

  // LEAVE / DISCONNECT
  async function leaveLobby() {
    if (myPlayerId && supabase) {
      await supabase.from("players").update({ online: false }).eq("id", myPlayerId);
    }
    if (lobbyChannel && supabase) supabase.removeChannel(lobbyChannel);
    stopAssetPolling();
    stopAutoRoll();
    stopPing();
    stopCleanup();
    currentLobby = null;
    lobbyChannel = null;
    players = [];
  }

  $("btn-leave-lobby").addEventListener("click", async function() {
    await dbg("Leave lobby clicked");
    await leaveLobby();
    lobbyDetails.classList.add("hidden");
    noLobbySelected.classList.remove("hidden");
    renderLobbyList();
  });

  $("btn-delete-lobby").addEventListener("click", async function() {
    await dbg("Delete lobby clicked");
    if (!currentLobby) return;
    await supabase.from("jumpscares").delete().eq("room_code", currentLobby.name);
    await supabase.from("players").delete().eq("room_code", currentLobby.name);
    await supabase.from("lobbies").delete().eq("room_code", currentLobby.name);
    deleteLobby(currentLobby.name);
  });

  // NEW LOBBY
  var creatingLobby = false;
  $("btn-new-lobby").addEventListener("click", async function() {
    if (creatingLobby) return;
    await dbg("New lobby clicked");
    var settings = loadSettings();
    if (!settings || !settings.supabase_url || !settings.supabase_key) {
      showSettingsPanel();
      showStatus($("settings-status"), "Paste your Supabase URL and Key, then Save Settings.", true);
      return;
    }
    if (!myUsername) {
      showStatus($("setup-status"), "Enter a username first.", true);
      showView("setup");
      return;
    }
    var name = await showModal("Enter Lobby Name", "Create");
    if (!name || !name.trim()) return;
    name = name.trim();
    if (name.indexOf(":") !== -1 || name.indexOf("/") !== -1) { alert("Lobby name can't contain : or /."); return; }
    creatingLobby = true;
    try {
      myPlayerId = myPlayerId || crypto.randomUUID(); savePlayerId();
      initSupabase(settings.supabase_url, settings.supabase_key);
      await cleanupOldRows(name);
      var errResult = await withTimeout(supabase.from("lobbies").upsert({
        room_code: name, host_id: myPlayerId, admin_name: myUsername, chance: 1.0
      }), 20000, "Create lobby");
      if (errResult.error) { alert("Error: " + errResult.error.message); return; }
      var pUp = await withTimeout(supabase.from("players").upsert({
        id: myPlayerId, room_code: name, username: myUsername,
        is_admin: true, online: true, last_seen: new Date().toISOString()
      }), 20000, "Join lobby");
      if (pUp.error) { alert("Error: " + pUp.error.message); return; }
      currentLobby = { name: name, supabase_url: settings.supabase_url, supabase_key: settings.supabase_key };
      isAdmin = true;
      saveLastLobby(currentLobby.name);
      addLobbyToHistory(currentLobby);
      renderLobbyList();
      showLobbyDetails();
      subscribeToLobby();
      startAssetPolling();
      startAutoRoll();
      startPing();
      startCleanup();
    } catch (err) {
      alert("Could not create lobby: " + (err && err.message ? err.message : err));
    } finally {
      creatingLobby = false;
    }
  });

  // COPY SHARE STRING
  $("btn-copy-share").addEventListener("click", async function() {
    var text = $("share-string").textContent;
    function done() {
      $("btn-copy-share").textContent = "Copied!";
      setTimeout(function() { $("btn-copy-share").textContent = "Copy"; }, 1500);
    }
    try {
      await navigator.clipboard.writeText(text);
      done();
    } catch (_) {
      // Fallback for denied clipboard permission
      var ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); } catch (_) {}
      document.body.removeChild(ta);
    }
  });

  $("link-supabase-guide").addEventListener("click", function(e) {
    e.preventDefault();
    invoke("show_guide");
  });

  // AUTO-JOIN
  function autoJoinLast() {
    var lastName = loadLastLobby();
    if (!lastName) return;
    var list = loadLobbies();
    var lobby = list.find(function(l) { return l.name === lastName; });
    if (lobby) joinExistingLobby(lobby, true); // ponytail: silent — a stale entry must not pop an alert on boot
  }

  // BEFORE UNLOAD
  window.addEventListener("beforeunload", async function() {
    if (myPlayerId && supabase) {
      await supabase.from("players").update({ online: false }).eq("id", myPlayerId);
    }
  });

  // QUIT REQUESTED from tray
  window.__TAURI__.event.listen("quit-requested", async function() {
    if (myPlayerId && supabase) {
      await supabase.from("players").update({ online: false }).eq("id", myPlayerId);
    }
  });

  // VIDEO EDITOR
  (function() {
    var veOverlay = $("video-editor-overlay");
    var veDropzone = $("ve-dropzone");
    var vePreview = $("ve-preview");
    var veCanvas = $("ve-canvas");
    var veVideo = $("ve-video");
    var veControls = $("ve-controls");
    var veColor = $("ve-color");
    var veColorHex = $("ve-color-hex");
    var veTolerance = $("ve-tolerance");
    var veTolVal = $("ve-tol-val");
    var veExport = $("ve-export");
    var veCancel = $("ve-cancel");
    var veStatus = $("ve-status");

    var veFilePath = null;
    var vePendingFile = null;
    var veOriginalName = null; // ponytail: original filename for output naming
    var veExportPath = null; // last successful export, for the Use button
    var veAnimFrame = null;
    var veCtx = veCanvas.getContext("2d", { willReadFrequently: true });

    $("btn-video-editor").addEventListener("click", async function() {
      try { await invoke("ffmpeg_status"); } catch (e) {
        veStatus.textContent = "FFmpeg not installed. Go to Settings and click 'Download FFmpeg' first.";
        veStatus.style.color = "#e74c3c";
        veOverlay.classList.remove("hidden");
        return;
      }
      veOverlay.classList.remove("hidden");
      veFilePath = null;
      vePendingFile = null;
      veExportPath = null;
      pendingExportFile = null;
      $("ve-use").classList.add("hidden");
      vePreview.classList.add("hidden");
      veControls.classList.add("hidden");
      veStatus.textContent = "";
      veVideo.src = "";
      if (veAnimFrame) cancelAnimationFrame(veAnimFrame);
      resetTrim();
      veDropzone.classList.remove("hidden");
      $("ve-url-row").classList.remove("hidden");
      $("ve-reset").classList.add("hidden");
    });

    veCancel.addEventListener("click", closeEditor);
    $("ve-reset").addEventListener("click", function() {
      veFilePath = null;
      vePendingFile = null;
      veOriginalName = null;
      veExportPath = null;
      pendingExportFile = null;
      $("ve-use").classList.add("hidden");
      veVideo.pause();
      veVideo.removeAttribute("src");
      veVideo.load();
      if (veAnimFrame) cancelAnimationFrame(veAnimFrame);
      veAnimFrame = null;
      vePreview.classList.add("hidden");
      veControls.classList.add("hidden");
      $("ve-reset").classList.add("hidden");
      veDropzone.classList.remove("hidden");
      $("ve-url-row").classList.remove("hidden");
      $("ve-url").value = "";
      $("ve-output-name").value = "";
      veStatus.textContent = "";
      resetTrim();
    });
    veOverlay.addEventListener("click", function(e) { if (e.target === veOverlay) closeEditor(); });

    function closeEditor() {
      veOverlay.classList.add("hidden");
      veVideo.pause();
      veVideo.src = "";
      if (veAnimFrame) cancelAnimationFrame(veAnimFrame);
      veAnimFrame = null;
    }

    // Listen for file drops on the window via Tauri's built-in event
    // ponytail: handler is global so user can drop files on main window to open editor
    window.__TAURI__.event.listen("tauri://drag-drop", function(e) {
      var paths = (e.payload && e.payload.paths) || e.payload; // v2: {paths, position}; be lenient
      if (paths && paths.length > 0) {
        veOverlay.classList.remove("hidden");
        vePreview.classList.add("hidden");
        veControls.classList.add("hidden");
        veStatus.textContent = "";
        veVideo.src = "";
        if (veAnimFrame) cancelAnimationFrame(veAnimFrame);
        veFilePath = null;
        vePendingFile = null;
        loadVideoByPath(paths[0]);
      }
    });

    // Click to browse — use HTML file input (native WebView2 dialog, always works)
    veDropzone.addEventListener("click", function() {
      var input = $("ve-file-input");
      input.value = "";
      input.click();
    });

    // Hidden file input — reads file, creates blob URL for preview, stores for export
    function onVideoLoaded() {
      veCanvas.width = veVideo.videoWidth || 480;
      veCanvas.height = veVideo.videoHeight || 270;
      vePreview.classList.remove("hidden");
      veControls.classList.remove("hidden");
      veVideo.play();
      resetTrim();
      startRenderLoop();
      veDropzone.classList.add("hidden");
      $("ve-url-row").classList.add("hidden");
      $("ve-reset").classList.remove("hidden");
      $("ve-output-name").value = (veOriginalName || "output").replace(/\.[^.]+$/, "");
    }
    $("ve-file-input").addEventListener("change", async function(e) {
      if (!this.files.length) return;
      var file = this.files[0];
      veOriginalName = file.name;
      veExportPath = null;
      pendingExportFile = null;
      $("ve-use").classList.add("hidden");
      veStatus.textContent = "";
      // Use blob URL for instant preview — no temp file needed
      var url = URL.createObjectURL(file);
      veFilePath = null; // no disk path yet — only set after drag-drop or save_to_temp
      veVideo.src = url;
      veVideo.load();
      veVideo.onloadeddata = onVideoLoaded;
      // Store file for export — write to temp when user clicks Export
      vePendingFile = file;
    });

    // URL import — yt-dlp to temp, then the normal path-preview flow
    var veDownload = $("ve-download");
    veDownload.addEventListener("click", async function() {
      var url = $("ve-url").value.trim();
      if (!url) { veStatus.textContent = "Paste a video URL first."; veStatus.style.color = "#e74c3c"; return; }
      veDownload.disabled = true;
      veStatus.textContent = "Starting download...";
      veStatus.style.color = "#e67e22";
      var dlDone = false;
      var dlResult = null;
      var dlError = null;
      invoke("download_url", { url: url }).then(function(r) { dlResult = r; dlDone = true; }, function(e) { dlError = e; dlDone = true; });
      while (!dlDone) {
        if (veOverlay.classList.contains("hidden")) break; // user closed the editor meanwhile
        await new Promise(function(r) { setTimeout(r, 1000); });
        try {
          var bytes = parseInt(await invoke("download_progress"), 10) || 0;
          if (bytes > 0 && !dlDone) {
            veStatus.textContent = "Downloading video... " + (bytes / 1048576).toFixed(1) + " MB";
          }
        } catch (_) {}
      }
      veDownload.disabled = false;
      if (!dlDone) return; // editor was closed
      if (dlError) {
        veStatus.textContent = "Error: " + dlError;
        veStatus.style.color = "#e74c3c";
        return;
      }
      try {
        loadVideoByPath(dlResult);
        veStatus.textContent = "";
      } catch (e) {
        veStatus.textContent = "Error: " + e;
        veStatus.style.color = "#e74c3c";
      }
    });

    // ponytail: blob preview (asset protocol is dead in this WebView2); file stays on disk for export
    async function loadVideoByPath(path) {
      veFilePath = path;
      veExportPath = null;
      pendingExportFile = null;
      $("ve-use").classList.add("hidden");
      veOriginalName = path.split(/[\\/]/).pop(); // extract filename from path
      veStatus.textContent = "Loading preview...";
      veStatus.style.color = "#e67e22";
      try {
        var data = await invoke("read_file_bytes", { path: path });
        var ext = (veOriginalName.split(".").pop() || "mp4").toLowerCase();
        var mime = ext === "webm" ? "video/webm" : ext === "mov" ? "video/quicktime" : "video/mp4";
        var url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: mime }));
        veVideo.src = url;
        veVideo.load();
        veVideo.onloadeddata = onVideoLoaded;
        veStatus.textContent = "";
      } catch (e) {
        veStatus.textContent = "Error: " + e;
        veStatus.style.color = "#e74c3c";
      }
    }

    function renderKeyedFrame() {
      var w = veCanvas.width, h = veCanvas.height;
      if (!w || !h) return;
      veCtx.drawImage(veVideo, 0, 0, w, h);
      var imageData = veCtx.getImageData(0, 0, w, h);
      var data = imageData.data;
      var hex = veColor.value;
      var keyR = parseInt(hex.substring(1, 3), 16);
      var keyG = parseInt(hex.substring(3, 5), 16);
      var keyB = parseInt(hex.substring(5, 7), 16);
      var tol = parseInt(veTolerance.value, 10) / 100;
      var tolDist = tol * 441.67;
      for (var i = 0; i < data.length; i += 4) {
        var dr = data[i] - keyR;
        var dg = data[i + 1] - keyG;
        var db = data[i + 2] - keyB;
        var dist = Math.sqrt(dr * dr + dg * dg + db * db);
        if (dist < tolDist) { data[i + 3] = 0; }
      }
      veCtx.putImageData(imageData, 0, 0);
    }
    function startRenderLoop() {
      if (veAnimFrame) cancelAnimationFrame(veAnimFrame);
      function frame() {
        if (!veVideo.src || veVideo.paused) return;
        var trim = trimSeconds();
        // ponytail: loop inside the trim so the preview shows exactly what export will cut
        if (trim.dur && trim.t1 > trim.t0 && (veVideo.currentTime < trim.t0 - 0.05 || veVideo.currentTime >= trim.t1)) {
          veVideo.currentTime = trim.t0;
        }
        renderKeyedFrame();
        veAnimFrame = requestAnimationFrame(frame);
      }
      frame();
    }
    function resumePreview() {
      if (!veVideo.src) return;
      veVideo.play().then(function() { startRenderLoop(); }).catch(function() {});
    }

    veVideo.addEventListener("ended", function() { veVideo.currentTime = 0; veVideo.play(); });

    veCanvas.addEventListener("click", function(e) {
      var rect = veCanvas.getBoundingClientRect();
      var scaleX = veCanvas.width / rect.width;
      var scaleY = veCanvas.height / rect.height;
      var x = Math.floor((e.clientX - rect.left) * scaleX);
      var y = Math.floor((e.clientY - rect.top) * scaleY);
      var pixel = veCtx.getImageData(x, y, 1, 1).data;
      var hex = "#" + ((1 << 24) + (pixel[0] << 16) + (pixel[1] << 8) + pixel[2]).toString(16).slice(1);
      veColor.value = hex;
      veColorHex.textContent = hex;
      resumePreview(); // ponytail: canvas click resumes the trim-frozen preview (and still picks the color)
    });

    veColor.addEventListener("input", function() { veColorHex.textContent = veColor.value; resumePreview(); });
    veTolerance.addEventListener("input", function() { veTolVal.textContent = (parseInt(veTolerance.value, 10) / 100).toFixed(2); resumePreview(); });

    var veTrimStart = $("ve-trim-start");
    var veTrimEnd = $("ve-trim-end");
    var veTrimLabel = $("ve-trim-label");
    var veDuration = 0;
    function trimSeconds() {
      var raw = veDuration || veVideo.duration || 0;
      var dur = (isFinite(raw) && raw > 0) ? raw : 0; // ponytail: remote streams report Infinity at first
      var t0 = dur ? (parseFloat(veTrimStart.value) / 100) * dur : 0;
      var t1 = dur ? (parseFloat(veTrimEnd.value) / 100) * dur : 0;
      return { t0: t0, t1: t1, dur: dur };
    }
    function updateTrimLabel() {
      var t = trimSeconds();
      veTrimLabel.textContent = t.dur ? (t.t0.toFixed(1) + "s – " + t.t1.toFixed(1) + "s") : "full video";
    }
    function resetTrim() {
      // ponytail: deferred a frame — values set while hidden can paint stale knob positions
      requestAnimationFrame(function() {
        veTrimStart.value = 0;
        veTrimEnd.value = 100;
        veDuration = veVideo.duration || 0;
        updateTrimLabel();
      });
    }
    veTrimStart.addEventListener("input", function() {
      if (parseFloat(veTrimStart.value) > parseFloat(veTrimEnd.value)) veTrimEnd.value = veTrimStart.value;
      updateTrimLabel();
      veVideo.pause(); // ponytail: scrubbing freezes on the frame; canvas/tolerance/color resume
      if (!veVideo.seeking) veVideo.currentTime = trimSeconds().t0;
    });
    veTrimEnd.addEventListener("input", function() {
      if (parseFloat(veTrimEnd.value) < parseFloat(veTrimStart.value)) veTrimStart.value = veTrimEnd.value;
      updateTrimLabel();
      veVideo.pause();
      if (!veVideo.seeking) veVideo.currentTime = trimSeconds().t1;
    });
    // ponytail: change = slider released → loop the trimmed section on its own (mouse only; keyboard stays paused for inspection)
    var veTrimPointer = false;
    veTrimStart.addEventListener("pointerdown", function() { veTrimPointer = true; });
    veTrimEnd.addEventListener("pointerdown", function() { veTrimPointer = true; });
    veTrimStart.addEventListener("change", function() { if (!veTrimPointer) return; veTrimPointer = false; veVideo.currentTime = trimSeconds().t0; resumePreview(); });
    veTrimEnd.addEventListener("change", function() { if (!veTrimPointer) return; veTrimPointer = false; veVideo.currentTime = trimSeconds().t1; resumePreview(); });
    function trimNudge(e, el, dir) {
      var t = trimSeconds();
      if (!t.dur) return;
      var step = ((e.shiftKey ? 10 : 1) / 30) / t.dur * 100; // ~1 frame at 30fps (Shift: ~10)
      var v = Math.max(0, Math.min(100, parseFloat(el.value) + dir * step));
      el.value = v;
      if (el === veTrimStart && v > parseFloat(veTrimEnd.value)) veTrimEnd.value = v;
      if (el === veTrimEnd && v < parseFloat(veTrimStart.value)) veTrimStart.value = v;
      updateTrimLabel();
      veVideo.pause();
      veVideo.currentTime = el === veTrimStart ? trimSeconds().t0 : trimSeconds().t1;
    }
    veTrimStart.addEventListener("keydown", function(e) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      veTrimPointer = false;
      trimNudge(e, veTrimStart, e.key === "ArrowRight" ? 1 : -1);
    });
    veTrimEnd.addEventListener("keydown", function(e) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      veTrimPointer = false;
      trimNudge(e, veTrimEnd, e.key === "ArrowRight" ? 1 : -1);
    });
    veVideo.addEventListener("seeked", function() { if (veVideo.paused && veVideo.src) renderKeyedFrame(); });

    veExport.addEventListener("click", async function() {
      if (!veFilePath && !vePendingFile) { veStatus.textContent = "No video loaded."; veStatus.style.color = "#e74c3c"; return; }
      veExport.disabled = true;
      veStatus.textContent = "Converting... this may take a while.";
      veStatus.style.color = "#e67e22";
      try {
        // If file came from <input>, write to temp first
        if (!veFilePath && vePendingFile) {
          var sizeMB = (vePendingFile.size / (1024*1024)).toFixed(1);
          veStatus.textContent = "Preparing file (" + sizeMB + " MB)...";
          var buf = await vePendingFile.arrayBuffer();
          var arr = new Uint8Array(buf); // ponytail: Tauri v2 sends Uint8Array as binary, no Array.from needed
          var ext = vePendingFile.name.split(".").pop() || "mp4";
          var path = await invoke("save_to_temp", { name: "ve_input." + ext, data: arr });
          veFilePath = path;
        }
        // Output: transparent_videos/ under the name in the output box (no forced suffix)
        var outDir = await invoke("get_output_dir");
        var baseName = (veOriginalName || "output").replace(/\.[^.]+$/, "");
        var typed = $("ve-output-name").value.trim().replace(/[\\/:*?"<>|]+/g, "_").replace(/\.webm$/i, "");
        var outputPath = outDir + "\\" + (typed || baseName) + ".webm";
        var hexNoHash = veColor.value.substring(1);
        var tol = parseInt(veTolerance.value, 10) / 100;
        var trim = trimSeconds();
        if (trim.dur && trim.t1 <= trim.t0) {
          veStatus.textContent = "Trim end must be after trim start.";
          veStatus.style.color = "#e74c3c";
          veExport.disabled = false;
          return;
        }
        // contract: backend expects camelCase keys (verified via live invoke probe) — keep as-is
        var result = await invoke("convert_video", {
          inputPath: veFilePath,
          outputPath: outputPath,
          colorHex: hexNoHash,
          tolerance: tol,
          trimStart: trim.t0,
          trimEnd: trim.t1
        });
        // Show result path and open in explorer
        veStatus.textContent = "Done! Saved: " + result;
        veStatus.style.color = "#2ecc71";
        veExportPath = result;
        $("ve-use").classList.remove("hidden");
        // Open explorer to the output folder
        try { await invoke("open_folder", { path: outDir }); } catch (_) {}
      } catch (e) {
        veStatus.textContent = "Error: " + e;
        veStatus.style.color = "#e74c3c";
      }
      veExport.disabled = false;
    });

    $("ve-use").addEventListener("click", async function() {
      if (!veExportPath) return;
      var btn = $("ve-use");
      btn.disabled = true;
      veStatus.textContent = "Loading exported video...";
      veStatus.style.color = "#e67e22";
      try {
        var data = await invoke("read_file_bytes", { path: veExportPath });
        var name = veExportPath.split(/[\\/]/).pop();
        pendingExportFile = new File([new Uint8Array(data)], name, { type: "video/webm" });
        veStatus.textContent = "Video ready — close the editor and press Sync.";
        veStatus.style.color = "#2ecc71";
        $("asset-status").textContent = "Exported video ready — press Sync.";
        $("asset-status").style.color = "#2ecc71";
      } catch (e) {
        veStatus.textContent = "Error: " + e;
        veStatus.style.color = "#e74c3c";
      }
      btn.disabled = false;
    });
  })();

  // INIT
  var settings = loadSettings();
  if (settings && settings.username) {
    myUsername = settings.username;
    if (settings.supabase_url && settings.supabase_key) {
      initSupabase(settings.supabase_url, settings.supabase_key);
    }
    showView("menu");
    renderLobbyList();
    autoJoinLast();
  } else {
    showView("setup");
  }
  await dbg("INIT complete - app ready");
});