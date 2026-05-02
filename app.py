import streamlit as st
import pandas as pd
import requests
from bs4 import BeautifulSoup
import time
import os
import google.generativeai as genai
import plotly.express as px

# --- ページ設定 ---
st.set_page_config(page_title="緑黄色社会 ライブ＆楽曲管理アプリ", page_icon="🥦", layout="wide")

# --- 定数設定 ---
CSV_LIVES = "LiveList.csv"
CSV_SONGS = "SongList.csv"
CSV_SETLISTS = "Setlists.csv"
CSV_MYLIVES = "mylive.csv"

# 取得用URL（before=過去, after=未来）
URL_PAST = "https://www.livefans.jp/search/artist/25704/page:{page}?&setlist=1&year=before&sort=e1"
URL_FUTURE = "https://www.livefans.jp/search/artist/25704/page:{page}?&year=after&sort=e2"
HEADERS = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}

BAD_ARTISTS = ['グッドモーニングアメリカ', '忌野清志郎', 'BUMP OF CHICKEN', '石鹸屋', 'BLUE ENCOUNT', 
               '屋敷豪太', 'SAKANAMON', 'The California Guitar Trio', 'きのこ帝国', 'Shing02', 
               '凛として時雨', 'Arrested Development']

# 新しいレアリティの説明文
RARITY_EXPLANATION = """
---
#### 💎 楽曲レアリティ判定基準(ツアー重複考慮あり)
* **<span style='color: #ff66b2;'>UR (Pink)</span>**: 最終披露日から4年以上経過
* **<span style='color: #ffa500;'>SSR (Orange)</span>**: 最終披露日から2年以上経過
* **<span style='color: #ffd700;'>SR (Yellow)</span>**: 直近2年の披露率が4%以下
* **<span style='color: #b258e6;'>RR (Purple)</span>**: 直近2年の披露率が8%以下
* **<span style='color: #1c83e1;'>R (Blue)</span>**: 直近2年の披露率が30%以下
* **<span style='color: #32cd32;'>UC (Green)</span>**: 直近2年の披露率が50%以下
* **C (White)**: 上記以外（定番曲）
* **<span style='color: #ff66b2;'>未収録(UR扱い)</span>**: 公式曲リストにないカバーや未音源化曲
"""

# 新しいカラーマッピング
RARITY_COLORS = {
    "UR": "#ff66b2",  # ピンク
    "SSR": "#ffa500", # オレンジ
    "SR": "#ffd700",  # 黄 (視認性のため少しゴールド寄り)
    "RR": "#b258e6",  # 紫
    "R": "#1c83e1",   # 青
    "UC": "#32cd32",  # 緑
    "C": "#cccccc",   # 白（グラフ用に薄いグレー）
    "未収録(UR扱い)": "#ff66b2" 
}

def color_rarity(val):
    color = RARITY_COLORS.get(val, "")
    if color:
        return f'color: {color}; font-weight: bold;'
    return ''

# --- データの読み込みと初期化 ---
@st.cache_data
def load_data():
    try:
        df_songs = pd.read_csv(CSV_SONGS)
    except FileNotFoundError:
        df_songs = pd.DataFrame(columns=['曲名', 'リリース日', '初収録アルバム名'])

    try:
        df_lives = pd.read_csv(CSV_LIVES)
    except FileNotFoundError:
        df_lives = pd.DataFrame(columns=['日付', 'ライブ名', '会場', 'ライブ情報'])

    if '会場' not in df_lives.columns: df_lives['会場'] = "会場不明"
    if '日付' not in df_lives.columns: df_lives['日付'] = "日付不明"
    if 'ライブ情報' not in df_lives.columns: df_lives['ライブ情報'] = ""

    if not df_lives.empty and 'ライブ名' in df_lives.columns:
        df_lives = df_lives[~df_lives['ライブ名'].str.contains('|'.join(BAD_ARTISTS), na=False)]
        df_lives = df_lives[df_lives['ライブ情報'].notna()]

    if not df_lives.empty:
        df_lives['表示名'] = df_lives['日付'].astype(str) + " | " + df_lives['ライブ名'].astype(str) + " @ " + df_lives['会場'].astype(str)

    try:
        df_setlists = pd.read_csv(CSV_SETLISTS)
    except FileNotFoundError:
        df_setlists = pd.DataFrame(columns=['ライブ情報', '演奏順', '曲名'])

    return df_songs, df_lives, df_setlists

