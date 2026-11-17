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
    jaText: '__init__', // 現在表示中の日本語テキスト (変化検出用)
    mtMode: false, // 日本語トラックがなく機械翻訳で代用するモード
    mtCache: new Map(), // 機械翻訳キャッシュ (英キュー文 -> 日本語文)。動画ごとにクリア
    mtPending: new Map(), // 翻訳リクエスト中 (英キュー文 -> Promise)。二重リクエスト防止
    tracksLoading: false // 字幕トラック (キュー) を取得中かどうか
  };

  var els = { overlay: null, note: null, status: null, en: null, ja: null, toast: null };

  // 日本語行が「翻訳待ち」を表す内部センチネル値 (state.jaText の比較用)
  var MT_PENDING = '__mt_pending__';

  // inject.js は manifest の content_scripts で "world": "MAIN" 指定により
  // ページのメインワールドへ直接読み込まれる (script タグ差し込みはしない。
  // Brave 等で chrome-extension:// の読み込みがブロックされるため)。
  // 連携は window.postMessage 経由。
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
    state.mtCache.clear();
    state.mtPending.clear();

    var enTrack = pickTrack(msg.tracks, 'en');
    var jaTrack = pickTrack(msg.tracks, 'ja');
    state.hasEnTrack = !!enTrack;
    state.hasJaTrack = !!jaTrack;
    // 英語トラックはあるが日本語トラックがない場合だけ機械翻訳モードにする。
    // 日本語トラックがある動画では従来どおり実トラックだけを使う。
    state.mtMode = !!enTrack && !jaTrack;

    // 両トラックの取得が終わるまで「読み込み中」を表示する
    state.tracksLoading = true;
    updateStatus();
    var enSettled = false;
    var jaSettled = false;
    function onSettle() {
      if (enSettled && jaSettled) {
        state.tracksLoading = false;
        updateStatus();
      }
    }

    fetchCues(enTrack).then(function (cues) {
      if (state.videoId !== urlVideoId) return;
      state.enCues = cues;
      state.enIdx = -1;
      enSettled = true;
      onSettle();
    });
    fetchCues(jaTrack).then(function (cues) {
      if (state.videoId !== urlVideoId) return;
      state.jaCues = cues;
      state.jaText = '__init__';
      // 日本語トラックが「ある」と報告されても中身が 0 件なら、
      // 実質ないのと同じなので機械翻訳モードに切り替える
      if (state.hasJaTrack && cues.length === 0 && state.hasEnTrack) {
        state.mtMode = true;
        if (state.enIdx >= 0) prefetchTranslations(state.enIdx);
      }
      jaSettled = true;
      onSettle();
    });
    updateNote();
  }

  // ---------- 機械翻訳フォールバック ----------
  // 日本語トラックがない動画では、英語キューを Google 翻訳の無料エンドポイント
  // (キー不要) でその場翻訳して下段に表示する。全トラックを一括翻訳せず、
  // 表示中のキュー + 先行2キューだけをオンデマンドで翻訳する。
  // 翻訳 fetch はまずサービスワーカー (background.js) に依頼する。
  // コンテンツスクリプトからの直接 fetch はページの CORS 制約を受けるが、
  // サービスワーカー経由なら host_permissions の範囲で確実に届く。
  // ワーカーが失敗した場合だけ、従来どおり直接 fetch にフォールバックする。
  function translateViaWorker(text) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(
          { type: 'DUALSUBS_TRANSLATE', text: text },
          function (res) {
            if (
              chrome.runtime.lastError ||
              !res ||
              !res.ok ||
              !res.translated
            ) {
              resolve(null);
            } else {
              resolve(res.translated);
            }
          }
        );
      } catch (e) {
        resolve(null);
      }
    });
  }

  function translateViaFetch(text) {
    var url =
      'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ja&dt=t&q=' +
      encodeURIComponent(text);
    return fetch(url)
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        // 応答形式: data[0] = [[訳文の一部, 原文の一部, ...], ...]
        var out = '';
        if (data && Array.isArray(data[0])) {
          data[0].forEach(function (seg) {
            if (seg && seg[0]) out += seg[0];
          });
        }
        return out || null;
      })
      .catch(function () {
        return null;
      });
  }

  function translateCueText(text) {
    if (!text) return;
    if (state.mtCache.has(text) || state.mtPending.has(text)) return;
    var p = translateViaWorker(text)
      .then(function (out) {
        if (out) return out;
        return translateViaFetch(text);
      })
      .then(function (out) {
        // 両方失敗した場合だけ空でキャッシュする (字幕表示自体は壊さない)
        state.mtCache.set(text, out || '');
      })
      .catch(function () {
        state.mtCache.set(text, '');
      })
      .then(function () {
        state.mtPending.delete(text);
        // 翻訳が遅れて届いた場合に備え、変化検出をリセットして
        // 次の同期ループ (100ms周期) で日本語行を再描画させる
        state.jaText = '__init__';
      });
    state.mtPending.set(text, p);
  }

  // 現在のキューと先行2キューの翻訳を先読みする
  function prefetchTranslations(idx) {
    if (!state.mtMode) return;
    for (var i = idx; i <= idx + 2 && i < state.enCues.length; i++) {
      if (i >= 0) translateCueText(state.enCues[i].text);
    }
  }

  // ---------- オーバーレイ UI ----------
  function ensureOverlay() {
    var player = document.getElementById('movie_player');
    if (!player) return;

    // トーストはオーバーレイの外 (プレイヤー直下) に置く。
    // オーバーレイを OFF にした瞬間の「字幕表示 OFF」も見えるようにするため。
    if (!els.toast || !els.toast.isConnected) {
      var toast = document.createElement('div');
      toast.id = 'dualsubs-toast';
      toast.style.display = 'none';
      player.appendChild(toast);
      els.toast = toast;
    }

    if (els.overlay && els.overlay.isConnected) return;

    var overlay = document.createElement('div');
    overlay.id = 'dualsubs-overlay';

    var note = document.createElement('div');
    note.className = 'ds-note';
    note.style.display = 'none';

    var status = document.createElement('div');
    status.className = 'ds-status';
    status.style.display = 'none';

    var en = document.createElement('div');
    en.className = 'ds-en';
    en.style.display = 'none';

    var ja = document.createElement('div');
    ja.className = 'ds-ja';
    ja.style.display = 'none';

    overlay.appendChild(note);
    overlay.appendChild(status);
    overlay.appendChild(en);
    overlay.appendChild(ja);
    player.appendChild(overlay);

    els.overlay = overlay;
    els.note = note;
    els.status = status;
    els.en = en;
    els.ja = ja;
    applyEnabled();
    updateNote();
    updateStatus();
  }

  function updateNote() {
    if (!els.note) return;
    var msg = '';
    if (state.videoId && !state.hasEnTrack) {
      msg = 'DualSubs: 英語字幕がありません';
    }
    els.note.textContent = msg;
    els.note.style.display = msg ? '' : 'none';
  }

  // 字幕トラック取得中は「字幕を読み込み中…」を出し、終わったら消す
  function updateStatus() {
    if (!els.status) return;
    var msg = state.tracksLoading ? '字幕を読み込み中…' : '';
    els.status.textContent = msg;
    els.status.style.display = msg ? '' : 'none';
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
      showToast(state.enabled ? '字幕表示 ON' : '字幕表示 OFF');
    });
    controls.insertBefore(btn, controls.firstChild);
    applyEnabled();
  }

  function applyEnabled() {
    if (els.overlay) {
      els.overlay.style.display = state.enabled ? '' : 'none';
    }
    var btn = document.getElementById('dualsubs-toggle');
    if (btn) {
      // ON = 白地に黒文字 + 青ライン、OFF = 半透明。一目で状態が分かるようにする
      btn.classList.toggle('ds-on', state.enabled);
      btn.classList.toggle('ds-off', !state.enabled);
    }
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
    if (state.hasJaTrack) {
      var idx = findCue(state.jaCues, t);
      if (idx >= 0) return state.jaCues[idx].text;
      // 実トラックに重なるキューがない場合は、下の機械翻訳フォールバックへ
    }
    if (state.mtMode) {
      // 機械翻訳モード: 現在の英語キューに対応する翻訳を返す。
      // まだ届いていなければ MT_PENDING を返し、表示側で「翻訳中…」にする。
      // (翻訳が失敗して空でキャッシュ済みの場合は空のまま)
      var eIdx = state.enCues.length ? findCue(state.enCues, t) : -1;
      if (eIdx < 0) return '';
      var text = state.enCues[eIdx].text;
      if (state.mtCache.has(text)) return state.mtCache.get(text);
      return MT_PENDING;
    }
    return '';
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
        // 機械翻訳モードでは、このキューと先行2キューを翻訳しておく
        prefetchTranslations(idx);
      } else {
        els.en.textContent = '';
        els.en.style.display = 'none';
      }
    }

    var ja = currentJaText(t);
    if (ja !== state.jaText) {
      state.jaText = ja;
      if (ja === MT_PENDING) {
        // 翻訳待ちの間は空白にせず、薄く「翻訳中…」と出す
        els.ja.textContent = '翻訳中…';
        els.ja.classList.add('ds-ja-pending');
        els.ja.style.display = '';
      } else {
        els.ja.textContent = ja;
        els.ja.classList.remove('ds-ja-pending');
        els.ja.style.display = ja ? '' : 'none';
      }
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
      japanese:
        state.jaText &&
        state.jaText !== '__init__' &&
        state.jaText !== MT_PENDING
          ? state.jaText
          : '',
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
    state.mtMode = false;
    state.mtCache.clear();
    state.mtPending.clear();
    state.tracksLoading = false;
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
      state.mtMode = false;
      state.mtCache.clear();
      state.mtPending.clear();
      state.tracksLoading = false;
      requestTracks();
    }
  }, 1000);

  requestTracks();
  setInterval(syncLoop, 100);
})();
