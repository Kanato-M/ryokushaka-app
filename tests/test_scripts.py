"""データ取得・生成スクリプトのテスト（ネットワークには接続しません）

実行: python -m unittest discover -s tests -v
"""

import csv
import importlib
import shutil
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import build_data  # noqa: E402
import update_data  # noqa: E402


def event_block(eid, name, d, venue):
    return f"""
    <div class="whiteBack midBox clearfix">
      <h3 class="artistName"><a href="/events/{eid}">{name}</a></h3>
      <p class="date">{d} (土)<span class="address">＠{venue}</span></p>
    </div>"""


def list_page(*blocks):
    return f"<html><body>{''.join(blocks)}</body></html>"


def setlist_page(*songs):
    divs = "".join(f'<div class="ttl"><a href="/songs/{i}">{s}</a></div>' for i, s in enumerate(songs))
    return f'<html><body><div class="ttl">ENCORE</div>{divs}</body></html>'


class ParseTest(unittest.TestCase):
    def test_parse_event_list(self):
        html = list_page(event_block(100, "緑黄色社会 ツアー", "2026/01/02", "日本武道館 (東京都)"))
        events = update_data.parse_event_list(html)
        self.assertEqual(events, [{
            "日付": "2026/01/02", "ライブ名": "緑黄色社会 ツアー",
            "会場": "日本武道館 (東京都)", "ライブ情報": "https://www.livefans.jp/events/100",
        }])

    def test_parse_setlist_ignores_non_song_rows(self):
        self.assertEqual(update_data.parse_setlist(setlist_page("Mela!", "サボテン")), ["Mela!", "サボテン"])