def load_mylives():
    try:
        return pd.read_csv(CSV_MYLIVES)['表示名'].tolist()
    except FileNotFoundError:
        return []

def save_mylives(mylive_list):
    pd.DataFrame({'表示名': mylive_list}).to_csv(CSV_MYLIVES, index=False)

df_songs, df_lives, df_setlists = load_data()

# --- 統計と厳密なレア度（UR~C）の計算関数 ---
@st.cache_data
def calculate_song_stats(df_songs_base, df_lives_base, df_setlists_base):
    if df_songs_base.empty or df_setlists_base.empty or df_lives_base.empty:
        return pd.DataFrame()
        
    df_l = df_lives_base.copy()
    df_l['日付'] = pd.to_datetime(df_l['日付'], errors='coerce')
    df_l = df_l.dropna(subset=['日付'])

    today = pd.Timestamp.today()
    two_years_ago = today - pd.DateOffset(years=2)
    df_l_past = df_l[df_l['日付'] <= today]
    
    # 1. 各ライブ名（ツアーやフェス等）ごとの総公演数を計算
    live_total_counts = df_l_past['ライブ名'].value_counts().to_dict()
    live_total_counts_2y = df_l_past[df_l_past['日付'] >= two_years_ago]['ライブ名'].value_counts().to_dict()

    merged = pd.merge(df_setlists_base, df_l_past[['ライブ情報', '日付', 'ライブ名']], on='ライブ情報', how='left')
    merged['is_last_2y'] = merged['日付'] >= two_years_ago
    
    # 2. 曲ごとの「真の披露評価値（公演ごとの披露率の合計）」を計算する関数
    def calculate_true_score(group, target_lives_dict):
        score = 0.0
        name_counts = group['ライブ名'].value_counts()
        for name, count in name_counts.items():
            if name in target_lives_dict:
                total_performances = target_lives_dict[name]
                score += (count / total_performances)
        return score

    # 表示用の「単純な披露回数」を計算
    stats = merged.groupby('曲名').agg(
        披露回数_表示用=('日付', 'count'), 
        初披露日=('日付', 'min'),
        最終披露日=('日付', 'max')
    ).reset_index()
    
    # 真の評価値を計算 (全期間と直近2年)
    weighted_stats = merged.groupby('曲名').apply(lambda x: pd.Series({
        '評価値_全期間': calculate_true_score(x, live_total_counts),
        '評価値_直近2年': calculate_true_score(x[x['is_last_2y']], live_total_counts_2y)
    })).reset_index()
    
    stats = pd.merge(stats, weighted_stats, on='曲名')
    total_unique_lives_last_2y = len(live_total_counts_2y)

    def calc_metrics(row):
        if pd.isna(row['初披露日']):
            return pd.Series([0.0, 0.0, "C"])
            
        lives_after_df = df_l_past[df_l_past['日付'] >= row['初披露日']]
        total_unique_lives_after = len(lives_after_df['ライブ名'].unique())
        
        rate_all = (row['評価値_全期間'] / total_unique_lives_after * 100) if total_unique_lives_after > 0 else 0.0
        
        if row['初披露日'] >= two_years_ago:
            rate_2y = rate_all
        else:
            rate_2y = (row['評価値_直近2年'] / total_unique_lives_last_2y * 100) if total_unique_lives_last_2y > 0 else 0.0
        
        years_since_last = (today - row['最終披露日']).days / 365.25 if pd.notna(row['最終披露日']) else 0
        
        # 新しい厳格なレア度判定ロジック
        if years_since_last >= 4.0:
            rarity = "UR"
        elif years_since_last >= 2.0:
            rarity = "SSR"
        elif rate_2y <= 4.0:
            rarity = "SR"
        elif rate_2y <= 8.0:
            rarity = "RR"
        elif rate_2y <= 30.0:
            rarity = "R"
        elif rate_2y <= 50.0:
            rarity = "UC"
        else:
            rarity = "C"
            
        return pd.Series([rate_all, rate_2y, rarity])

    stats[['全期間披露率', '直近2年披露率', 'レア度']] = stats.apply(calc_metrics, axis=1)
    stats['初披露日'] = stats['初披露日'].dt.strftime('%Y/%m/%d')
    stats['最終披露日'] = stats['最終披露日'].dt.strftime('%Y/%m/%d')
    
    res_df = pd.merge(df_songs_base[['曲名', 'リリース日', '初収録アルバム名']], stats, on='曲名', how='left')
    res_df['披露回数'] = res_df['披露回数_表示用'].fillna(0).astype(int)
    res_df['全期間披露率'] = res_df['全期間披露率'].fillna(0.0)
    res_df['直近2年披露率'] = res_df['直近2年披露率'].fillna(0.0)
    res_df['レア度'] = res_df['レア度'].fillna("C")
    
    # 並び順にRRを追加
    rarity_order = {"UR": 1, "SSR": 2, "SR": 3, "RR": 4, "R": 5, "UC": 6, "C": 7}
    res_df['レア度順'] = res_df['レア度'].map(rarity_order)
    
    return res_df

