/* リョクシャカ LIVE NOTE
 * 依存ライブラリなしの静的 Web アプリ。データは data.json（GitHub Actions が毎日生成）を読み込みます。
 */
'use strict';

/* ================================================================
 * 定数
 * ================================================================ */
const REPO_URL = 'https://github.com/Kanato-M/ryokushaka-app';
const WORKFLOW_URL = REPO_URL + '/actions/workflows/update-and-deploy.yml';
const DEFAULT_MODEL = 'gemini-flash-latest';

const RARITY = {
  NEVER: { label: '未披露', color: '#5f6b64', order: 0, desc: '公式曲リストにあるが、ライブでの披露記録がない曲' },
  UR:    { label: 'UR',  color: '#ff3d9a', order: 1, desc: '最終披露日から4年以上経過' },
  COVER: { label: '未収録', color: '#ff3d9a', order: 1.5, desc: '公式曲リストにないカバー曲・未音源化曲など（UR扱い）' },
  SSR:   { label: 'SSR', color: '#ff8c00', order: 2, desc: '最終披露日から2年以上経過' },
  SR:    { label: 'SR',  color: '#f2c200', order: 3, desc: '直近2年の披露率が4%以下', darkText: true },
  RR:    { label: 'RR',  color: '#9b4fe0', order: 4, desc: '直近2年の披露率が8%以下' },
  R:     { label: 'R',   color: '#1c83e1', order: 5, desc: '直近2年の披露率が30%以下' },
  UC:    { label: 'UC',  color: '#26a843', order: 6, desc: '直近2年の披露率が50%以下' },
  C:     { label: 'C',   color: '#9aa39d', order: 7, desc: '上記以外（定番曲）' },
};
const RARITY_KEYS = ['UR', 'SSR', 'SR', 'RR', 'R', 'UC', 'C'];

const LIVE_TYPES = { oneman: 'ワンマン', fc: 'FC', event: 'フェス・イベント', tv: 'TV・配信' };

const LS = {
  my: 'rln.myLives.v1',
  extra: 'rln.myExtra.v1',
  settings: 'rln.settings.v1',
  seeded: 'rln.seeded.v1',
  pending: 'rln.syncPending.v1',
  chat: 'rln.chat.v1',
};

/* ================================================================
 * 状態
 * ================================================================ */
const S = {
  data: null,
  today: '',
  lives: [],
  liveById: new Map(),
  liveByDisplay: new Map(),
  songs: [],
  songByTitle: new Map(),
  stats: new Map(),
  my: new Set(),
  myExtra: [],
  settings: {},
  heardCache: null,
  ui: {
    livesTab: 'past', livesQuery: '', livesType: 'all', livesYear: 'all', livesMine: false, livesLimit: 60,
    songsQuery: '', songsSort: 'rarity', songsRarity: 'all', songsHeard: 'all',
    myHeardSort: 'count',
  },
  scroll: new Map(),
};

/* ================================================================
 * ユーティリティ
 * ================================================================ */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
const parseDate = (s) => { const [y, m, d] = s.split('/').map(Number); return new Date(y, m - 1, d); };
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const withWeekday = (s) => `${s}（${WD[parseDate(s).getDay()]}）`;
const daysUntil = (s) => Math.round((parseDate(s) - parseDate(S.today)) / 86400000);
const pct = (v) => `${(v || 0).toFixed(1)}%`;
const inc = (map, k, n = 1) => map.set(k, (map.get(k) || 0) + n);
const displayName = (l) => `${l.date} | ${l.name} @ ${l.venue}`;
const songHref = (t) => `#/song/${encodeURIComponent(t)}`;
const collator = new Intl.Collator('ja');
const normalize = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');

function loadJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full / private mode */ }
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ================================================================
 * データ準備・統計（レアリティ判定）
 * ================================================================ */
function indexData(data) {
  S.data = data;
  S.today = fmtDate(new Date());
  S.lives = data.lives;
  S.liveById = new Map(S.lives.map((l) => [l.id, l]));
  S.liveByDisplay = new Map(S.lives.map((l) => [displayName(l), l]));
  S.songs = data.songs;
  S.songByTitle = new Map(S.songs.map((s) => [s.title, s]));
  computeStats();
}

const isPast = (l) => l.date < S.today || (l.date === S.today && l.hasSetlist);
const isUpcoming = (l) => !isPast(l);

/**
 * 楽曲ごとの披露回数・披露率・レア度を計算する。
 * 旧アプリと同じ「ツアー規模（同名公演数）で重み付けした披露率」を使う:
 *   評価値 = Σ(そのツアーでの披露回数 / そのツアーの総公演数)
 *   披露率 = 評価値 / 対象期間のツアー（ライブ名）数
 */
function computeStats() {
  const todayD = parseDate(S.today);
  const twoAgoD = new Date(todayD); twoAgoD.setFullYear(todayD.getFullYear() - 2);
  const twoAgo = fmtDate(twoAgoD);
  const past = S.lives.filter((l) => l.date <= S.today);

  const total = new Map(), total2y = new Map();
  for (const l of past) {
    inc(total, l.name);
    if (l.date > twoAgo) inc(total2y, l.name);
  }

  const per = new Map();
  for (const l of past) {
    const sl = S.data.setlists[l.id];
    if (!sl) continue;
    for (const t of sl) {
      let p = per.get(t);
      if (!p) { p = { lives: [], byName: new Map(), byName2y: new Map() }; per.set(t, p); }
      p.lives.push(l);
      inc(p.byName, l.name);
      if (l.date > twoAgo) inc(p.byName2y, l.name);
    }
  }

  const uniqueFromCache = new Map();
  const uniqueNamesFrom = (d) => {
    if (!uniqueFromCache.has(d)) {
      const set = new Set();
      for (const l of past) if (l.date >= d) set.add(l.name);
      uniqueFromCache.set(d, set.size);
    }
    return uniqueFromCache.get(d);
  };

  S.stats = new Map();
  for (const [title, p] of per) {
    p.lives.sort((a, b) => (a.date < b.date ? 1 : -1));
    const last = p.lives[0].date;
    const first = p.lives[p.lives.length - 1].date;
    let scoreAll = 0, score2y = 0;
    for (const [n, c] of p.byName) scoreAll += c / total.get(n);
    for (const [n, c] of p.byName2y) score2y += c / total2y.get(n);
    const uAfter = uniqueNamesFrom(first);
    const rateAll = uAfter ? (scoreAll / uAfter) * 100 : 0;
    const rate2y = first > twoAgo ? rateAll : (total2y.size ? (score2y / total2y.size) * 100 : 0);
    const years = (todayD - parseDate(last)) / 86400000 / 365.25;

    let rarity;
    if (!S.songByTitle.has(title)) rarity = 'COVER';
    else if (years >= 4) rarity = 'UR';
    else if (years >= 2) rarity = 'SSR';
    else if (rate2y <= 4) rarity = 'SR';
    else if (rate2y <= 8) rarity = 'RR';
    else if (rate2y <= 30) rarity = 'R';
    else if (rate2y <= 50) rarity = 'UC';
    else rarity = 'C';

    S.stats.set(title, { title, count: p.lives.length, first, last, rateAll, rate2y, rarity, lives: p.lives, official: S.songByTitle.has(title) });
  }
  for (const s of S.songs) {
    if (!S.stats.has(s.title)) {
      S.stats.set(s.title, { title: s.title, count: 0, first: '', last: '', rateAll: 0, rate2y: 0, rarity: 'NEVER', lives: [], official: true });
    }
  }
  S.heardCache = null;
}

const rarityOf = (title) => (S.stats.get(title) || { rarity: S.songByTitle.has(title) ? 'NEVER' : 'COVER' }).rarity;

function badge(key) {
  const r = RARITY[key] || RARITY.C;
  return `<span class="badge${r.darkText ? ' dark-text' : ''}" style="background:${r.color}">${esc(r.label)}</span>`;
}

/** 参戦済み（過去）公演で聴いた曲 */
function heardSongs() {
  if (S.heardCache) return S.heardCache;
  const map = new Map(); // title -> {count, firstLive}
  const attended = [...S.my].map((id) => S.liveById.get(id)).filter((l) => l && isPast(l)).sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const l of attended) {
    for (const t of S.data.setlists[l.id] || []) {
      const h = map.get(t);
      if (h) h.count++;
      else map.set(t, { title: t, count: 1, firstLive: l });
    }
  }
  S.heardCache = { map, attended };
  return S.heardCache;
}

