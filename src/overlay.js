// ── Jumpscare Overlay Logic ────────────────────────
// ponytail: guarded Tauri access so the page never hard-crashes outside the app
var TAURI = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.event) ? window.__TAURI__ : null;
function tauriInvoke(cmd, args) {
  if (!TAURI) return Promise.reject(new Error("no tauri runtime"));
  return TAURI.core.invoke(cmd, args);
}
function tauriListen(ev, cb) {
  if (!TAURI) return Promise.resolve(function() {});
  return TAURI.event.listen(ev, cb);
}

const imgEl = document.getElementById('jumpscare-image');
const videoEl = document.getElementById('jumpscare-video');
const labelEl = document.getElementById('username-label');

let hideTimeout = null;
let pendingShow = null;

tauriListen('show-jumpscare', (event) => {
  const { username, video_url, volume } = event.payload;
  showJumpscare(username, video_url, volume);
});
// Browser test hook: window.__showJumpscare reaches the same path without Tauri events
window.__showJumpscare = showJumpscare;

function isVideoUrl(url) {
  var u = (url || "").split("?")[0].toLowerCase();
  return u.endsWith(".webm") || u.endsWith(".mp4") || u.endsWith(".mov") || u.endsWith(".m4v");
}

async function showJumpscare(username, videoUrl, volume) {
  if (!videoUrl) return; // nothing to show — never queue or flash empty
  if (hideTimeout) { pendingShow = { username: username, videoUrl: videoUrl, volume: volume }; return; }

  labelEl.textContent = 'Jumpscared by: ' + (username || "???");

  let mediaDuration = 0;

  if (videoUrl) {
    if (isVideoUrl(videoUrl)) {
      imgEl.style.display = 'none';
      videoEl.style.display = 'block';
      labelEl.style.display = 'block';
      videoEl.volume = (volume !== undefined ? volume : 0.8);
      mediaDuration = await playVideo(videoUrl);
    } else {
      videoEl.style.display = 'none';
      try { videoEl.pause(); videoEl.removeAttribute('src'); videoEl.load(); } catch (_) {}
      imgEl.src = videoUrl;
      imgEl.style.display = 'block';
      labelEl.style.display = 'block';
      mediaDuration = await getImageDuration(videoUrl);
    }
  }

  const duration = Math.max(mediaDuration, 1);
  const hideAfter = Math.min(duration, 30);
  scheduleHide(hideAfter);
}

// Returns video duration in seconds (0 on failure). Resolves once playable.
function playVideo(url) {
  return new Promise(function(resolve) {
    var done = false;
    function finish(v) { if (!done) { done = true; cleanup(); resolve(v); } }
    function cleanup() {
      videoEl.removeEventListener('loadedmetadata', onMeta);
      videoEl.removeEventListener('durationchange', onDur);
      videoEl.removeEventListener('playing', onPlaying);
      videoEl.removeEventListener('error', onErr);
    }
    function kickPlayback() {
      if (videoEl.paused) {
        videoEl.muted = true; // ponytail: start silent (always allowed) so motion never freezes, then try sound
        videoEl.play().then(function() {
          videoEl.muted = false;
        }).catch(function() {});
      }
    }
    function settle() {
      // ponytail: WebM often reports Infinity at first — wait for the real duration
      var d = videoEl.duration;
      if (isFinite(d) && d > 0) finish(d);
    }
    function onMeta() { kickPlayback(); settle(); }
    function onDur() { kickPlayback(); settle(); }
    function onPlaying() { settle(); }
    function onErr() { finish(0); }
    videoEl.addEventListener('loadedmetadata', onMeta);
    videoEl.addEventListener('durationchange', onDur);
    videoEl.addEventListener('playing', onPlaying);
    videoEl.addEventListener('error', onErr);
    videoEl.src = url;
    videoEl.load();
    kickPlayback(); // ponytail: don't gate playback on metadata — these files don't reliably fire loadedmetadata
    setTimeout(function() {
      kickPlayback();
      var d = videoEl.duration;
      finish(isFinite(d) && d > 0 ? d : 5);
    }, 8000); // never hang the hide timer
  });
}

function scheduleHide(seconds) {
  if (hideTimeout) return;
  hideTimeout = setTimeout(() => {
    var next = pendingShow;
    pendingShow = null;
    hideTimeout = null;
    if (next) { showJumpscare(next.username, next.videoUrl, next.volume); return; } // ponytail: chained scare plays seamlessly, no hide flicker
    imgEl.style.display = 'none';
    imgEl.src = '';
    videoEl.style.display = 'none';
    try { videoEl.pause(); videoEl.removeAttribute('src'); videoEl.load(); } catch (_) {}
    labelEl.style.display = 'none';
    tauriInvoke('hide_overlay').catch(function() {});
  }, seconds * 1000);
}

// ── Parse GIF total animation duration ──────────────
async function getImageDuration(url) {
  try {
    const resp = await fetch(url);
    const buf = await resp.arrayBuffer();
    const v = new Uint8Array(buf);

    // Validate GIF header
    if (v[0] !== 0x47 || v[1] !== 0x49 || v[2] !== 0x46) return 5;

    let totalMs = 0;
    let i = 6 + 7; // skip header + Logical Screen Descriptor

    while (i < v.length) {
      if (v[i] === 0x21) {
        // Extension block
        i++;
        if (v[i] === 0xF9) {
          // Graphic Control Extension (has delay)
          i++;
          const blockSize = v[i]; i++;
          const delay = (v[i + 2] << 8) | v[i + 1];
          totalMs += (delay || 10) * 100;
          i += blockSize;
          i++; // block terminator
        } else {
          i++;
          // Skip sub-blocks
          while (i < v.length && v[i] !== 0) { i += v[i] + 1; }
          i++; // terminator
        }
      } else if (v[i] === 0x2C) {
        // Image descriptor — skip entirely
        i++; i += 9;
        // Local Color Table?
        if (v[i] & 0x80) { i += (2 << (v[i] & 0x07)) * 3; }
        i++; // LZW min code size
        while (i < v.length && v[i] !== 0) { i += v[i] + 1; }
        i++; // terminator
      } else if (v[i] === 0x3B) {
        break;
      } else {
        i++;
      }
    }
    return totalMs / 1000;
  } catch (e) {
    console.error('Image parse failed:', e);
    return 5;
  }
}