df_songs_stats = calculate_song_stats(df_songs, df_lives, df_setlists)
song_rarity_dict = dict(zip(df_songs_stats['曲名'], df_songs_stats['レア度'])) if not df_songs_stats.empty else {}

# --- スクレイピング関数 ---
def fetch_lives(base_url, existing_urls):
    new_lives = []
    stop_scraping = False
    for page in range(1, 10): 
        url = base_url.format(page=page)
        response = requests.get(url, headers=HEADERS)
        response.encoding = response.apparent_encoding
        soup = BeautifulSoup(response.text, 'html.parser')
        
        event_blocks = soup.find_all('div', class_=lambda c: c and c.startswith('whiteBack midBox'))
        if not event_blocks: break
            
        for event in event_blocks:
            name_tag = event.find('h3', class_='artistName')
            date_tag = event.find('p', class_='date')
            if name_tag and name_tag.find('a') and date_tag:
                live_name = name_tag.text.strip()
                live_url = "https://www.livefans.jp" + name_tag.find('a').get('href')
                
                if live_url in existing_urls:
                    stop_scraping = True
                    break
                
                raw_date = str(date_tag.contents[0]).strip()
                live_date = raw_date.split(' ')[0] if ' ' in raw_date else raw_date
                address_span = date_tag.find('span', class_='address')
                venue = address_span.text.replace('＠', '').replace('@', '').strip() if address_span else "会場不明"
                
                new_lives.append({'日付': live_date, 'ライブ名': live_name, '会場': venue, 'ライブ情報': live_url})
        if stop_scraping: break
        time.sleep(0.7)
    return pd.DataFrame(new_lives).drop_duplicates(subset=['ライブ情報'])

def fetch_single_setlist(event_url):
    response = requests.get(event_url, headers=HEADERS)
    response.encoding = response.apparent_encoding
    soup = BeautifulSoup(response.text, 'html.parser')
    setlist = []
    song_divs = soup.find_all('div', class_='ttl')
    for i, div in enumerate(song_divs):
        song_link = div.find('a')
        if song_link and '/songs/' in song_link.get('href', ''):
            setlist.append({"ライブ情報": event_url, "演奏順": i + 1, "曲名": song_link.text.strip()})
    return pd.DataFrame(setlist)