function myLivesSorted() {
  return [...S.my].map((id) => S.liveById.get(id)).filter(Boolean).sort((a, b) => (a.date < b.date ? 1 : -1));
}

/* ================================================================
 * マイ参戦記録の保存・同期（Google スプレッドシート / 端末内）
 * ================================================================ */
const Sync = {
  busy: false,
  configured() { return !!(S.settings.gasUrl && S.settings.gasToken); },

  setStatus(state, text) {
    const el = $('#sync-status');
    if (!this.configured() && state !== 'err') { el.hidden = true; return; }
    el.hidden = false;
    el.className = 'sync-status' + (state === 'err' ? ' err' : '');
    el.textContent = text;
    el.title = state === 'err' ? '同期に失敗しました。設定画面から再同期できます。' : 'Google スプレッドシートと同期';
  },

  items() {
    const items = myLivesSorted().map((l) => ({ 表示名: displayName(l), ライブ情報: l.url }));
    return items.concat(S.myExtra);
  },

  async request(method, body) {
    const url = new URL(S.settings.gasUrl);
    let res;
    if (method === 'GET') {
      url.searchParams.set('token', S.settings.gasToken);
      url.searchParams.set('t', Date.now());
      res = await fetch(url, { redirect: 'follow' });
    } else {
      // text/plain にすることで CORS のプリフライトを回避（Apps Script の仕様に合わせる）
      res = await fetch(url, {
        method: 'POST', redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ ...body, token: S.settings.gasToken }),
      });
    }
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error('スプレッドシートからの応答を読み取れませんでした（URL・公開設定を確認してください）'); }
    if (!json.ok) throw new Error(json.error === 'unauthorized' ? '合言葉（トークン）が一致しません' : (json.error || '不明なエラー'));
    return json;
  },

  async pull() {
    const json = await this.request('GET');
    applyRemoteItems(json.items || []);
  },

  async push() {
    await this.request('POST', { action: 'save', items: this.items() });
  },

  /** 起動時・手動同期: 未送信の変更があれば送信、なければ取得 */
  async syncNow({ silent = false } = {}) {
    if (!this.configured() || this.busy) return;
    this.busy = true;
    this.setStatus('busy', '⏳ 同期中');
    try {
      if (loadJSON(LS.pending, false)) {
        await this.push();
        saveJSON(LS.pending, false);
      } else {
        await this.pull();
      }
      this.setStatus('ok', '☁️ 同期済み');
      if (!silent) toast('スプレッドシートと同期しました');
      return true;
    } catch (e) {
      this.setStatus('err', '⚠️ 同期エラー');
      if (!silent) toast('同期エラー: ' + e.message);
      console.error(e);
      return false;
    } finally {
      this.busy = false;
    }
  },

  schedulePush: debounce(async function () {
    if (!Sync.configured()) return;
    Sync.setStatus('busy', '⏳ 保存中');
    try {
      await Sync.push();
      saveJSON(LS.pending, false);
      Sync.setStatus('ok', '☁️ 同期済み');
    } catch (e) {
      Sync.setStatus('err', '⚠️ 同期エラー');
      toast('スプレッドシートへの保存に失敗しました。端末には保存済みです。');
      console.error(e);
    }
  }, 700),
};

function resolveItem(item) {
  const url = item['ライブ情報'] || item.url || '';
  const m = String(url).match(/events\/(\d+)/);
  if (m && S.liveById.has(m[1])) return m[1];
  const name = String(item['表示名'] || item.name || '').trim();
  const l = S.liveByDisplay.get(name);
  return l ? l.id : null;
}

function applyRemoteItems(items) {
  const ids = new Set();
  const extra = [];
  for (const it of items) {
    const id = resolveItem(it);
    if (id) ids.add(id);
    else if (it['表示名'] || it['ライブ情報']) extra.push({ 表示名: it['表示名'] || '', ライブ情報: it['ライブ情報'] || '' });
  }
  S.my = ids;
  S.myExtra = extra;
  persistLocal(false);
}

function persistLocal(markPending = true) {
  saveJSON(LS.my, [...S.my]);
  saveJSON(LS.extra, S.myExtra);
  S.heardCache = null;
  if (markPending && Sync.configured()) {
    saveJSON(LS.pending, true);
    Sync.schedulePush();
  }
}

function toggleAttend(id) {
  const l = S.liveById.get(id);
  if (!l) return;
  if (S.my.has(id)) {
    S.my.delete(id);
    toast('参戦記録から外しました');
  } else {
    S.my.add(id);
    toast(isPast(l) ? '参戦記録に追加しました 🎉' : '参戦予定に追加しました 🎫');
  }
  persistLocal();
  rerender();
}

/* ================================================================
 * チャート（依存ライブラリなし）
 * ================================================================ */
function vbarChart(items) {
  const max = Math.max(1, ...items.map((i) => i.value));
  const every = items.length > 14 ? Math.ceil(items.length / 10) : 1;
  return `<div class="vbars">${items.map((i, idx) => `
    <div class="b" title="${esc(i.label)}: ${i.value}">
      <div class="bar${i.value ? '' : ' zero'}" style="height:${(i.value / max) * 100}%">${i.value ? `<span>${i.value}</span>` : ''}</div>
      <div class="lbl">${idx % every === 0 || idx === items.length - 1 ? esc(i.label) : '&nbsp;'}</div>
    </div>`).join('')}</div>`;
}

function hbarChart(items, hrefFn) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return `<div class="hbars">${items.map((i) => `
    <div class="hb">
      <div class="n">${hrefFn ? `<a href="${hrefFn(i)}">${esc(i.label)}</a>` : esc(i.label)}</div>
      <div class="track"><div class="fill" style="width:${Math.max(8, (i.value / max) * 100)}%">${i.value}</div></div>
    </div>`).join('')}</div>`;
}

function donutChart(segments, centerLabel) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  if (!total) return '<p class="empty">データがありません</p>';
  let acc = 0;
  const stops = segments.map((s) => {
    const from = (acc / total) * 360; acc += s.value;
    return `${s.color} ${from}deg ${(acc / total) * 360}deg`;
  });
  return `<div class="donut-wrap">
    <div class="donut" style="background:conic-gradient(${stops.join(',')})"><div class="c"><div><b>${total}</b>${esc(centerLabel)}</div></div></div>
    <ul class="legend">${segments.map((s) => `<li><span class="sw" style="background:${s.color}"></span>${esc(s.label)}<span class="v">${s.value}<small class="muted"> (${Math.round((s.value / total) * 100)}%)</small></span></li>`).join('')}</ul>
  </div>`;
}

function rarityDonut(titles, centerLabel = '曲') {
  const counts = new Map();
  for (const t of titles) inc(counts, rarityOf(t));
  const keys = Object.keys(RARITY).sort((a, b) => RARITY[a].order - RARITY[b].order);
  return donutChart(keys.filter((k) => counts.get(k)).map((k) => ({ label: RARITY[k].label, value: counts.get(k), color: RARITY[k].color })), centerLabel);
}

function rarityExplain() {
  const keys = ['UR', 'SSR', 'SR', 'RR', 'R', 'UC', 'C', 'NEVER', 'COVER'];
  return `<details class="explain">
    <summary>💎 レアリティの判定基準</summary>
    <table class="rarity-table">${keys.map((k) => `<tr><td>${badge(k)}</td><td>${esc(RARITY[k].desc)}</td></tr>`).join('')}</table>
    <p class="note">披露率は「ツアーの規模（同じライブ名の公演数）」で重み付けしています。例えば 20 公演のツアーで 10 公演披露 → そのツアーは 0.5 回分として数え、対象期間のツアー数で割ります。</p>
  </details>`;
}

/* ================================================================
 * 共通部品
 * ================================================================ */
