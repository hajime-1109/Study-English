// DualSubs / inject.js
// ページのメインワールドで動作する小さなスクリプト。
// ytInitialPlayerResponse から字幕トラック一覧を読み取り、
// window.postMessage でコンテンツスクリプト (content.js) へ渡す。
(function () {
  'use strict';

  function sendTracks() {
    try {
      var pr = window.ytInitialPlayerResponse;
      if (!pr) return false;
      var renderer =
        pr.captions && pr.captions.playerCaptionsTracklistRenderer;
      var tracks = (renderer && renderer.captionTracks) || [];
      var videoId = pr.videoDetails && pr.videoDetails.videoId;
      window.postMessage(
        {
          type: 'DUALSUBS_TRACKS',
          videoId: videoId || null,
          tracks: tracks.map(function (t) {
            return {
              baseUrl: t.baseUrl,
              languageCode: t.languageCode,
              kind: t.kind || '',
              name: (t.name && t.name.simpleText) || ''
            };
          })
        },
        window.location.origin
      );
      return true;
    } catch (e) {
      return false;
    }
  }

  // 初回ロード時: ytInitialPlayerResponse が用意できるまで少しリトライする
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    if (sendTracks() || tries > 20) clearInterval(timer);
  }, 500);

  // YouTube の SPA 遷移のたびに、新しい動画のトラックを送り直す
  document.addEventListener('yt-navigate-finish', function () {
    setTimeout(sendTracks, 300);
  });

  // コンテンツスクリプトからの再要求に応答する
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    if (ev.data && ev.data.type === 'DUALSUBS_REQUEST') sendTracks();
  });
})();
