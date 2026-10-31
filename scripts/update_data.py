"""LiveFans から最新のライブ情報・セットリストを取得して data/*.csv を更新するスクリプト。

GitHub Actions から毎日自動実行されます（.github/workflows/update-and-deploy.yml）。
手元で実行する場合:
    pip install -r requirements.txt
    python scripts/update_data.py              # 通常の差分更新
    python scripts/update_data.py --full       # 過去ページも全部たどり直す
    python scripts/update_data.py --retry-all  # セトリ未取得の過去公演をすべて再取得

旧アプリからの改善点:
  * 既知の公演に当たった瞬間に取得を打ち切らず、ページ単位で「全部既知」になるまで確認
  * 開催予定の公演は毎回すべて取り直し、日付・会場の変更や中止（掲載削除）を反映
  * 公演後しばらくしてからセトリが登録されるケースに対応（直近の公演は毎回再チェック）
  * タイムアウト・リトライ付きの通信、取得失敗時は既存データを壊さない
"""

from __future__ import annotations

import argparse
import csv
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
CSV_LIVES = DATA_DIR / "LiveList.csv"
CSV_SETLISTS = DATA_DIR / "Setlists.csv"

BASE = "https://www.livefans.jp"
URL_PAST = BASE + "/search/artist/25704/page:{page}?&setlist=1&year=before&sort=e1"
URL_FUTURE = BASE + "/search/artist/25704/page:{page}?&year=after&sort=e2"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept-Language": "ja,en;q=0.8",
}
WAIT_SEC = 1.0           # LiveFans への負荷軽減のための待ち時間
RECHECK_DAYS = 120       # この日数以内の公演はセトリ未取得なら毎回チェック
REFRESH_DAYS = 10        # この日数以内の公演はセトリ取得済みでも取り直す（後から修正されるため）
MAX_SETLIST_FETCH = 80   # 1 回の実行で取得するセトリの上限

JST = timezone(timedelta(hours=9))
LIVE_FIELDS = ["日付", "ライブ名", "会場", "ライブ情報"]
SETLIST_FIELDS = ["ライブ情報", "演奏順", "曲名"]

session = requests.Session()
session.headers.update(HEADERS)


class FetchError(Exception):
    pass


def get_html(url: str, retries: int = 3) -> str:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            res = session.get(url, timeout=30)
            if res.status_code == 404:
                raise FetchError(f"404 Not Found: {url}")
            res.raise_for_status()
            res.encoding = res.apparent_encoding
            return res.text
        except FetchError:
            raise
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 ** (attempt + 1))
    raise FetchError(f"failed to fetch {url}: {last}")


# ---------------------------------------------------------------- parsing

def parse_event_list(html: str) -> list[dict[str, str]]:
    """検索結果ページから公演一覧を取り出す"""
    soup = BeautifulSoup(html, "html.parser")
    blocks = soup.find_all("div", class_=lambda c: c and c.startswith("whiteBack midBox"))
    events = []
    for ev in blocks:
        name_tag = ev.find("h3", class_="artistName")
        date_tag = ev.find("p", class_="date")
        if not (name_tag and name_tag.find("a") and date_tag):
            continue
        href = name_tag.find("a").get("href", "")
        url = href if href.startswith("http") else BASE + href
        raw_date = str(date_tag.contents[0]).strip() if date_tag.contents else ""
        live_date = raw_date.split(" ")[0]
        addr = date_tag.find("span", class_="address")
        venue = addr.get_text().replace("＠", "").replace("@", "").strip() if addr else "会場不明"
        events.append({
            "日付": live_date,
            "ライブ名": name_tag.get_text().strip(),
            "会場": venue or "会場不明",
            "ライブ情報": url.split("?")[0],
        })
    return events


def parse_setlist(html: str) -> list[str]:
    """公演ページからセットリストの曲名を順番に取り出す"""
    soup = BeautifulSoup(html, "html.parser")
    titles = []
    for div in soup.find_all("div", class_="ttl"):
        link = div.find("a")
        if link and "/songs/" in link.get("href", ""):
            titles.append(link.get_text().strip())
    return titles


# ---------------------------------------------------------------- csv io