function liveRow(l, { showMine = true } = {}) {
  const [y, m, d] = l.date.split('/');
  const future = isUpcoming(l);
  const days = daysUntil(l.date);
  const tags = [];
  if (future && days === 0) tags.push('<span class="tag today">本日</span>');
  else if (future && days > 0) tags.push(`<span class="tag">あと${days}日</span>`);
  tags.push(`<span class="tag">${esc(LIVE_TYPES[l.type] || '')}</span>`);
  if (!future && !l.hasSetlist) tags.push('<span class="tag">セトリ未登録</span>');
  if (showMine && S.my.has(l.id)) tags.push(`<span class="tag go">${future ? '参戦予定' : '参戦済'}</span>`);
  return `<li><a class="row" href="#/live/${l.id}">
    <div class="datebox${future ? ' future' : ''}"><div class="y">${y}</div><div class="md">${+m}/${+d}</div></div>
    <div class="main">
      <div class="title">${esc(l.name)}</div>
      <div class="meta">${esc(l.venue)}</div>
      <div>${tags.join('')}</div>
    </div>
  </a></li>`;
}

function songRow(t, { side = '', heard = null } = {}) {
  const st = S.stats.get(t);
  const meta = st && st.count
    ? `直近2年 ${pct(st.rate2y)} ・ 最終 ${st.last}`
    : (S.songByTitle.has(t) ? 'ライブ披露記録なし' : 'カバー・未収録曲');
  return `<li><a class="row" href="${songHref(t)}">
    <div>${badge(rarityOf(t))}</div>
    <div class="main"><div class="title">${heard ? '<span class="check">✓</span> ' : ''}${esc(t)}</div><div class="meta">${meta}</div></div>
    <div class="side">${side}</div>
  </a></li>`;
}

function pageHead(title, sub = '', right = '') {
  return `<div class="page-head"><div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${right}</div>`;
}

/* ================================================================
 * 画面: ホーム
 * ================================================================ */
function renderHome() {
  const pastLives = S.lives.filter(isPast);
  const upcoming = S.lives.filter(isUpcoming).sort((a, b) => (a.date > b.date ? 1 : -1));
  const myUpcoming = upcoming.filter((l) => S.my.has(l.id));
  const { map: heard, attended } = heardSongs();
  const officialHeard = [...heard.keys()].filter((t) => S.songByTitle.has(t));
  const comp = S.songs.length ? (officialHeard.length / S.songs.length) * 100 : 0;

  let hero = '';
  const next = myUpcoming[0] || upcoming[0];
  if (next) {
    const days = daysUntil(next.date);
    hero = `<section class="card next-live">
      <div class="kicker">${myUpcoming[0] ? '🎫 あなたの次の参戦' : '📅 次のライブ'}</div>
      <div class="countdown">${days === 0 ? '本日！' : `あと ${days}<small> 日</small>`}</div>
      <div class="nm">${esc(next.name)}</div>
      <div class="vn">${esc(withWeekday(next.date))} ・ ${esc(next.venue)}</div>
      <div class="btn-row" style="margin-top:10px">
        <a class="btn small" href="#/live/${next.id}">詳細</a>
        <a class="btn small" href="#/lives?tab=upcoming">開催予定 ${upcoming.length} 件</a>
      </div>
    </section>`;
  }

  const stats = `<section class="stats">
    <div class="stat"><div class="label">記録されている公演</div><div class="value">${pastLives.length}<small>公演</small></div><div class="sub">セトリあり ${pastLives.filter((l) => l.hasSetlist).length}</div></div>
    <div class="stat"><div class="label">あなたの参戦数</div><div class="value">${attended.length}<small>公演</small></div><div class="sub">参戦予定 ${myUpcoming.length}</div></div>
    <div class="stat"><div class="label">楽曲コンプリート率</div><div class="value">${comp.toFixed(1)}<small>%</small></div><div class="progress"><i style="width:${comp}%"></i></div></div>
    <div class="stat"><div class="label">現地で聴いた曲</div><div class="value">${officialHeard.length}<small>/ ${S.songs.length}曲</small></div><div class="sub">カバー等 ${heard.size - officialHeard.length} 曲</div></div>
  </section>`;

  let body;
  if (!attended.length) {
    body = `<section class="card">
      <h2>🎫 参戦記録をつけてみよう</h2>
      <p class="small muted">参戦したライブを登録すると、現地で聴いた曲・コンプリート率・レアリティ構成などがここに表示されます。</p>
      <a class="btn primary" href="#/my">参戦記録を追加する</a>
    </section>`;
  } else {
    const byYear = new Map();
    for (const l of attended) inc(byYear, l.date.slice(0, 4));
    const y0 = Math.min(...[...byYear.keys()].map(Number));
    const y1 = Math.max(Number(S.today.slice(0, 4)), ...[...byYear.keys()].map(Number));
    const yearItems = [];
    for (let y = y0; y <= y1; y++) yearItems.push({ label: String(y), value: byYear.get(String(y)) || 0 });
    const top = [...heard.values()].sort((a, b) => b.count - a.count || collator.compare(a.title, b.title)).slice(0, 5);
    body = `<div class="grid2">
      <section class="card"><h2>📊 年別参戦回数</h2>${vbarChart(yearItems)}</section>
      <section class="card"><h2>🎧 現地でよく聴いた曲 Top5</h2>${hbarChart(top.map((h) => ({ label: h.title, value: h.count })), (i) => songHref(i.label))}</section>
    </div>
    <section class="card"><h2>💎 回収済み楽曲のレアリティ構成</h2>${rarityDonut(officialHeard)}<p class="note">※公式リリース楽曲のみを集計しています。</p></section>`;
  }

  const recent = pastLives.filter((l) => l.hasSetlist).slice(0, 5);
  const recentCard = `<section class="card flush">
    <div class="card-head" style="padding:14px 14px 0"><h2>🕰️ 最近のライブ</h2><a class="small" href="#/lives">すべて見る →</a></div>
    <ul class="list">${recent.map((l) => liveRow(l)).join('')}</ul>
  </section>`;

  return pageHead('ダッシュボード', 'ライブ記録とあなたの参戦状況のサマリー') + hero + stats + body + recentCard + dataFooter();
}

function dataFooter() {
  const g = S.data.generatedAt ? new Date(S.data.generatedAt) : null;
  return `<p class="note center">データ最終更新: ${g ? esc(g.toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' })) : '不明'}（LiveFans から毎日自動更新）</p>`;
}

/* ================================================================
 * 画面: ライブ一覧
 * ================================================================ */
function filteredLives() {
  const u = S.ui;
  const q = normalize(u.livesQuery);
  let list = S.lives.filter(u.livesTab === 'upcoming' ? isUpcoming : isPast);
  if (u.livesType !== 'all') list = list.filter((l) => l.type === u.livesType);
  if (u.livesYear !== 'all' && u.livesTab === 'past') list = list.filter((l) => l.date.startsWith(u.livesYear));
  if (u.livesMine) list = list.filter((l) => S.my.has(l.id));
  if (q) list = list.filter((l) => normalize(l.name + l.venue + l.date).includes(q));
  if (u.livesTab === 'upcoming') list = [...list].sort((a, b) => (a.date > b.date ? 1 : -1));
  return list;
}

function renderLivesList() {
  const list = filteredLives();
  const shown = list.slice(0, S.ui.livesLimit);
  let html = '';
  let group = '';
  for (const l of shown) {
    const g = S.ui.livesTab === 'upcoming' ? l.date.slice(0, 7).replace('/', '年') + '月' : l.date.slice(0, 4) + '年';
    if (g !== group) { html += `<li class="list-group-title">${g}</li>`; group = g; }
    html += liveRow(l);
  }
  const box = $('#lives-list');
  if (!box) return;
  box.innerHTML = list.length
    ? `<ul class="list">${html}</ul>${list.length > shown.length ? `<button class="more" data-act="lives-more">さらに表示（残り ${list.length - shown.length} 件）</button>` : ''}`
    : `<p class="empty">${S.ui.livesTab === 'upcoming' ? '登録されている開催予定のライブはありません。' : '該当するライブがありません。'}</p>`;
  $('#lives-count').textContent = `${list.length} 件`;
}