# --- サイドバー：メニュー構成 ---
st.sidebar.title("🥦 リョクシャカLIVE管理")
menu = st.sidebar.radio("メニュー", [
    "🏠 ホーム",
    "🎸 ライブ・フェス情報", 
    "🔍 楽曲からライブを探す",
    "📝 各ライブのセットリスト",
    "💿 リリース楽曲一覧", 
    "🎫 マイ参戦記録", 
    "🤖 AIアシスタント"
])

# --- 0. ホーム（ダッシュボード） ---
if menu == "🏠 ホーム":
    st.header("🏠 ダッシュボード")
    st.write("緑黄色社会のライブ記録とあなたの参戦状況のサマリーです。")
    
    my_attended_lives = load_mylives()
    official_songs = df_songs['曲名'].dropna().unique().tolist() if not df_songs.empty else []
    
    df_l_past = df_lives.copy()
    df_l_past['日付_dt'] = pd.to_datetime(df_l_past['日付'], errors='coerce')
    df_l_past = df_l_past[df_l_past['日付_dt'] <= pd.Timestamp.today()]
    
    total_lives = len(df_l_past)
    my_lives_count = len(my_attended_lives)
    comp_rate = 0.0
    heard_official_count = 0
    
    my_heard_songs_df = pd.DataFrame()
    if my_attended_lives and not df_setlists.empty:
        attended_urls = df_lives[df_lives['表示名'].isin(my_attended_lives)]['ライブ情報'].tolist()
        my_heard_songs_df = df_setlists[df_setlists['ライブ情報'].isin(attended_urls)].copy()
        
        heard = my_heard_songs_df['曲名'].dropna().unique()
        official_heard = [s for s in heard if s in official_songs]
        heard_official_count = len(official_heard)
        if len(official_songs) > 0:
            comp_rate = (heard_official_count / len(official_songs)) * 100

    col1, col2, col3 = st.columns(3)
    col1.metric("総ライブ登録数(過去)", f"{total_lives} 公演")
    col2.metric("あなたの参戦数", f"{my_lives_count} 公演")
    col3.metric("楽曲コンプリート率", f"{comp_rate:.1f}%", f"{heard_official_count} / {len(official_songs)}曲")

    st.markdown("---")
    
    if my_attended_lives and not df_lives.empty and not my_heard_songs_df.empty:
        g_col1, g_col2 = st.columns(2)
        
        with g_col1:
            st.subheader("📊 年別参戦回数")
            attended_df = df_lives[df_lives['表示名'].isin(my_attended_lives)].copy()
            attended_df['年'] = pd.to_datetime(attended_df['日付'], errors='coerce').dt.year
            yearly_counts = attended_df['年'].value_counts().sort_index()
            
            if not yearly_counts.empty:
                yearly_counts.index = yearly_counts.index.astype(int).astype(str)
                st.bar_chart(yearly_counts)

            st.subheader("🎧 現地でよく聴いた曲 Top5")
            song_counts = my_heard_songs_df['曲名'].value_counts().head(5).reset_index()
            song_counts.columns = ['曲名', '回数']
            fig_top_songs = px.bar(song_counts, x='回数', y='曲名', orientation='h', text='回数')
            fig_top_songs.update_layout(yaxis={'categoryorder':'total ascending'}, margin=dict(l=0, r=0, t=0, b=0), height=250)
            st.plotly_chart(fig_top_songs, use_container_width=True)

        with g_col2:
            st.subheader("💎 回収済み楽曲のレアリティ構成")
            my_official_heard_df = pd.DataFrame({'曲名': official_heard})
            if not df_songs_stats.empty:
                my_official_heard_df['レア度'] = my_official_heard_df['曲名'].map(song_rarity_dict).fillna("C")
                rarity_counts = my_official_heard_df['レア度'].value_counts().reset_index()
                rarity_counts.columns = ['レア度', '曲数']
                
                # パイチャートの順番設定
                rarity_order_list = ["UR", "SSR", "SR", "RR", "R", "UC", "C"]
                rarity_counts['レア度'] = pd.Categorical(rarity_counts['レア度'], categories=rarity_order_list, ordered=True)
                rarity_counts = rarity_counts.sort_values('レア度')

                fig_rarity = px.pie(
                    rarity_counts, 
                    values='曲数', 
                    names='レア度',
                    color='レア度',
                    color_discrete_map=RARITY_COLORS,
                    hole=0.4
                )
                fig_rarity.update_traces(textposition='inside', textinfo='percent+label+value')
                fig_rarity.update_layout(margin=dict(l=20, r=20, t=20, b=20), height=350)
                st.plotly_chart(fig_rarity, use_container_width=True)
                
                st.write("※公式リリース楽曲のみを集計しています。")
    else:
        st.info("「🎫 マイ参戦記録」からライブを追加すると、ここに様々な分析グラフが表示されます。")

