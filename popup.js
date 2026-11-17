// DualSubs / popup.js
// 保存した単語の一覧表示・削除・CSV出力・全削除を行う。
(function () {
  'use strict';

  var listEl = document.getElementById('list');
  var countEl = document.getElementById('count');
  var emptyEl = document.getElementById('empty');

  function load() {
    chrome.storage.local.get({ savedWords: [] }, function (res) {
      render(res.savedWords || []);
    });
  }

  function render(words) {
    countEl.textContent = words.length + ' 件';
    emptyEl.style.display = words.length ? 'none' : '';
    listEl.textContent = '';

    // 新しい順に表示する (元の配列の index は保持して削除に使う)
    words
      .map(function (entry, idx) {
        return { entry: entry, idx: idx };
      })
      .reverse()
      .forEach(function (item) {
        var e = item.entry;

        var li = document.createElement('li');
        li.className = 'item';

        var main = document.createElement('div');
        main.className = 'item-main';

        var word = document.createElement('div');
        word.className = 'word';
        word.textContent = e.display || e.word;

        var sentence = document.createElement('div');
        sentence.className = 'sentence';
        sentence.textContent = e.sentence || '';

        var meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = e.videoTitle || '';

        main.appendChild(word);
        main.appendChild(sentence);
        main.appendChild(meta);

        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'del';
        del.textContent = '削除';
        del.addEventListener('click', function () {
          removeAt(item.idx);
        });

        li.appendChild(main);
        li.appendChild(del);
        listEl.appendChild(li);
      });
  }

  function removeAt(idx) {
    chrome.storage.local.get({ savedWords: [] }, function (res) {
      var arr = (res.savedWords || []).slice();
      arr.splice(idx, 1);
      chrome.storage.local.set({ savedWords: arr }, load);
    });
  }

  // ---------- CSV 出力 ----------
  function csvField(v) {
    var s = v === null || v === undefined ? '' : String(v);
    if (/[",\r\n]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function exportCsv() {
    chrome.storage.local.get({ savedWords: [] }, function (res) {
      var words = res.savedWords || [];
      var header = 'word,sentence,japanese,timestamp,video_title,url,saved_at';
      var lines = words.map(function (e) {
        return [
          e.word,
          e.sentence,
          e.japanese,
          e.timeSec,
          e.videoTitle,
          e.url,
          e.savedAt
        ]
          .map(csvField)
          .join(',');
      });
      // Excel で文字化けしないよう UTF-8 BOM を付ける
      var csv = '﻿' + [header].concat(lines).join('\r\n');
      var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'dualsubs-words.csv';
      a.click();
      setTimeout(function () {
        URL.revokeObjectURL(a.href);
      }, 1000);
    });
  }

  document
    .getElementById('export-btn')
    .addEventListener('click', exportCsv);

  document.getElementById('clear-btn').addEventListener('click', function () {
    if (!confirm('保存した単語をすべて削除しますか？')) return;
    chrome.storage.local.set({ savedWords: [] }, load);
  });

  load();
})();