function renderLives(params) {
  const u = S.ui;
  if (params.get('tab')) {
    u.livesTab = params.get('tab') === 'upcoming' ? 'upcoming' : 'past';
    history.replaceState(null, '', '#/lives');
  }
  const nUp = S.lives.filter(isUpcoming).length;
  const nPast = S.lives.length - nUp;
  const years = [...new Set(S.lives.filter(isPast).map((l) => l.date.slice(0, 4)))].sort().reverse();
  const typeChips = [['all', 'すべて'], ...Object.entries(LIVE_TYPES)];

  setTimeout(renderLivesList);
  return pageHead('ライブ・フェス', 'LiveFans から取得した開催予定と過去の公演')
    + `<div class="seg" role="tablist">
        <button class="${u.livesTab === 'upcoming' ? 'on' : ''}" data-act="lives-tab" data-v="upcoming">開催予定 (${nUp})</button>
        <button class="${u.livesTab === 'past' ? 'on' : ''}" data-act="lives-tab" data-v="past">過去の公演 (${nPast})</button>
      </div>
      <div class="toolbar">
        <div class="search"><input class="input" type="search" id="lives-q" placeholder="ライブ名・会場・日付で検索" value="${esc(u.livesQuery)}"></div>
        ${u.livesTab === 'past' ? `<select class="input" id="lives-year" aria-label="年">
          <option value="all">全年</option>${years.map((y) => `<option value="${y}" ${u.livesYear === y ? 'selected' : ''}>${y}年</option>`).join('')}
        </select>` : ''}
      </div>
      <div class="chips">
        ${typeChips.map(([k, v]) => `<button class="chip ${u.livesType === k ? 'on' : ''}" data-act="lives-type" data-v="${k}">${v}</button>`).join('')}
        <button class="chip ${u.livesMine ? 'on' : ''}" data-act="lives-mine">🎫 参戦のみ</button>
      </div>
      <p class="small muted" id="lives-count"></p>
      <section class="card flush" id="lives-list"></section>`
    + dataFooter();
}

/* ================================================================
 * 画面: ライブ詳細（セットリスト）
 * ================================================================ */
function renderLive(id) {
  const l = S.liveById.get(id);
  if (!l) return notFound('ライブが見つかりませんでした');
  const sl = S.data.setlists[l.id] || [];
  const mine = S.my.has(l.id);
  const future = isUpcoming(l);
  const { map: heard } = heardSongs();
  const days = daysUntil(l.date);

  const sameTour = S.lives.filter((x) => x.name === l.name).sort((a, b) => (a.date > b.date ? 1 : -1));
  const idx = sameTour.findIndex((x) => x.id === l.id);

  let setlistHtml;
  if (sl.length) {
    setlistHtml = `<section class="card flush">
      <div class="card-head" style="padding:14px 14px 0"><h2>📝 セットリスト（${sl.length}曲）</h2></div>
      <ol class="setlist">${sl.map((t, i) => {
        const h = heard.get(t);
        const isNew = mine && h && h.firstLive.id === l.id;
        return `<li><a href="${songHref(t)}"><span class="no">${i + 1}</span>${badge(rarityOf(t))}<span class="name">${esc(t)}</span>${isNew ? '<span class="tag go">初回収</span>' : ''}</a></li>`;
      }).join('')}</ol>
    </section>
    <section class="card"><h2>📊 このライブのレアリティ構成</h2>${rarityDonut(sl)}<div style="margin-top:12px">${rarityExplain()}</div></section>`;
  } else {
    setlistHtml = `<section class="card"><p class="empty">${future
      ? 'まだ開催前のライブです。開催後、LiveFans にセトリが登録されると自動で反映されます。'
      : 'セットリストが未登録です。LiveFans に登録されると毎日の自動更新で反映されます。'}</p></section>`;
  }

  const tourCard = sameTour.length > 1 ? `<section class="card flush">
    <div class="card-head" style="padding:14px 14px 0"><h2>🗺️ 同じツアー・イベントの公演（${sameTour.length}公演）</h2></div>
    <ul class="list">${sameTour.map((x) => x.id === l.id
      ? `<li><div class="row" style="background:var(--accent-weak)"><div class="main"><div class="title">▶ ${esc(x.date)} ${esc(x.venue)}</div><div class="meta">この公演</div></div></div></li>`
      : liveRow(x)).join('')}</ul>
  </section>` : '';

  return `<a class="back" href="#/lives" data-act="back">← 戻る</a>
    <section class="card detail-head">
      <div class="date">${esc(withWeekday(l.date))}${future ? (days === 0 ? ' ・ 本日開催' : ` ・ あと${days}日`) : ''}</div>
      <h1>${esc(l.name)}</h1>
      <div class="muted">📍 ${esc(l.venue)}</div>
      <div style="margin:8px 0 12px"><span class="tag">${esc(LIVE_TYPES[l.type] || '')}</span>${sameTour.length > 1 ? `<span class="tag">${idx + 1} / ${sameTour.length} 公演目</span>` : ''}</div>
      <div class="btn-row">
        <button class="btn ${mine ? 'attended' : 'primary'}" data-act="toggle-attend" data-id="${l.id}">${mine ? (future ? '✓ 参戦予定' : '✓ 参戦済み') : (future ? '🎫 参戦予定に追加' : '🎫 参戦した！')}</button>
        <a class="btn" href="${esc(l.url)}" target="_blank" rel="noopener">LiveFans で見る ↗</a>
      </div>
    </section>
    ${setlistHtml}
    ${tourCard}`;
}

/* ================================================================
 * 画面: 楽曲一覧
 * ================================================================ */
const SONG_SORTS = {
  rarity: ['レア度順', (a, b) => RARITY[a.rarity].order - RARITY[b.rarity].order || a.rate2y - b.rate2y || collator.compare(a.title, b.title)],
  count: ['披露回数順', (a, b) => b.count - a.count || collator.compare(a.title, b.title)],
  rate2y: ['直近2年披露率順', (a, b) => b.rate2y - a.rate2y || b.count - a.count],
  last: ['最終披露日が古い順', (a, b) => (a.last || '0').localeCompare(b.last || '0') || collator.compare(a.title, b.title)],
  release: ['リリースが新しい順', (a, b) => (S.songByTitle.get(b.title)?.release || '').localeCompare(S.songByTitle.get(a.title)?.release || '')],
  name: ['五十音順', (a, b) => collator.compare(a.title, b.title)],
};

function renderSongsList() {
  const u = S.ui;
  const q = normalize(u.songsQuery);
  const { map: heard } = heardSongs();
  let list = S.songs.map((s) => S.stats.get(s.title));
  if (u.songsRarity !== 'all') list = list.filter((s) => s.rarity === u.songsRarity);
  if (u.songsHeard === 'yes') list = list.filter((s) => heard.has(s.title));
  if (u.songsHeard === 'no') list = list.filter((s) => !heard.has(s.title));
  if (q) list = list.filter((s) => normalize(s.title + (S.songByTitle.get(s.title)?.album || '')).includes(q));
  list.sort(SONG_SORTS[u.songsSort][1]);
  const sideOf = (s) => (u.songsSort === 'release' ? `<small>${esc(S.songByTitle.get(s.title)?.release || '')}</small>` : `<b>${s.count}</b> 回`);
  $('#songs-list').innerHTML = list.length
    ? `<ul class="list">${list.map((s) => songRow(s.title, { side: sideOf(s), heard: heard.has(s.title) })).join('')}</ul>`
    : '<p class="empty">該当する曲がありません。</p>';
  $('#songs-count').textContent = `${list.length} 曲`;
}