# --- 1. ライブ・フェス情報 ---
elif menu == "🎸 ライブ・フェス情報":
    st.header("ライブ・フェス情報")
    st.write("LiveFansから取得した過去の履歴と今後の開催予定です。")
    
    col1, col2 = st.columns(2)
    with col1:
        if st.button("① 最新のライブ情報を取得・更新"):
            with st.spinner("LiveFansをチェック中..."):
                existing_urls = df_lives['ライブ情報'].tolist() if not df_lives.empty else []
                new_past_df = fetch_lives(URL_PAST, existing_urls)
                new_future_df = fetch_lives(URL_FUTURE, existing_urls)
                new_data_df = pd.concat([new_past_df, new_future_df], ignore_index=True)
                
                if not new_data_df.empty:
                    updated_df = pd.concat([new_data_df, df_lives], ignore_index=True).drop_duplicates(subset=['ライブ情報'])
                    updated_df = updated_df.sort_values(by='日付', ascending=False)
                    updated_df.to_csv(CSV_LIVES, index=False)
                    st.success(f"新しく {len(new_data_df)} 件のライブデータを追加しました！リロードしてください。")
                else:
                    st.info("新しいライブ情報はありませんでした。")
                
    with col2:
        if st.button("② 未取得のセットリストを一括取得"):
            if df_lives.empty:
                st.error("先にライブ履歴を取得してください。")
            else:
                with st.spinner("不足しているセットリストを取得中..."):
                    known_urls = df_setlists['ライブ情報'].unique() if not df_setlists.empty else []
                    
                    df_lives['日付_dt'] = pd.to_datetime(df_lives['日付'], errors='coerce')
                    past_lives = df_lives[df_lives['日付_dt'] <= pd.Timestamp.today()]
                    missing_urls = past_lives[~past_lives['ライブ情報'].isin(known_urls)]['ライブ情報'].tolist()
                    
                    new_setlists = []
                    progress_bar = st.progress(0)
                    for i, url in enumerate(missing_urls):
                        sl_df = fetch_single_setlist(url)
                        if not sl_df.empty: new_setlists.append(sl_df)
                        progress_bar.progress((i + 1) / len(missing_urls))
                        time.sleep(0.7)
                    if new_setlists:
                        updated_setlists = pd.concat([df_setlists] + new_setlists, ignore_index=True)
                        updated_setlists.to_csv(CSV_SETLISTS, index=False)
                        st.success(f"{len(missing_urls)} 公演分のセットリストを新規取得・保存しました！")
                    else:
                        st.info("すべてのセットリストが最新の状態です。")

    if not df_lives.empty:
        today = pd.Timestamp.today().strftime('%Y/%m/%d')
        future_df = df_lives[df_lives['日付'] > today]
        past_df = df_lives[df_lives['日付'] <= today]
        
        st.subheader("📅 開催予定")
        if not future_df.empty:
            st.dataframe(future_df[['日付', 'ライブ名', '会場', 'ライブ情報']].sort_values(by='日付'), use_container_width=True, hide_index=True)
        else:
            st.write("現在、登録されている開催予定のライブはありません。")
            
        st.subheader("🕰️ 過去の履歴")
        st.dataframe(past_df[['日付', 'ライブ名', '会場', 'ライブ情報']], use_container_width=True, hide_index=True)

