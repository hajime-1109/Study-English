// DualSubs / background.js
// Manifest V3 のサービスワーカー。
// コンテンツスクリプトからの依頼を受けて Google 翻訳の無料エンドポイントへ
// fetch する。サービスワーカーからの fetch はページ側の CORS 制約を受けない
// (host_permissions の範囲内) ため、コンテンツスクリプトから直接叩くより確実。
(function () {
  'use strict';

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== 'DUALSUBS_TRANSLATE' || !msg.text) {
      return false;
    }
    var url =
      'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ja&dt=t&q=' +
      encodeURIComponent(msg.text);
    fetch(url)
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
        if (out) {
          sendResponse({ ok: true, translated: out });
        } else {
          sendResponse({ ok: false });
        }
      })
      .catch(function () {
        sendResponse({ ok: false });
      });
    return true; // 非同期で sendResponse するので true を返す
  });
})();