function renderSongs() {
  const u = S.ui;
  const counts = new Map();
  for (const s of S.songs) inc(counts, S.stats.get(s.title).rarity);
  const covers = [...S.stats.values()].filter((s) => !s.official).sort((a, b) => b.count - a.count || collator.compare(a.title, b.title));
  setTimeout(renderSongsList);
  return pageHead('楽曲一覧＆レアリティ', `公式リリース曲 ${S.songs.length} 曲の披露回数・披露率・レア度`)
    + `<div class="toolbar">
        <div class="search"><input class="input" type="search" id="songs-q" placeholder="曲名・アルバム名で検索" value="${esc(u.songsQuery)}"></div>
        <select class="input" id="songs-sort" aria-label="並び順">${Object.entries(SONG_SORTS).map(([k, [label]]) => `<option value="${k}" ${u.songsSort === k ? 'selected' : ''}>${label}</option>`).join('')}</select>
      </div>
      <div class="chips">
        <button class="chip ${u.songsRarity === 'all' ? 'on' : ''}" data-act="songs-rarity" data-v="all">すべて</button>
        ${[...RARITY_KEYS, 'NEVER'].filter((k) => counts.get(k)).map((k) => `<button class="chip ${u.songsRarity === k ? 'on' : ''}" data-act="songs-rarity" data-v="${k}">${RARITY[k].label} ${counts.get(k)}</button>`).join('')}
      </div>
      <div class="seg">
        <button class="${u.songsHeard === 'all' ? 'on' : ''}" data-act="songs-heard" data-v="all">すべて</button>
        <button class="${u.songsHeard === 'yes' ? 'on' : ''}" data-act="songs-heard" data-v="yes">✓ 回収済</button>
        <button class="${u.songsHeard === 'no' ? 'on' : ''}" data-act="songs-heard" data-v="no">未回収</button>
      </div>
      <p class="small muted" id="songs-count"></p>
      <section class="card flush" id="songs-list"></section>
      <section class="card">${rarityExplain()}</section>
      <section class="card">
        <details class="explain"><summary>🎤 公式曲リスト外でセトリに登場した曲（${covers.length}曲）</summary>
          <ul class="list">${covers.map((s) => songRow(s.title, { side: `<b>${s.count}</b> 回` })).join('')}</ul>
          <p class="note">新曲がここに出ている場合は <code>data/SongList.csv</code> に追加すると公式曲として集計されます。</p>
        </details>
      </section>`;
}

/* ================================================================
 * 画面: 楽曲詳細（逆引き）
 * ================================================================ */
function renderSong(title) {
  const st = S.stats.get(title);
  if (!st) return notFound('曲が見つかりませんでした');
  const info = S.songByTitle.get(title);
  const { map: heard } = heardSongs();
  const h = heard.get(title);

  let chart = '';
  if (st.count) {
    const byYear = new Map();
    for (const l of st.lives) inc(byYear, l.date.slice(0, 4));
    const startY = Math.min(Number(st.first.slice(0, 4)), info?.release ? Number(info.release.slice(0, 4)) : 9999);
    const items = [];
    for (let y = startY; y <= Number(S.today.slice(0, 4)); y++) items.push({ label: String(y), value: byYear.get(String(y)) || 0 });
    chart = `<section class="card"><h2>📈 年ごとの披露回数</h2>${vbarChart(items)}</section>`;
  }

  return `<a class="back" href="#/songs" data-act="back">← 戻る</a>
    <section class="card detail-head">
      <div>${badge(st.rarity)} ${h ? `<span class="tag go">✓ 回収済（${h.count}回）</span>` : '<span class="tag">未回収</span>'}</div>
      <h1 style="margin-top:6px">${esc(title)}</h1>
      <div class="muted small">${info ? `${info.release ? `💿 ${esc(info.release)} リリース` : ''}${info.album ? ` ・ ${esc(info.album)}` : ''}` : 'カバー曲・未収録曲など（公式曲リスト外）'}</div>
      <dl class="kv" style="margin-top:12px">
        <div><dt>披露回数</dt><dd>${st.count} 回</dd></div>
        <div><dt>直近2年披露率</dt><dd>${pct(st.rate2y)}</dd></div>
        <div><dt>全期間披露率</dt><dd>${pct(st.rateAll)}</dd></div>
        <div><dt>初披露</dt><dd>${esc(st.first || '—')}</dd></div>
        <div><dt>最終披露</dt><dd>${esc(st.last || '—')}</dd></div>
        <div><dt>あなたが聴いた回数</dt><dd>${h ? h.count : 0} 回</dd></div>
      </dl>
      ${h ? `<p class="note">初回収: <a href="#/live/${h.firstLive.id}">${esc(h.firstLive.date)} ${esc(h.firstLive.name)}</a></p>` : ''}
    </section>
    ${chart}
    <section class="card flush">
      <div class="card-head" style="padding:14px 14px 0"><h2>🎸 演奏されたライブ（${st.count}公演）</h2></div>
      ${st.count ? `<ul class="list">${st.lives.map((l) => liveRow(l)).join('')}</ul>` : '<p class="empty">ライブでの披露記録はまだありません。</p>'}
    </section>
    <section class="card">${rarityExplain()}</section>`;
}

/* ================================================================
 * 画面: マイ参戦記録
 * ================================================================ */
function renderMy() {
  const mine = myLivesSorted();
  const upcoming = mine.filter(isUpcoming).reverse();
  const past = mine.filter(isPast);
  const { map: heard } = heardSongs();
  const officialHeard = [...heard.keys()].filter((t) => S.songByTitle.has(t));
  const comp = S.songs.length ? (officialHeard.length / S.songs.length) * 100 : 0;
  const sort = S.ui.myHeardSort;

  const heardList = [...heard.values()];
  if (sort === 'count') heardList.sort((a, b) => b.count - a.count || collator.compare(a.title, b.title));
  else if (sort === 'rarity') heardList.sort((a, b) => RARITY[rarityOf(a.title)].order - RARITY[rarityOf(b.title)].order || collator.compare(a.title, b.title));
  else heardList.sort((a, b) => collator.compare(a.title, b.title));

  const unheard = S.songs.map((s) => S.stats.get(s.title)).filter((s) => !heard.has(s.title))
    .sort((a, b) => b.rate2y - a.rate2y || collator.compare(a.title, b.title));

  const syncNote = Sync.configured()
    ? '☁️ Google スプレッドシートと同期しています。'
    : '📱 この端末（ブラウザ）に保存しています。<a href="#/settings">設定</a>から Google スプレッドシート同期を有効にすると、他の端末とも共有できます。';

  const delBtn = (l) => `<button class="btn small danger" data-act="remove-attend" data-id="${l.id}" aria-label="削除">削除</button>`;
  const myRow = (l) => liveRow(l, { showMine: false }).replace('</a></li>', `</a><div style="padding:0 14px 10px;text-align:right;margin-top:-6px">${delBtn(l)}</div></li>`);

  return pageHead('マイ参戦記録', '参戦したライブから、現地で聴いた曲を自動でリスト化')
    + `<section class="stats">
      <div class="stat"><div class="label">参戦数</div><div class="value">${past.length}<small>公演</small></div></div>
      <div class="stat"><div class="label">参戦予定</div><div class="value">${upcoming.length}<small>公演</small></div></div>
      <div class="stat"><div class="label">聴いた曲（全体）</div><div class="value">${heard.size}<small>曲</small></div></div>
      <div class="stat"><div class="label">コンプリート率</div><div class="value">${comp.toFixed(1)}<small>%</small></div><div class="progress"><i style="width:${comp}%"></i></div><div class="sub">${officialHeard.length} / ${S.songs.length} 曲</div></div>
    </section>
    <section class="card">
      <h2>➕ 参戦したライブを追加</h2>
      <div class="suggest">
        <div class="search"><input class="input" type="search" id="add-q" placeholder="ライブ名・会場・日付（例: 2025/03、横浜）で検索" autocomplete="off"></div>
        <div class="suggest-list" id="add-suggest" hidden></div>
      </div>
      <p class="note">${syncNote}</p>
    </section>
    <div class="grid2">
      <section class="card flush">
        <div class="card-head" style="padding:14px 14px 0"><h2>📝 参戦一覧（${mine.length}公演）</h2></div>
        ${upcoming.length ? `<div class="list-group-title">参戦予定</div><ul class="list">${upcoming.map(myRow).join('')}</ul>` : ''}
        ${past.length ? `<div class="list-group-title">参戦済み</div><ul class="list">${past.map(myRow).join('')}</ul>` : ''}
        ${!mine.length ? '<p class="empty">まだ登録されていません。上の検索から追加してください。</p>' : ''}
        ${S.myExtra.length ? `<div class="list-group-title">⚠️ ライブ一覧と照合できなかった記録</div><ul class="list">${S.myExtra.map((x, i) => `<li><div class="row"><div class="main"><div class="title">${esc(x['表示名'] || x['ライブ情報'])}</div><div class="meta">LiveFans 側で公演情報が変わった可能性があります</div></div><button class="btn small danger" data-act="remove-extra" data-i="${i}">削除</button></div></li>`).join('')}</ul>` : ''}
      </section>
      <section class="card flush">
        <div class="card-head" style="padding:14px 14px 0"><h2>🎧 現地で聴いた曲（${heard.size}曲）</h2></div>
        <div style="padding:0 14px"><div class="seg">
          <button class="${sort === 'count' ? 'on' : ''}" data-act="my-sort" data-v="count">回数順</button>
          <button class="${sort === 'rarity' ? 'on' : ''}" data-act="my-sort" data-v="rarity">レア度順</button>
          <button class="${sort === 'name' ? 'on' : ''}" data-act="my-sort" data-v="name">五十音順</button>
        </div></div>
        ${heardList.length ? `<ul class="list">${heardList.map((h) => songRow(h.title, { side: `<b>×${h.count}</b>` })).join('')}</ul>` : '<p class="empty">参戦済みのライブを追加すると、ここに一覧表示されます。</p>'}
      </section>
    </div>
    <section class="card flush">
      <div class="card-head" style="padding:14px 14px 0"><h2>🎯 まだ聴いていない曲（${unheard.length}曲）</h2></div>
      <p class="small muted" style="padding:0 14px;margin:0 0 6px">直近2年の披露率が高い＝次のライブで聴ける可能性が高い順</p>
      ${unheard.length ? `<ul class="list">${unheard.map((s) => songRow(s.title, { side: `<b>${pct(s.rate2y)}</b>` })).join('')}</ul>` : '<p class="empty">🎉 全曲コンプリート！</p>'}
    </section>`;
}