# --- 新設: 楽曲からライブを探す ---
elif menu == "🔍 楽曲からライブを探す":
    st.header("楽曲からライブを探す（逆引き）")
    if not df_setlists.empty and not df_lives.empty and not df_songs.empty:
        official_songs = sorted(df_songs['曲名'].dropna().unique().tolist())
        selected_song = st.selectbox("曲名を選択してください", [""] + official_songs)
        
        if selected_song:
            played_urls = df_setlists[df_setlists['曲名'] == selected_song]['ライブ情報'].tolist()
            played_lives_df = df_lives[df_lives['ライブ情報'].isin(played_urls)].copy()
            played_lives_df = played_lives_df.sort_values(by='日付', ascending=False)
            
            st.success(f"🎵 「{selected_song}」は過去に **{len(played_lives_df)} 回** 演奏されています！")
            
            if not played_lives_df.empty:
                st.dataframe(played_lives_df[['日付', 'ライブ名', '会場', 'ライブ情報']], use_container_width=True, hide_index=True)
                
                st.subheader(f"📈 「{selected_song}」 年毎の披露回数")
                played_lives_df['年'] = pd.to_datetime(played_lives_df['日付']).dt.year
                yearly_counts = played_lives_df['年'].value_counts().sort_index()

                if not yearly_counts.empty:
                    min_year = int(yearly_counts.index.min())
                    max_year = int(pd.Timestamp.today().year)
                    all_years = list(range(min_year, max_year + 1))
                    
                    yearly_counts = yearly_counts.reindex(all_years, fill_value=0)
                    yearly_counts.index = yearly_counts.index.astype(str)
                    
                    st.line_chart(yearly_counts)
    else:
        st.info("データがありません。「🎸 ライブ・フェス情報」から取得してください。")


# --- 2. 各ライブのセットリスト ---
elif menu == "📝 各ライブのセットリスト":
    st.header("各ライブのセットリスト")
    if not df_lives.empty:
        df_lives['日付_dt'] = pd.to_datetime(df_lives['日付'], errors='coerce')
        past_lives = df_lives[df_lives['日付_dt'] <= pd.Timestamp.today()]
        
        selected_display = st.selectbox("ライブを選択してください", past_lives['表示名'].tolist())
        
        if selected_display:
            selected_url = past_lives[past_lives['表示名'] == selected_display]['ライブ情報'].values[0]
            current_setlist = df_setlists[df_setlists['ライブ情報'] == selected_url].copy()
            
            if not current_setlist.empty:
                st.success("セトリ表示中 (ローカルデータ)")
                
                if not df_songs_stats.empty:
                    current_setlist['レア度'] = current_setlist['曲名'].map(song_rarity_dict).fillna("未収録(UR扱い)")
                    
                    styled_sl = current_setlist[['演奏順', '曲名', 'レア度']].style.map(color_rarity, subset=['レア度'])
                    st.dataframe(styled_sl, use_container_width=True, hide_index=True)
                    
                    st.subheader("📊 このライブのレアリティ構成")
                    rarity_counts = current_setlist['レア度'].value_counts().reset_index()
                    rarity_counts.columns = ['レア度', '曲数']
                    
                    fig = px.pie(
                        rarity_counts, 
                        values='曲数', 
                        names='レア度',
                        color='レア度',
                        color_discrete_map=RARITY_COLORS,
                        hole=0.4
                    )
                    fig.update_traces(textposition='inside', textinfo='percent+label')
                    st.plotly_chart(fig, use_container_width=True)

                    st.markdown(RARITY_EXPLANATION, unsafe_allow_html=True)
            else:
                st.warning("ローカルにセットリストがありません。")
                if st.button("この公演のセトリを今すぐ取得"):
                    with st.spinner("取得中..."):
                        sl_df = fetch_single_setlist(selected_url)
                        if not sl_df.empty:
                            updated_sl = pd.concat([df_setlists, sl_df], ignore_index=True)
                            updated_sl.to_csv(CSV_SETLISTS, index=False)
                            st.success("取得しました！リロードしてください。")
                        else:
                            st.error("LiveFans側にセットリストが登録されていません。")
    else:
        st.info("ライブデータがありません。")