def read_rows(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8-sig", newline="") as f:
        return [dict(r) for r in csv.DictReader(f)]


def write_rows(path: Path, fields: list[str], rows: list[dict[str, str]]) -> None:
    tmp = path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore", lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    tmp.replace(path)


def to_date(s: str) -> date | None:
    try:
        return datetime.strptime(s.strip().replace("-", "/"), "%Y/%m/%d").date()
    except ValueError:
        return None


# ---------------------------------------------------------------- main logic

def crawl(url_tpl: str, max_pages: int, stop_when_all_known: set[str] | None = None) -> list[dict[str, str]]:
    found: list[dict[str, str]] = []
    prev: list[str] = []
    for page in range(1, max_pages + 1):
        events = parse_event_list(get_html(url_tpl.format(page=page)))
        urls = [e["ライブ情報"] for e in events]
        if not events or urls == prev:  # 最終ページの先で同じページが返ってくる場合の保険
            break
        prev = urls
        found.extend(events)
        if stop_when_all_known is not None and all(e["ライブ情報"] in stop_when_all_known for e in events):
            break
        time.sleep(WAIT_SEC)
    return found


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true", help="過去の公演一覧を最後のページまでたどる")
    ap.add_argument("--retry-all", action="store_true", help="セトリ未取得の過去公演をすべて再取得する")
    args = ap.parse_args()

    today = datetime.now(JST).date()
    lives = {r["ライブ情報"]: {k: r.get(k, "") for k in LIVE_FIELDS} for r in read_rows(CSV_LIVES) if r.get("ライブ情報")}
    setlist_rows = read_rows(CSV_SETLISTS)
    setlists: dict[str, list[str]] = {}
    for r in sorted(setlist_rows, key=lambda r: int(float(r.get("演奏順") or 0))):
        setlists.setdefault(r["ライブ情報"], []).append(r["曲名"])

    errors: list[str] = []
    added, updated, removed = 0, 0, 0

    # 1) 開催予定（毎回すべて取得して差し替え）
    try:
        future = crawl(URL_FUTURE, max_pages=10)
    except FetchError as e:
        errors.append(str(e))
        future = []
    future_urls = {e["ライブ情報"] for e in future}
    for e in future:
        if e["ライブ情報"] not in lives:
            added += 1
        elif lives[e["ライブ情報"]] != e:
            updated += 1
        lives[e["ライブ情報"]] = e
    if future:  # 取得に成功したときだけ、掲載が消えた未来の公演（中止など）を削除
        for url in list(lives):
            d = to_date(lives[url]["日付"])
            if d and d > today and url not in future_urls and url not in setlists:
                del lives[url]
                removed += 1

    # 2) 過去公演（セトリあり）。既知の公演だけのページに達したら終了
    try:
        known = set(lives) & set(setlists)
        past = crawl(URL_PAST, max_pages=60 if args.full else 5, stop_when_all_known=None if args.full else known)
    except FetchError as e:
        errors.append(str(e))
        past = []
    past_with_setlist = set()
    for e in past:
        past_with_setlist.add(e["ライブ情報"])
        if e["ライブ情報"] not in lives:
            added += 1
        lives[e["ライブ情報"]] = e

    # 3) セットリスト取得対象を決める
    targets = []
    for url, l in lives.items():
        d = to_date(l["日付"])
        if not d or d > today:
            continue
        age = (today - d).days
        has = url in setlists
        if (not has and (args.retry_all or age <= RECHECK_DAYS or url in past_with_setlist)) or (has and age <= REFRESH_DAYS):
            targets.append((d, url))
    targets.sort(reverse=True)
    targets = targets[:MAX_SETLIST_FETCH]

    fetched = 0
    for _, url in targets:
        try:
            titles = parse_setlist(get_html(url))
        except FetchError as e:
            errors.append(str(e))
            continue
        finally:
            time.sleep(WAIT_SEC)
        if titles:
            if setlists.get(url) != titles:
                fetched += 1
            setlists[url] = titles

    # 4) 保存（日付の新しい順）
    live_rows = sorted(lives.values(), key=lambda r: (r["日付"], r["ライブ情報"]), reverse=True)
    write_rows(CSV_LIVES, LIVE_FIELDS, live_rows)
    order = {r["ライブ情報"]: i for i, r in enumerate(live_rows)}
    out_setlists = []
    for url in sorted(setlists, key=lambda u: order.get(u, 10**9)):
        if url not in lives:
            continue
        for i, t in enumerate(setlists[url], start=1):
            out_setlists.append({"ライブ情報": url, "演奏順": str(i), "曲名": t})
    write_rows(CSV_SETLISTS, SETLIST_FIELDS, out_setlists)

    print(f"lives: +{added} new, {updated} updated, {removed} removed / setlists: {fetched} new or changed "
          f"(checked {len(targets)})")
    for e in errors:
        print(f"::warning::{e}")
    # 過去公演の一覧が空になることは通常ありえない → サイト構造の変更やアクセス制限を疑い、
    # ワークフローを失敗させて気付けるようにする（既存データはそのまま保持）
    if not past:
        print("::error::LiveFans から過去公演の一覧を取得できませんでした（サイト構造の変更やアクセス制限の可能性）")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