function updateSuggest() {
  const input = $('#add-q');
  const box = $('#add-suggest');
  if (!input || !box) return;
  const q = normalize(input.value);
  if (!q) { box.hidden = true; return; }
  const hits = S.lives.filter((l) => normalize(displayName(l)).includes(q)).slice(0, 30);
  box.hidden = false;
  box.innerHTML = hits.length
    ? hits.map((l) => `<button data-act="add-attend" data-id="${l.id}">
        <div><b>${esc(l.date)}</b> ${esc(l.name)} ${S.my.has(l.id) ? '<span class="tag go">登録済</span>' : ''}${isUpcoming(l) ? '<span class="tag">開催予定</span>' : ''}</div>
        <div class="meta">${esc(l.venue)}</div></button>`).join('')
    : '<p class="empty">見つかりませんでした</p>';
}

/* ================================================================
 * 画面: AI アシスタント（Google Gemini）
 * ================================================================ */
let chatHistory = (() => { try { return JSON.parse(sessionStorage.getItem(LS.chat)) || []; } catch { return []; } })();
let chatBusy = false;
const saveChat = () => { try { sessionStorage.setItem(LS.chat, JSON.stringify(chatHistory.slice(-30))); } catch { /* ignore */ } };

const AI_PRESETS = [
  ['🔮 次回のセトリ予想', '過去のデータ（特に直近のツアーのセトリと各曲の披露率・最近のリリース）をもとに、次のツアー初日のセットリスト（15〜20曲程度）を予想してください。曲順・選曲の理由・盛り上がりポイントも、ワクワクするトーンで解説してください。'],
  ['🎯 未回収曲で聴けそうな曲', '私がまだ現地で聴いたことのない曲のうち、次に参戦するライブで聴ける可能性が高そうな曲を理由付きで5曲挙げてください。'],
  ['📈 最近のセトリ傾向', '直近のツアー・イベントのセットリストの傾向（定番曲、入れ替わり枠、オープニングやアンコールのパターンなど）を分析してください。'],
  ['💎 激レア曲の解説', 'レア度が UR・SSR の曲について、どんな曲で、なぜ最近披露されていないと考えられるかを紹介してください。'],
];

function buildAIContext() {
  const { map: heard, attended } = heardSongs();
  const upcoming = S.lives.filter(isUpcoming).sort((a, b) => (a.date > b.date ? 1 : -1)).slice(0, 12);
  const pastWithSl = S.lives.filter((l) => isPast(l) && l.hasSetlist);
  const tours = [];
  const seen = new Set();
  for (const l of pastWithSl) {
    if (seen.has(l.name)) continue;
    seen.add(l.name);
    const shows = pastWithSl.filter((x) => x.name === l.name);
    tours.push({ l, shows: shows.length });
    if (tours.length >= 6) break;
  }
  const songLines = S.songs.map((s) => {
    const st = S.stats.get(s.title);
    return `${s.title} | ${s.release} | ${RARITY[st.rarity].label} | ${pct(st.rate2y)} | ${st.count} | ${st.last || '-'} | ${heard.has(s.title) ? '済' : '未'}`;
  });
  return [
    'あなたは日本のバンド「緑黄色社会（リョクシャカ）」の楽曲とライブに精通した、熱心なファン仲間のAIアシスタントです。',
    '以下のデータ（LiveFans のライブ・セットリスト記録をもとに集計）を根拠として活用し、日本語で答えてください。データにない事実は推測であることを明示してください。',
    `今日の日付: ${S.today}`,
    '',
    '## 開催予定のライブ',
    upcoming.length ? upcoming.map((l) => `- ${l.date} ${l.name} @ ${l.venue}`).join('\n') : '（登録なし）',
    '',
    '## 直近のツアー・イベントのセットリスト（各ツアーの最新公演）',
    ...tours.map(({ l, shows }) => `### ${l.date} ${l.name} @ ${l.venue}（このツアー/イベント ${shows} 公演）\n${(S.data.setlists[l.id] || []).map((t, i) => `${i + 1}. ${t}`).join('\n')}`),
    '',
    '## 公式楽曲の統計（曲名 | リリース日 | レア度 | 直近2年披露率 | 通算披露回数 | 最終披露日 | ユーザーが現地で聴いたか）',
    'レア度: UR=最終披露4年以上前, SSR=2年以上前, SR=直近2年披露率4%以下, RR=8%以下, R=30%以下, UC=50%以下, C=定番, 未披露=披露記録なし',
    ...songLines,
    '',
    `## ユーザーの参戦状況: 参戦 ${attended.length} 公演、聴いた公式曲 ${[...heard.keys()].filter((t) => S.songByTitle.has(t)).length} / ${S.songs.length} 曲`,
  ].join('\n');
}

async function askGemini() {
  const key = S.settings.geminiKey;
  const model = (S.settings.geminiModel || DEFAULT_MODEL).trim();
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: buildAIContext() }] },
      contents: chatHistory.filter((m) => m.role !== 'error').map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
  const cand = json.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) throw new Error(`回答が空でした（${cand?.finishReason || json.promptFeedback?.blockReason || '理由不明'}）`);
  return text;
}

function mdToHtml(src) {
  const inline = (s) => s
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of esc(src).split('\n')) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^#{1,6}\s+(.*)$/))) { close(); out.push(`<h4>${inline(m[1])}</h4>`); }
    else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (!line.trim()) { close(); }
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close();
  return out.join('');
}

function renderChat() {
  const box = $('#chat');
  if (!box) return;
  box.innerHTML = chatHistory.length
    ? chatHistory.map((m) => m.role === 'user'
      ? `<div class="msg user">${esc(m.text)}</div>`
      : m.role === 'error' ? `<div class="msg err">⚠️ ${esc(m.text)}</div>` : `<div class="msg model">${mdToHtml(m.text)}</div>`).join('')
      + (chatBusy ? '<div class="msg model"><span class="typing"><i></i><i></i><i></i></span></div>' : '')
    : '<p class="empty">上のボタンを押すか、下の入力欄から自由に質問してください。<br>ライブ・セトリ・楽曲の統計データを AI に渡して回答させます。</p>';
  const send = $('#chat-send');
  if (send) send.disabled = chatBusy;
}

