"""data/*.csv から Web アプリ用の web/data.json を生成するスクリプト。

使い方:
    python scripts/build_data.py

やっていること:
  * 他アーティストのライブ（LiveFans の検索に混ざるもの）を除外
  * 曲名の表記ゆれ（全角/半角・大文字小文字・空白・data/song_aliases.csv）を正式名に統一
  * TV 音楽番組など「出演者全員の曲」がセトリに入っているイベントから、他アーティストの曲を除外
  * MC / SE などの曲ではない行を除外
  * 同一公演内の重複行を除外
  * ライブの種類（ワンマン / FC / フェス・イベント / TV）を判定
"""

from __future__ import annotations

import csv
import json
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
OUT_PATH = ROOT / "web" / "data.json"

JST = timezone(timedelta(hours=9))

# LiveFans のアーティスト検索に混ざってしまう別アーティストの公演
BAD_ARTISTS = [
    "グッドモーニングアメリカ", "忌野清志郎", "BUMP OF CHICKEN", "石鹸屋", "BLUE ENCOUNT",
    "屋敷豪太", "SAKANAMON", "The California Guitar Trio", "きのこ帝国", "Shing02",
    "凛として時雨", "Arrested Development",
]

# TV・配信の音楽番組（セトリに出演者全員の曲が入っていることが多い）
TV_KEYWORDS = [
    "音楽の日", "CDTV", "COUNT DOWN TV", "MUSIC STATION", "ミュージックステーション", "Mステ",
    "紅白", "FNS", "ベストアーティスト", "テレ東", "ベストヒット歌謡祭", "MUSIC DAY",
    "ミュージックアワード", "ライブ・エール", "SONGS", "バズリズム", "with MUSIC", "うたコン",
    "Venue101", "関ジャム", "EIGHT-JAM", "ミュージックフェア", "LOVE MUSIC", "新しい別の窓",
    "歌謡祭", "音楽祭", "Premium Music", "プレミアMelodiX", "スッキリ", "めざまし",
]

FC_KEYWORDS = ["Fan Club", "FanClub", "ファンクラブ", "livestone"]

# 曲ではない行（MC・SE など）
NON_SONG_PATTERN = re.compile(r"^(-+.*-+|SE|MC.*|\(新曲\)|（新曲）|新曲|.*エンディング.*|オープニング.*)$")

# 「曲名 [アーティスト名]」形式（カバー曲）
COVER_PATTERN = re.compile(r"\s*\[[^\]]+\]\s*$")


def read_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8-sig", newline="") as f:
        return [{k: (v or "").strip() for k, v in row.items() if k} for row in csv.DictReader(f)]


def norm_key(s: str) -> str:
    """表記ゆれ吸収用のキー（NFKC・小文字・空白除去）"""
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", s)).lower()


def event_id(url: str) -> str:
    m = re.search(r"/events/(\d+)", url)
    return m.group(1) if m else url


def classify_live(name: str) -> str:
    if any(k.lower() in name.lower() for k in TV_KEYWORDS):
        return "tv"
    if any(k.lower() in name.lower() for k in FC_KEYWORDS):
        return "fc"
    if name.startswith(("緑黄色", "Ryokuoushoku Shakai")):
        return "oneman"
    return "event"


def normalize_date(s: str) -> str | None:
    m = re.match(r"(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})", s)
    if not m:
        return None
    y, mo, d = (int(x) for x in m.groups())
    return f"{y:04d}/{mo:02d}/{d:02d}"


def build() -> dict:
    songs_raw = read_csv(DATA_DIR / "SongList.csv")
    lives_raw = read_csv(DATA_DIR / "LiveList.csv")
    setlists_raw = read_csv(DATA_DIR / "Setlists.csv")
    aliases_raw = read_csv(DATA_DIR / "song_aliases.csv")
    mylive_raw = read_csv(DATA_DIR / "mylive.csv")

    # --- 楽曲 ---
    songs = []
    canonical: dict[str, str] = {}
    for r in songs_raw:
        title = r.get("曲名", "")
        if not title:
            continue
        songs.append({
            "title": title,
            "release": normalize_date(r.get("リリース日", "")) or "",
            "album": r.get("初収録アルバム名", ""),
        })
        canonical[norm_key(title)] = title
    for r in aliases_raw:
        alias, official = r.get("表記ゆれ", ""), r.get("正式な曲名", "")
        if alias and official:
            canonical[norm_key(alias)] = official

    def resolve_title(raw: str) -> str:
        return canonical.get(norm_key(raw), raw)

    # --- ライブ ---
    lives = []
    seen = set()
    for r in lives_raw:
        url, name = r.get("ライブ情報", ""), r.get("ライブ名", "")
        date = normalize_date(r.get("日付", ""))
        if not url or not name or not date or url in seen:
            continue
        if any(b in name for b in BAD_ARTISTS):
            continue
        seen.add(url)
        lives.append({
            "id": event_id(url),
            "date": date,
            "name": name,
            "venue": r.get("会場", "") or "会場不明",
            "url": url,
            "type": classify_live(name),
        })
    lives.sort(key=lambda x: (x["date"], x["id"]), reverse=True)
    live_by_url = {l["url"]: l for l in lives}

    # --- セットリスト ---
    grouped: dict[str, list[tuple[int, str]]] = {}
    for r in setlists_raw:
        url = r.get("ライブ情報", "")
        if url not in live_by_url:
            continue
        try:
            order = int(float(r.get("演奏順", "0") or 0))
        except ValueError:
            order = 0
        grouped.setdefault(url, []).append((order, r.get("曲名", "")))

    official_titles = {s["title"] for s in songs}
    setlists: dict[str, list[str]] = {}
    filtered_events = []
    for url, rows in grouped.items():
        rows.sort(key=lambda x: x[0])
        titles = []
        for _, raw in rows:
            raw = raw.strip()
            if not raw or NON_SONG_PATTERN.match(raw):
                continue
            t = resolve_title(raw)
            if t not in titles:
                titles.append(t)
        live = live_by_url[url]
        n_official = sum(t in official_titles for t in titles)
        n_other = len(titles) - n_official
        # 出演者全員の曲が並んでいるセトリ → 緑黄色社会の曲だけ残す
        multi_artist = n_other > n_official and (live["type"] == "tv" or len(titles) >= 20)
        if multi_artist:
            filtered_events.append(live["name"])
            titles = [t for t in titles if t in official_titles]
        if titles:
            setlists[live["id"]] = titles

    for l in lives:
        l["hasSetlist"] = l["id"] in setlists

    # --- マイ参戦記録の初期値（mylive.csv） ---
    seed_my_lives = [r.get("表示名", "") for r in mylive_raw if r.get("表示名")]

    return {
        "generatedAt": datetime.now(JST).isoformat(timespec="seconds"),
        "songs": songs,
        "lives": lives,
        "setlists": setlists,
        "seedMyLives": seed_my_lives,
        "stats": {
            "multiArtistFilteredEvents": len(filtered_events),
        },
    }


def main() -> None:
    data = build()
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(
        f"wrote {OUT_PATH.relative_to(ROOT)}: "
        f"{len(data['lives'])} lives, {len(data['setlists'])} setlists, {len(data['songs'])} songs "
        f"(multi-artist setlists cleaned: {data['stats']['multiArtistFilteredEvents']})"
    )


if __name__ == "__main__":
    main()