class UpdateTest(unittest.TestCase):
    """update_data.main() を一時ディレクトリ上で、LiveFans の応答を差し替えて実行する"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.today = date.today()
        self.d = lambda days: (self.today + timedelta(days=days)).strftime("%Y/%m/%d")
        with (self.tmp / "LiveList.csv").open("w", encoding="utf-8", newline="") as f:
            w = csv.writer(f)
            w.writerow(["日付", "ライブ名", "会場", "ライブ情報"])
            w.writerow([self.d(-3), "緑黄色社会 ツアー", "A (東京都)", "https://www.livefans.jp/events/1"])   # セトリ未取得
            w.writerow([self.d(-400), "緑黄色社会 昔のツアー", "B (大阪府)", "https://www.livefans.jp/events/2"])
            w.writerow([self.d(30), "緑黄色社会 中止公演", "C (愛知県)", "https://www.livefans.jp/events/3"])
        with (self.tmp / "Setlists.csv").open("w", encoding="utf-8", newline="") as f:
            w = csv.writer(f)
            w.writerow(["ライブ情報", "演奏順", "曲名"])
            w.writerow(["https://www.livefans.jp/events/2", "1", "Mela!"])

        self.pages = {
            update_data.URL_FUTURE.format(page=1): list_page(
                event_block(4, "緑黄色社会 新ツアー", self.d(60), "D (福岡県)"),
            ),
            update_data.URL_FUTURE.format(page=2): list_page(),
            update_data.URL_PAST.format(page=1): list_page(
                event_block(1, "緑黄色社会 ツアー", self.d(-3), "A (東京都)"),
                event_block(2, "緑黄色社会 昔のツアー", self.d(-400), "B (大阪府)"),
            ),
            update_data.URL_PAST.format(page=2): list_page(),
            "https://www.livefans.jp/events/1": setlist_page("サボテン", "Mela!"),
        }

    def run_main(self, args=()):
        def fake_get(url, retries=3):
            if url not in self.pages:
                raise update_data.FetchError(f"404 Not Found: {url}")
            return self.pages[url]

        with mock.patch.object(update_data, "CSV_LIVES", self.tmp / "LiveList.csv"), \
             mock.patch.object(update_data, "CSV_SETLISTS", self.tmp / "Setlists.csv"), \
             mock.patch.object(update_data, "get_html", side_effect=fake_get), \
             mock.patch.object(update_data, "WAIT_SEC", 0), \
             mock.patch.object(sys, "argv", ["update_data.py", *args]):
            return update_data.main()

    def read(self, name):
        with (self.tmp / name).open(encoding="utf-8") as f:
            return list(csv.DictReader(f))

    def test_update(self):
        self.assertEqual(self.run_main(), 0)
        lives = {r["ライブ情報"].rsplit("/", 1)[1]: r for r in self.read("LiveList.csv")}
        self.assertIn("4", lives, "新しい開催予定が追加される")
        self.assertNotIn("3", lives, "掲載が消えた未来の公演は削除される")
        self.assertIn("1", lives)
        setlists = self.read("Setlists.csv")
        ev1 = [r["曲名"] for r in setlists if r["ライブ情報"].endswith("/1")]
        self.assertEqual(ev1, ["サボテン", "Mela!"], "公演後に登録されたセトリを取得する")
        self.assertEqual([r["曲名"] for r in setlists if r["ライブ情報"].endswith("/2")], ["Mela!"])

    def test_total_failure_returns_error_and_keeps_data(self):
        self.pages = {}
        before = (self.tmp / "LiveList.csv").read_text(encoding="utf-8")
        self.assertEqual(self.run_main(), 1)
        after_ids = {r["ライブ情報"] for r in self.read("LiveList.csv")}
        self.assertEqual(len(after_ids), 3, "取得失敗時に既存の公演を消さない")
        self.assertIn("events/3", before)


class BuildTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)

    def write(self, name, header, rows):
        with (self.tmp / name).open("w", encoding="utf-8", newline="") as f:
            w = csv.writer(f)
            w.writerow(header)
            w.writerows(rows)

    def test_build_cleans_setlists(self):
        self.write("SongList.csv", ["曲名", "リリース日", "初収録アルバム名"],
                   [["Shout Baby", "2020/03/04", "x"], ["ナイスアイディア!", "2019/01/01", "y"], ["Mela!", "2020/01/01", "z"]])
        self.write("song_aliases.csv", ["表記ゆれ", "正式な曲名"], [["ナイスアイデア!", "ナイスアイディア!"]])
        self.write("LiveList.csv", ["日付", "ライブ名", "会場", "ライブ情報"], [
            ["2024/01/01", "緑黄色社会 ツアー", "A", "https://www.livefans.jp/events/1"],
            ["2024/02/01", "CDTVライブ ! ライブ !", "B", "https://www.livefans.jp/events/2"],
            ["2024/03/01", "BUMP OF CHICKEN TOUR", "C", "https://www.livefans.jp/events/3"],
        ])
        self.write("Setlists.csv", ["ライブ情報", "演奏順", "曲名"], [
            ["https://www.livefans.jp/events/1", "1", "ShoutBaby"],
            ["https://www.livefans.jp/events/1", "2", "--MC①--"],
            ["https://www.livefans.jp/events/1", "3", "ナイスアイデア!"],
            ["https://www.livefans.jp/events/1", "4", "ShoutBaby"],
            ["https://www.livefans.jp/events/1", "5", "さくらんぼ [大塚愛]"],
            ["https://www.livefans.jp/events/2", "1", "他の人の曲1"],
            ["https://www.livefans.jp/events/2", "2", "Mela!"],
            ["https://www.livefans.jp/events/2", "3", "他の人の曲2"],
        ])

        with mock.patch.object(build_data, "DATA_DIR", self.tmp):
            data = build_data.build()

        self.assertEqual([l["id"] for l in data["lives"]], ["2", "1"], "他アーティストの公演を除外し、新しい順")
        self.assertEqual(data["setlists"]["1"], ["Shout Baby", "ナイスアイディア!", "さくらんぼ [大塚愛]"],
                         "表記ゆれ統一・MC除外・重複除外・カバー曲は残す")
        self.assertEqual(data["setlists"]["2"], ["Mela!"], "TV 番組は緑黄色社会の曲だけ残す")
        self.assertEqual({l["id"]: l["type"] for l in data["lives"]}, {"1": "oneman", "2": "tv"})
        self.assertNotIn("seedMyLives", data, "個人の参戦記録を公開データに含めない")

    def test_real_data_builds(self):
        data = build_data.build()
        self.assertGreater(len(data["lives"]), 400)
        self.assertGreater(len(data["setlists"]), 400)
        ids = {l["id"] for l in data["lives"]}
        self.assertTrue(set(data["setlists"]) <= ids)


if __name__ == "__main__":
    unittest.main()
