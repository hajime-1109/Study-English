// DualSubs / content.js
// YouTube の視聴ページで日英字幕を同時表示し、英単語をクリックで保存する。
// 字幕トラックの取得は inject.js (メインワールド) と postMessage で連携する。
(function () {
  'use strict';

  var state = {
    videoId: null, // 現在の動画ID
    enCues: [], // 英語キュー [{start, dur, text}]
    jaCues: [], // 日本語キュー
    hasJaTrack: false,
    hasEnTrack: false,
    enabled: true, // オーバーレイ表示 ON/OFF
    enIdx: -1, // 現在表示中の英キュー番号
    jaText: '__init__' // 現在表示中の日本語テキスト (変化検出用)
  };

  var els = { overlay: null, note: null, en: null, ja: null, toast: null };

  // ---------- inject.js をページへ差し込む ----------
  function injectMainWorld() {
    var s = document.createElement('script');
    s.src = chrome.runtime.getURL('inject.js');
    s.onload = function () {
      s.remove();
    };
    (document.head || document.documentElement).appendChild(s);
  }

  function requestTracks() {
    window.postMessage({ type: 'DUALSUBS_REQUEST' }, window.location.origin);
  }

  // ---------- URL / 動画情報 ----------
  function getVideoIdFromUrl() {
    var m = location.search.match(/[?&]v=([\w-]{6,})/);
    return m ? m[1] : null;
  }

  function getTitle() {
    var t = document.title || '';
    t = t.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube\s*$/, '');
    return t.trim();
  }

  // ---------- 字幕トラックの選択と取得 ----------
  // 手動字幕を自動生成 (kind: "asr") より優先する
  function pickTrack(tracks, lang) {
    var cands = tracks.filter(function (t) {
      return (
        t.languageCode === lang ||
        t.languageCode.indexOf(lang + '-') === 0
      );
    });
    if (!cands.length) return null;
    cands.sort(function (a, b) {
      return (a.kind === 'asr' ? 1 : 0) - (b.kind === 'asr' ? 1 : 0);
    });
    return cands[0];
  }

  // baseUrl + "&fmt=json3" を取得し、events[].segs をキュー配列に変換する
  function fetchCues(track) {
    if (!track) return Promise.resolve([]);
    return fetch(track.baseUrl + '&fmt=json3', { credentials: 'same-origin' })
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        var cues = [];
        (data.events || []).forEach(function (ev) {
          if (!ev.segs) return;
          var text = ev.segs
            .map(function (s) {
              return s.utf8 || '';
            })
            .join('')
            .replace(/\s*\n\s*/g, ' ')
            .trim();
          if (!text) return;
          cues.push({
            start: (ev.tStartMs || 0) / 1000,
            dur: (ev.dDurationMs || 0) / 1000,
            text: text
          });
        });
        return cues;
      })
      .catch(function () {
        return [];
      });
  }

  function handleTracks(msg) {
    var urlVideoId = getVideoIdFromUrl();
    if (!urlVideoId) return;
    // 古い動画のメッセージは無視する
    if (msg.videoId && msg.videoId !== urlVideoId) return;
    if (state.videoId === urlVideoId && state.hasEnTrack) return;

    state.videoId = urlVideoId;
    state.enIdx = -1;
    state.jaText = '__init__';

    var enTrack = pickTrack(msg.tracks, 'en');
    var jaTrack = pickTrack(msg.tracks, 'ja');
    state.hasEnTrack = !!enTrack;
    state.hasJaTrack = !!jaTrack;

    fetchCues(enTrack).then(function (cues) {
      if (state.videoId !== urlVideoId) return;
      state.enCues = cues;
      state.enIdx = -1;
    });
    fetchCues(jaTrack).then(function (cues) {
      if (state.videoId !== urlVideoId) return;
      state.jaCues = cues;
      state.jaText = '__init__';
    });
    updateNote();
  }

  // ---------- オーバーレイ UI ----------
  function ensureOverlay() {
    var player = document.getElementById('movie_player');
    if (!player) return;
    if (els.overlay && els.overlay.isConnected) return;

    var overlay = document.createElement('div');
    overlay.id = 'dualsubs-overlay';

    var note = document.createElement('div');
    note.className = 'ds-note';
    note.style.display = 'none';

    var en = document.createElement('div');
    en.className = 'ds-en';
    en.style.display = 'none';

    var ja = document.createElement('div');
    ja.className = 'ds-ja';
    ja.style.display = 'none';

    var toast = document.createElement('div');
    toast.className = 'ds-toast';
    toast.style.display = 'none';

    overlay.appendChild(note);
    overlay.appendChild(en);
    overlay.appendChild(ja);
    overlay.appendChild(toast);
    player.appendChild(overlay);

    els.overlay = overlay;
    els.note = note;
    els.en = en;
    els.ja = ja;
    els.toast = toast;
    applyEnabled();
    updateNote();
  }

  function updateNote() {
    if (!els.note) return;
    var msg = '';
    if (state.videoId && !state.hasEnTrack) {
      msg = 'DualSubs: 英語字幕がありません';
    } else if (state.videoId && state.hasEnTrack && !state.hasJaTrack) {
      msg = 'DualSubs: 日本語字幕がないため英語のみ表示します';
    }
    els.note.textContent = msg;
    els.note.style.display = msg ? '' : 'none';
  }

  // プレイヤー右下コントロールに「日英」トグルボタンを追加する
  function ensureToggleButton() {
    var controls = document.querySelector('.ytp-right-controls');
    if (!controls || document.getElementById('dualsubs-toggle')) return;
    var btn = document.createElement('button');
    btn.id = 'dualsubs-toggle';
    btn.className = 'ytp-button dualsubs-toggle';
    btn.type = 'button';
    btn.textContent = '日英';
    btn.title = 'DualSubs: 日英字幕の表示 ON/OFF';
    btn.setAttribute('aria-label', 'DualSubs 日英字幕 ON/OFF');
    btn.addEventListener('click', function () {
      state.enabled = !state.enabled;
      applyEnabled();
    });
    controls.insertBefore(btn, controls.firstChild);
    applyEnabled();
  }

  function applyEnabled() {
    if (els.overlay) {
      els.overlay.style.display = state.enabled ? '' : 'none';
    }
    var btn = document.getElementById('dualsubs-toggle');
    if (btn) btn.classList.toggle('ds-off', !state.enabled);
  }

  var toastTimer = null;
  function showToast(text) {
    if (!els.toast) return;
    els.toast.textContent = text;
    els.toast.style.display = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (els.toast) els.toast.style.display = 'none';
    }, 1200);
  }

  // ---------- 字幕の同期表示 ----------
  function findCue(cues, t) {
    // start <= t < start+dur のキューを二分探索で探す
    var lo = 0;
    var hi = cues.length - 1;
    var idx = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (idx >= 0 && t < cues[idx].start + cues[idx].dur) return idx;
    return -1;
  }

  function currentJaText(t) {
    var idx = findCue(state.jaCues, t);
    return idx >= 0 ? state.jaCues[idx].text : '';
  }

  // 英字幕を単語ごとのクリック可能な span として描画する
  function renderEnCue(cue) {
    els.en.textContent = '';
    cue.text.split(/(\s+)/).forEach(function (part) {
      if (!part) return;
      if (/^\s+$/.test(part)) {
        els.en.appendChild(document.createTextNode(' '));
        return;
      }
      part.split(/([^A-Za-z'’-]+)/).forEach(function (tok) {
        if (!tok) return;
        if (/^[A-Za-z][A-Za-z'’-]*$/.test(tok)) {
          var span = document.createElement('span');
          span.className = 'ds-word';
          span.textContent = tok;
          span.addEventListener('click', function (ev) {
            ev.stopPropagation();
            saveWord(tok, cue, span);
          });
          els.en.appendChild(span);
        } else {
          els.en.appendChild(document.createTextNode(tok));
        }
      });
    });
    els.en.style.display = '';
  }

  function syncLoop() {
    ensureOverlay();
    ensureToggleButton();
    if (!state.enabled || !els.en) return;

    var video = document.querySelector('video');
    if (!video) return;
    var t = video.currentTime;

    var idx = state.enCues.length ? findCue(state.enCues, t) : -1;
    if (idx !== state.enIdx) {
      state.enIdx = idx;
      if (idx >= 0) {
        renderEnCue(state.enCues[idx]);
      } else {
        els.en.textContent = '';
        els.en.style.display = 'none';
      }
    }

    var ja = currentJaText(t);
    if (ja !== state.jaText) {
      state.jaText = ja;
      els.ja.textContent = ja;
      els.ja.style.display = ja ? '' : 'none';
    }
  }

  // ---------- 単語保存 ----------
  function saveWord(display, cue, span) {
    var word = display
      .replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '')
      .toLowerCase();
    if (!word || !state.videoId) return;

    var timeSec = Math.floor(cue.start);
    var entry = {
      word: word,
      display: display,
      sentence: cue.text,
      japanese: state.jaText && state.jaText !== '__init__' ? state.jaText : '',
      timeSec: timeSec,
      videoId: state.videoId,
      videoTitle: getTitle(),
      url:
        'https://www.youtube.com/watch?v=' +
        state.videoId +
        '&t=' +
        timeSec +
        's',
      savedAt: new Date().toISOString()
    };

    chrome.storage.local.get({ savedWords: [] }, function (res) {
      var arr = res.savedWords || [];
      var dup = arr.some(function (e) {
        return (
          e.word === entry.word &&
          e.videoId === entry.videoId &&
          e.timeSec === entry.timeSec
        );
      });
      if (dup) {
        showToast('保存済みです');
        return;
      }
      arr.push(entry);
      chrome.storage.local.set({ savedWords: arr }, function () {
        if (span) {
          span.classList.add('ds-saved');
          setTimeout(function () {
            span.classList.remove('ds-saved');
          }, 900);
        }
        showToast('保存しました: ' + word);
      });
    });
  }

  // ---------- イベント配線 ----------
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    if (ev.origin !== window.location.origin) return;
    if (ev.data && ev.data.type === 'DUALSUBS_TRACKS') {
      handleTracks(ev.data);
    }
  });

  // SPA 遷移: 動画が変わったら状態をリセットしてトラックを取り直す
  var lastVideoId = getVideoIdFromUrl();
  document.addEventListener('yt-navigate-finish', function () {
    lastVideoId = getVideoIdFromUrl();
    state.videoId = null;
    state.enCues = [];
    state.jaCues = [];
    state.enIdx = -1;
    state.jaText = '__init__';
    requestTracks();
  });
  setInterval(function () {
    var vid = getVideoIdFromUrl();
    if (vid !== lastVideoId) {
      lastVideoId = vid;
      state.videoId = null;
      state.enCues = [];
      state.jaCues = [];
      state.enIdx = -1;
      state.jaText = '__init__';
      requestTracks();
    }
  }, 1000);

  injectMainWorld();
  requestTracks();
  setInterval(syncLoop, 100);
})();