async function sendChat(text) {
  text = (text || '').trim();
  if (!text || chatBusy) return;
  if (!S.settings.geminiKey) { toast('先に Gemini API キーを設定してください'); return; }
  chatHistory = chatHistory.filter((m) => m.role !== 'error');
  chatHistory.push({ role: 'user', text });
  chatBusy = true;
  renderChat();
  try {
    const answer = await askGemini();
    chatHistory.push({ role: 'model', text: answer });
  } catch (e) {
    chatHistory.pop();
    chatHistory.push({ role: 'user', text }, { role: 'error', text: `エラーが発生しました: ${e.message}` });
  } finally {
    chatBusy = false;
    saveChat();
    renderChat();
    const last = $('#chat')?.lastElementChild;
    if (last && location.hash.startsWith('#/ai')) last.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function renderAI() {
  const hasKey = !!S.settings.geminiKey;
  setTimeout(renderChat);
  return pageHead('AI アシスタント', 'Google Gemini がこのアプリのデータを元にセトリ予想や質問に答えます',
    chatHistory.length ? '<button class="btn small" data-act="chat-clear">会話をリセット</button>' : '')
    + (hasKey ? '' : `<section class="card">
        <h2>🔑 Gemini API キーを設定してください</h2>
        <p class="small muted">Google AI Studio で無料の API キーを取得できます。キーはこの端末のブラウザ内にのみ保存されます。</p>
        <div class="btn-row"><input class="input" type="password" id="ai-key-inline" placeholder="API キーを貼り付け" style="flex:1"><button class="btn primary" data-act="save-key-inline">保存</button></div>
        <p class="note"><a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">API キーを取得する ↗</a></p>
      </section>`)
    + `<section class="card">
        <div class="chips" style="flex-wrap:wrap">${AI_PRESETS.map(([label], i) => `<button class="chip" data-act="ai-preset" data-i="${i}">${label}</button>`).join('')}</div>
        <div class="chat" id="chat"></div>
        <form class="chat-input" id="chat-form">
          <textarea class="input" id="chat-text" placeholder="例: 2026年のアリーナツアーで披露された曲の傾向は？" rows="1"></textarea>
          <button class="btn primary" id="chat-send" type="submit">送信</button>
        </form>
      </section>`;
}

/* ================================================================
 * 画面: 設定
 * ================================================================ */
function renderSettings() {
  const st = S.settings;
  const g = S.data.generatedAt ? new Date(S.data.generatedAt).toLocaleString('ja-JP') : '不明';
  return pageHead('設定')
    + `<section class="card">
        <h2>🔄 データ</h2>
        <p class="small">最終更新: <b>${esc(g)}</b><br>公演 ${S.lives.length} 件 ・ セトリ ${Object.keys(S.data.setlists).length} 件 ・ 公式楽曲 ${S.songs.length} 曲</p>
        <p class="small muted">ライブ情報とセットリストは GitHub Actions が毎日自動で LiveFans から取得し、このアプリに反映します。すぐに更新したいときは下のボタンから「Run workflow」を実行してください（数分で反映）。</p>
        <div class="btn-row"><a class="btn" href="${WORKFLOW_URL}" target="_blank" rel="noopener">今すぐ更新する（GitHub）↗</a><button class="btn" data-act="reload-data">アプリを再読み込み</button></div>
      </section>

      <section class="card">
        <h2>☁️ Google スプレッドシート同期（マイ参戦記録）</h2>
        <p class="small muted">設定すると参戦記録がスプレッドシートに保存され、スマホと PC など複数の端末で共有できます。未設定の場合はこの端末内にのみ保存されます。</p>
        <details class="explain" style="margin-bottom:12px"><summary>設定方法</summary>
          <ol class="steps">
            <li>参戦記録用の Google スプレッドシートを開き、メニューの「拡張機能 → Apps Script」を開く</li>
            <li>リポジトリの <a href="${REPO_URL}/blob/main/gas/Code.gs" target="_blank" rel="noopener"><code>gas/Code.gs</code></a> の中身を貼り付け、<code>TOKEN</code> を好きな合言葉に変更して保存</li>
            <li>「デプロイ → 新しいデプロイ → 種類: ウェブアプリ」、実行ユーザー「自分」、アクセス「全員」でデプロイ</li>
            <li>表示されたウェブアプリの URL と合言葉を下に入力して「保存して同期」</li>
          </ol>
        </details>
        <label class="field"><span>ウェブアプリ URL</span><input class="input" id="gas-url" placeholder="https://script.google.com/macros/s/.../exec" value="${esc(st.gasUrl || '')}"></label>
        <label class="field"><span>合言葉（TOKEN）</span><input class="input" id="gas-token" type="password" value="${esc(st.gasToken || '')}"></label>
        <div class="btn-row">
          <button class="btn primary" data-act="save-sync">保存して同期</button>
          ${Sync.configured() ? '<button class="btn" data-act="sync-pull">スプレッドシートから読み込む</button><button class="btn" data-act="sync-push">この端末の記録で上書き保存</button><button class="btn danger" data-act="sync-off">同期を解除</button>' : ''}
        </div>
      </section>

      <section class="card">
        <h2>🤖 AI アシスタント（Google Gemini）</h2>
        <label class="field"><span>API キー（この端末にのみ保存）</span><input class="input" id="ai-key" type="password" value="${esc(st.geminiKey || '')}" placeholder="AIza..."></label>
        <label class="field"><span>モデル名</span><input class="input" id="ai-model" value="${esc(st.geminiModel || DEFAULT_MODEL)}" placeholder="${DEFAULT_MODEL}"></label>
        <p class="note">モデル名は <code>gemini-flash-latest</code>（常に最新の Flash）が既定です。エラーになる場合は <code>gemini-2.5-flash</code> などに変更してください。</p>
        <div class="btn-row"><button class="btn primary" data-act="save-ai">保存</button><a class="btn" href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">API キーを取得 ↗</a></div>
      </section>

      <section class="card">
        <h2>💾 バックアップ</h2>
        <p class="small muted">参戦記録を CSV で書き出し・読み込みできます（旧アプリの <code>mylive.csv</code> やスプレッドシートを CSV でダウンロードしたものも読み込めます）。</p>
        <div class="btn-row">
          <button class="btn" data-act="export-csv">CSV で書き出す</button>
          <label class="btn">CSV / JSON を読み込む<input type="file" id="import-file" accept=".csv,.json,text/csv,application/json" hidden></label>
        </div>
      </section>
      ${dataFooter()}`;
}

/* ================================================================
 * インポート / エクスポート
 * ================================================================ */
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim()));
}

const csvCell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function exportCSV() {
  const items = Sync.items();
  const csv = '﻿表示名,ライブ情報\n' + items.map((i) => `${csvCell(i['表示名'])},${csvCell(i['ライブ情報'])}`).join('\n') + '\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `mylive_${S.today.replace(/\//g, '')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importFile(file) {
  const text = await file.text();
  let items = [];
  if (file.name.endsWith('.json')) {
    const j = JSON.parse(text);
    items = Array.isArray(j) ? j : (j.items || []);
    items = items.map((x) => (typeof x === 'string' ? { 表示名: x } : x));
  } else {
    const rows = parseCSV(text);
    const header = rows[0].map((h) => h.trim());
    const iName = header.indexOf('表示名'), iUrl = header.indexOf('ライブ情報');
    const hasHeader = iName >= 0 || iUrl >= 0;
    items = rows.slice(hasHeader ? 1 : 0).map((r) => ({ 表示名: r[hasHeader ? iName : 0] || '', ライブ情報: iUrl >= 0 ? r[iUrl] || '' : '' }));
  }
  let added = 0, unknown = 0;
  for (const it of items) {
    const id = resolveItem(it);
    if (id) { if (!S.my.has(id)) { S.my.add(id); added++; } } else unknown++;
  }
  persistLocal();
  toast(`${added} 件追加しました${unknown ? `（照合できない記録 ${unknown} 件はスキップ）` : ''}`);
  rerender();
}

/* ================================================================
 * ルーター
 * ================================================================ */
const ROUTES = [
  [/^\/?$/, () => renderHome(), 'home'],
  [/^\/lives$/, (m, p) => renderLives(p), 'lives'],
  [/^\/live\/([^/]+)$/, (m) => renderLive(m[1]), 'lives'],
  [/^\/songs$/, () => renderSongs(), 'songs'],
  [/^\/song\/(.+)$/, (m) => renderSong(decodeURIComponent(m[1])), 'songs'],
  [/^\/my$/, () => renderMy(), 'my'],
  [/^\/ai$/, () => renderAI(), 'ai'],
  [/^\/settings$/, () => renderSettings(), null],
];

function notFound(msg) {
  return `<section class="card"><p class="empty">${esc(msg)}</p><p class="center"><a href="#/">ホームへ戻る</a></p></section>`;
}

