/**
 * リョクシャカ LIVE NOTE - マイ参戦記録の Google スプレッドシート同期用 Apps Script
 *
 * 設定手順:
 *   1. 参戦記録を保存したい Google スプレッドシートを開く
 *      （旧アプリで使っていたスプレッドシートをそのまま使えます。A列「表示名」の既存データも読み込めます）
 *   2. メニュー「拡張機能」→「Apps Script」を開き、このファイルの中身をすべて貼り付ける
 *   3. 下の TOKEN を、自分だけが知っている合言葉に変更して保存
 *   4. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *        - 次のユーザーとして実行: 自分
 *        - アクセスできるユーザー: 全員
 *      でデプロイし、表示された URL（https://script.google.com/macros/s/.../exec）をコピー
 *   5. アプリの「設定」→「Google スプレッドシート同期」に URL と合言葉を入力
 *
 * ※ コードを変更した場合は「デプロイを管理」→ 編集 →「新バージョン」で再デプロイしてください。
 */

const TOKEN = 'ここを好きな合言葉に変更してください';
const SHEET_NAME = ''; // 空なら一番左のシートを使用

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!isAuthorized_(p.token)) return json_({ ok: false, error: 'unauthorized' });
  return json_({ ok: true, items: readItems_() });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'bad request' });
  }
  if (!isAuthorized_(body.token)) return json_({ ok: false, error: 'unauthorized' });

  if (body.action === 'save') {
    const items = Array.isArray(body.items) ? body.items : [];
    writeItems_(items);
    return json_({ ok: true, count: items.length });
  }
  return json_({ ok: false, error: 'unknown action' });
}

function isAuthorized_(token) {
  return TOKEN && token && String(token) === TOKEN && TOKEN !== 'ここを好きな合言葉に変更してください';
}

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return (SHEET_NAME && ss.getSheetByName(SHEET_NAME)) || ss.getSheets()[0];
}

function readItems_() {
  const values = sheet_().getDataRange().getDisplayValues();
  if (!values.length) return [];
  const header = values[0].map(function (h) { return String(h).trim(); });
  let iName = header.indexOf('表示名');
  const iUrl = header.indexOf('ライブ情報');
  let start = 1;
  if (iName < 0 && iUrl < 0) { iName = 0; start = 0; } // 見出し行がない場合は A 列を表示名として扱う
  const items = [];
  for (let r = start; r < values.length; r++) {
    const name = iName >= 0 ? String(values[r][iName] || '').trim() : '';
    const url = iUrl >= 0 ? String(values[r][iUrl] || '').trim() : '';
    if (name || url) items.push({ '表示名': name, 'ライブ情報': url });
  }
  return items;
}

function writeItems_(items) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = sheet_();
    const rows = [['表示名', 'ライブ情報']].concat(items.map(function (it) {
      return [String(it['表示名'] || ''), String(it['ライブ情報'] || '')];
    }));
    sh.clearContents();
    const range = sh.getRange(1, 1, rows.length, 2);
    range.setNumberFormat('@'); // 日付などに自動変換されないよう文字列として保存
    range.setValues(rows);
  } finally {
    lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