# --- 3. リリース楽曲一覧 ---
elif menu == "💿 リリース楽曲一覧":
    st.header("リリース楽曲一覧＆レアリティ")
    
    if not df_songs_stats.empty:
        df_songs_stats = df_songs_stats.sort_values(by=['レア度順', '直近2年披露率']).drop(columns=['レア度順'])
        
        cols = ['曲名', 'レア度', '直近2年披露率', '全期間披露率', '披露回数', '最終披露日', '初披露日']
        existing_cols = [c for c in cols if c in df_songs_stats.columns]
        
        search_query = st.text_input("楽曲名で検索")
        filtered_df = df_songs_stats[df_songs_stats['曲名'].str.contains(search_query, na=False)] if search_query else df_songs_stats
        
        styled_df = filtered_df[existing_cols].style\
            .map(color_rarity, subset=['レア度'])\
            .format({
                "全期間披露率": "{:.1f}%",
                "直近2年披露率": "{:.1f}%"
            })
            
        st.dataframe(
            styled_df, 
            use_container_width=True, 
            hide_index=True,
            height=600,
            column_config={
                "全期間披露率": st.column_config.NumberColumn("全期間披露率", format="%.1f%%"),
                "直近2年披露率": st.column_config.NumberColumn("直近2年披露率", format="%.1f%%")
            }
        )
        
        st.markdown(RARITY_EXPLANATION, unsafe_allow_html=True)
    else:
        st.info("集計にはセットリストデータとライブ履歴データが必要です。")