let currentKey = null;
function render({ keepScroll = false } = {}) {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query] = raw.split('?');
  const params = new URLSearchParams(query || '');
  const view = $('#view');
  if (currentKey && !keepScroll) S.scroll.set(currentKey, window.scrollY);
  const prevScroll = window.scrollY;

  let html = notFound('ページが見つかりませんでした'), tab = null;
  for (const [re, fn, t] of ROUTES) {
    const m = path.match(re);
    if (m) { html = fn(m, params); tab = t; break; }
  }
  view.innerHTML = html;
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));

  const key = path;
  if (keepScroll) window.scrollTo(0, prevScroll);
  else window.scrollTo(0, S.scroll.get(key) || 0);
  currentKey = key;
}

function rerender() { render({ keepScroll: true }); }

/* ================================================================
 * イベント
 * ================================================================ */
const ACTIONS = {
  'toggle-attend': (el) => toggleAttend(el.dataset.id),
  'add-attend': (el) => {
    const id = el.dataset.id;
    if (S.my.has(id)) { toast('既に登録されています'); return; }
    S.my.add(id);
    persistLocal();
    toast('追加しました 🎉');
    rerender();
    $('#add-q')?.focus();
  },
  'remove-attend': (el) => {
    const l = S.liveById.get(el.dataset.id);
    if (!l || !confirm(`「${l.date} ${l.name}」を参戦記録から削除しますか？`)) return;
    S.my.delete(l.id);
    persistLocal();
    toast('削除しました');
    rerender();
  },
  'remove-extra': (el) => {
    S.myExtra.splice(Number(el.dataset.i), 1);
    persistLocal();
    rerender();
  },
  back: (el, ev) => {
    // アプリ内で移動してきた場合はブラウザの「戻る」と同じ動き（一覧の検索条件・スクロール位置を保持）
    if (navDepth > 0) { ev.preventDefault(); history.back(); }
  },
  'lives-tab': (el) => { S.ui.livesTab = el.dataset.v; S.ui.livesLimit = 60; rerender(); },
  'lives-type': (el) => { S.ui.livesType = el.dataset.v; S.ui.livesLimit = 60; rerender(); },
  'lives-mine': () => { S.ui.livesMine = !S.ui.livesMine; rerender(); },
  'lives-more': () => { S.ui.livesLimit += 150; renderLivesList(); },
  'songs-rarity': (el) => { S.ui.songsRarity = el.dataset.v; rerender(); },
  'songs-heard': (el) => { S.ui.songsHeard = el.dataset.v; rerender(); },
  'my-sort': (el) => { S.ui.myHeardSort = el.dataset.v; rerender(); },
  'ai-preset': (el) => sendChat(AI_PRESETS[Number(el.dataset.i)][1]),
  'chat-clear': () => { chatHistory = []; saveChat(); rerender(); },
  'save-key-inline': () => {
    const v = $('#ai-key-inline').value.trim();
    if (!v) return;
    S.settings.geminiKey = v;
    saveJSON(LS.settings, S.settings);
    toast('API キーを保存しました');
    rerender();
  },
  'save-ai': () => {
    S.settings.geminiKey = $('#ai-key').value.trim();
    S.settings.geminiModel = $('#ai-model').value.trim() || DEFAULT_MODEL;
    saveJSON(LS.settings, S.settings);
    toast('保存しました');
  },
  'save-sync': async () => {
    const url = $('#gas-url').value.trim();
    const token = $('#gas-token').value.trim();
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) { toast('Apps Script のウェブアプリ URL を入力してください'); return; }
    if (!token) { toast('合言葉を入力してください'); return; }
    S.settings.gasUrl = url;
    S.settings.gasToken = token;
    saveJSON(LS.settings, S.settings);
    // スプレッドシートが空で端末に記録がある場合はアップロード、それ以外は読み込み
    try {
      Sync.setStatus('busy', '⏳ 同期中');
      const remote = await Sync.request('GET');
      if (!(remote.items || []).length && S.my.size) {
        await Sync.push();
        toast('端末の参戦記録をスプレッドシートに保存しました');
      } else {
        applyRemoteItems(remote.items || []);
        toast(`スプレッドシートから ${S.my.size} 件読み込みました`);
      }
      saveJSON(LS.pending, false);
      Sync.setStatus('ok', '☁️ 同期済み');
    } catch (e) {
      Sync.setStatus('err', '⚠️ 同期エラー');
      toast('接続に失敗しました: ' + e.message);
    }
    rerender();
  },
  'sync-pull': async () => {
    saveJSON(LS.pending, false);
    if (await Sync.syncNow()) rerender();
  },
  'sync-push': async () => {
    if (!confirm('スプレッドシートの内容を、この端末の参戦記録で上書きします。よろしいですか？')) return;
    saveJSON(LS.pending, true);
    if (await Sync.syncNow()) rerender();
  },
  'sync-off': () => {
    if (!confirm('スプレッドシート同期を解除しますか？（参戦記録はこの端末に残ります）')) return;
    delete S.settings.gasUrl;
    delete S.settings.gasToken;
    saveJSON(LS.settings, S.settings);
    saveJSON(LS.pending, false);
    Sync.setStatus('ok', '');
    rerender();
  },
  'export-csv': () => exportCSV(),
  'reload-data': () => location.reload(),
};

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  if (el.tagName === 'BUTTON') ev.preventDefault();
  fn(el, ev);
});

document.addEventListener('input', (ev) => {
  const id = ev.target.id;
  if (id === 'lives-q') { S.ui.livesQuery = ev.target.value; S.ui.livesLimit = 60; renderLivesList(); }
  else if (id === 'songs-q') { S.ui.songsQuery = ev.target.value; renderSongsList(); }
  else if (id === 'add-q') updateSuggest();
});

document.addEventListener('change', (ev) => {
  const id = ev.target.id;
  if (id === 'lives-year') { S.ui.livesYear = ev.target.value; S.ui.livesLimit = 60; renderLivesList(); }
  else if (id === 'songs-sort') { S.ui.songsSort = ev.target.value; renderSongsList(); }
  else if (id === 'import-file' && ev.target.files[0]) {
    importFile(ev.target.files[0]).catch((e) => toast('読み込みに失敗しました: ' + e.message));
    ev.target.value = '';
  }
});

document.addEventListener('submit', (ev) => {
  if (ev.target.id === 'chat-form') {
    ev.preventDefault();
    const ta = $('#chat-text');
    sendChat(ta.value);
    ta.value = '';
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.target.id === 'chat-text' && ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
    ev.preventDefault();
    $('#chat-form').requestSubmit();
  }
});

let navDepth = 0;
window.addEventListener('hashchange', () => { navDepth++; render(); });

// 日付が変わったら（アプリを開きっぱなしにしていた場合など）統計を再計算
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.data && fmtDate(new Date()) !== S.today) {
    indexData(S.data);
    rerender();
  }
});

/* ================================================================
 * 起動
 * ================================================================ */
async function init() {
  S.settings = loadJSON(LS.settings, {});
  let data;
  try {
    // 常に最新のデータを取得（ブラウザキャッシュを使わない）
    const res = await fetch(`data.json?v=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    $('#view').innerHTML = `<section class="card"><h2>データを読み込めませんでした</h2><p class="small muted">${esc(e.message)}</p><button class="btn" onclick="location.reload()">再読み込み</button></section>`;
    return;
  }
  indexData(data);

  const localMy = loadJSON(LS.my, null);
  S.myExtra = loadJSON(LS.extra, []);
  if (localMy) {
    S.my = new Set(localMy.filter((id) => S.liveById.has(id)));
  } else if (!Sync.configured() && !loadJSON(LS.seeded, false) && (data.seedMyLives || []).length) {
    // 初回のみ、リポジトリの data/mylive.csv を初期値として取り込む
    applyRemoteItems(data.seedMyLives.map((n) => ({ 表示名: n })));
    saveJSON(LS.seeded, true);
  }

  render();

  if (Sync.configured()) {
    const before = JSON.stringify([...S.my].sort());
    await Sync.syncNow({ silent: true });
    if (JSON.stringify([...S.my].sort()) !== before) { S.heardCache = null; rerender(); }
  }
}

init();