# --- 4. マイ参戦記録 ---
elif menu == "🎫 マイ参戦記録":
    st.header("マイ参戦記録＆自動楽曲チェックリスト")
    my_attended_lives = load_mylives()

    if not df_lives.empty and not df_setlists.empty:
        st.subheader("参戦したライブを追加")
        live_options = df_lives['表示名'].tolist()
        
        col_sel, col_btn = st.columns([3, 1])
        with col_sel:
            selected_to_add = st.selectbox("検索して選択", [""] + live_options)
        with col_btn:
            st.write("") 
            if st.button("➕ 追加する"):
                if selected_to_add and selected_to_add not in my_attended_lives:
                    my_attended_lives.append(selected_to_add)
                    save_mylives(my_attended_lives)
                    st.success("追加しました！")
                    st.rerun()
                elif selected_to_add in my_attended_lives:
                    st.warning("既に追加されています。")
        
        st.markdown("---")
        
        col1, col2 = st.columns(2)
        with col1:
            st.subheader(f"📝 参戦一覧（計 {len(my_attended_lives)} 公演）")
            if my_attended_lives:
                for live in my_attended_lives:
                    c1, c2 = st.columns([5, 1])
                    with c1: st.write(f"- {live}")
                    with c2:
                        if st.button("削除", key=f"del_{live}"):
                            my_attended_lives.remove(live)
                            save_mylives(my_attended_lives)
                            st.rerun()
            else:
                st.write("まだ登録されていません。")
                
        with col2:
            st.subheader("🎧 現地で聴いた楽曲リスト")
            if my_attended_lives:
                attended_urls = df_lives[df_lives['表示名'].isin(my_attended_lives)]['ライブ情報'].tolist()
                heard_songs_df = df_setlists[df_setlists['ライブ情報'].isin(attended_urls)]
                unique_heard_songs = heard_songs_df['曲名'].dropna().unique().tolist()
                
                official_songs = df_songs['曲名'].dropna().unique().tolist()
                total_songs = len(official_songs)
                official_heard_songs = [song for song in unique_heard_songs if song in official_songs]
                heard_count_official = len(official_heard_songs)
                
                comp_rate = (heard_count_official / total_songs * 100) if total_songs > 0 else 0
                
                st.success(f"**現地で聴いた全楽曲：計 {len(unique_heard_songs)} 曲**")
                st.info(f"🏆 **オリジナル楽曲コンプリート率：{comp_rate:.1f}%** (登録済 {total_songs}曲中 {heard_count_official}曲回収)")

                sort_option = st.radio("楽曲リストの並び順", ["五十音順", "レア度順"], horizontal=True)

                if sort_option == "レア度順":
                    # ソート用の辞書を更新 (RRを追加)
                    rarity_order_mylive = {"UR": 1, "未収録(UR扱い)": 1.5, "SSR": 2, "SR": 3, "RR": 4, "R": 5, "UC": 6, "C": 7}
                    def get_rarity_score(song):
                        if song in official_songs:
                            r = song_rarity_dict.get(song, "C")
                            return rarity_order_mylive.get(r, 7)
                        return rarity_order_mylive["未収録(UR扱い)"]
                        
                    unique_heard_songs.sort(key=lambda x: (get_rarity_score(x), x))
                else:
                    unique_heard_songs.sort()

                with st.expander("楽曲リスト（レアリティ付き）", expanded=True):
                    for song in unique_heard_songs:
                        if song in official_songs:
                            rarity = song_rarity_dict.get(song, "C")
                            color = RARITY_COLORS.get(rarity, "inherit")
                            st.markdown(f"✔️ <span style='color:{color}; font-weight:bold;'>[{rarity}]</span> {song}", unsafe_allow_html=True)
                        else:
                            st.markdown(f"🌟 <span style='color:#ff66b2; font-weight:bold;'>[UR扱]</span> {song} *(カバー・未収録等)*", unsafe_allow_html=True)
            else:
                st.info("ライブを追加するとリスト化されます。")

# --- 5. AIアシスタント ---
elif menu == "🤖 AIアシスタント":
    st.header("緑黄色社会 AIアシスタント")
    api_key = st.text_input("Google Gemini APIキー", type="password")
    
    st.markdown("### 🔮 次回のセトリ予想")
    if st.button("✨ 過去のデータから次回のセトリを予想する"):
        if not api_key:
            st.warning("上にAPIキーを入力してください。")
        else:
            with st.spinner("AIが過去の傾向を分析して予想を作成中..."):
                try:
                    genai.configure(api_key=api_key)
                    model = genai.GenerativeModel('gemini-2.5-flash')
                    prompt = "あなたは緑黄色社会の熱狂的なファンであり、データ分析に基づくセットリスト予想のプロです。最近の楽曲リリースやライブの傾向を踏まえ、次回のツアー初日のセットリスト（全15曲程度）を予想してください。なぜその曲を入れたのかという予想の理由と、ライブ全体の盛り上がりポイントの解説も添えて、ワクワクするようなトーンで教えてください。"
                    response = model.generate_content(prompt)
                    st.success("予想が完了しました！")
                    st.write(response.text)
                except Exception as e:
                    st.error(f"エラーが発生しました: {e}")

    st.markdown("---")
    st.markdown("### 💬 自由入力チャット")
    user_input = st.text_area("質問やプロンプトを自由に入力してください")
    if st.button("AIに送信") and api_key and user_input:
        try:
            genai.configure(api_key=api_key)
            model = genai.GenerativeModel('gemini-2.5-flash')
            system_prompt = f"あなたは緑黄色社会の楽曲やライブ情報に精通したAIアシスタントです。\nユーザーの質問: {user_input}"
            response = model.generate_content(system_prompt)
            st.success("AIからの回答:")
            st.write(response.text)
        except Exception as e:
            st.error(f"エラーが発生しました: {e}")