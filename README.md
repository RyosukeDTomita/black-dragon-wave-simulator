# 邪王炎殺黒龍波

Webカメラに向かってジェスチャーすると邪王炎殺黒龍波を撃てるWebアプリ。
ビルド不要の素のJS(ES Modules)で動く。

## 使い方

カメラを使うためHTTPS or localhostで配信する必要がある。ローカルなら:

```sh
python3 -m http.server 8765
# または
npx serve .
```

ブラウザで http://localhost:8765 を開き、「起動する」を押してカメラを許可する。

1. ✊ 拳を握る → チャージ開始。「邪眼の力を舐めるなよ…」が表示され、額に邪眼(第三の目)が開眼、体に黒いオーラをまとい、紫の妖気が手に収束していく(画面も暗転)
2. 🖐 手を開く → 手のひらの向きに黒龍が渦を巻きながら放たれる
   - 手のひらを画面の横方向へ向ければその方向へ飛んでいく
   - 手のひらをカメラへ向ければ黒龍が渦を巻きながら手前へ迫ってきて、画面に着弾(フラッシュ+衝撃)

チャージが短すぎる(0.45秒未満)と不発になる。発射後は約1秒のクールダウンあり。
邪眼は黒龍が飛び終わると閉じ、再チャージで再び開眼する。
黒龍が飛び終わると画面が一度ブラックアウトしてから明ける。
Escキーでスタート画面に戻る(カメラ停止。再起動時にモデルの再ダウンロードはしない)。

## 構成

| ファイル | 役割 |
| --- | --- |
| `index.html` | ページ構造(video + canvasオーバーレイ) |
| `style.css` | 鏡映し表示・セリフ/技名の演出・起動オーバーレイ |
| `app.js` | 手・顔・人物の検出、ジェスチャー判定、黒龍・邪眼・オーラ・パーティクル描画、効果音 |
| `.github/workflows/deploy.yml` | GitHub Pagesへのデプロイ |
| `aqua.yaml` | CLIツール管理(pinact / ghalint) |

## デプロイ(GitHub Pages)

mainブランチへのpush(または手動実行)で`.github/workflows/deploy.yml`が動き、
`index.html` / `style.css` / `app.js` をGitHub Pagesへデプロイする。
リポジトリのSettings → PagesでSourceを「GitHub Actions」にしておくこと。
パスはすべて相対参照なので`https://<user>.github.io/<repo>/`のサブパス配信でそのまま動く。

ワークフローは[pinact](https://github.com/suzuki-shunsuke/pinact)でアクションをコミットSHAに固定し、
[ghalint](https://github.com/suzuki-shunsuke/ghalint)のポリシーチェックを通している。
ツールは[aqua](https://aquaproj.github.io/)で管理:

```sh
aqua install
aqua exec -- pinact run --check
aqua exec -- ghalint run
```

## 技術

- 検出はすべて[MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/vision)(`@mediapipe/tasks-vision`をCDNから読み込み、モデルは初回にダウンロード)
  - 手: HandLandmarker(21ランドマーク)
  - 顔: FaceLandmarker — 眉間(9)と額上部(10)の間に邪眼を描画、傾きは両目の外眼角(33, 263)から算出。サイズは片目(目尻33〜目頭133)と同程度
  - 人物: ImageSegmenter(セルフィーセグメンテーション) — チャージ中のみ実行し、シルエットをぼかして重ねることで黒いオーラに
- ジェスチャー判定: 4指それぞれの指先と第2関節の手首からの距離比で伸展を判定(全て屈曲=拳、3本以上伸展=開手)
- 手のひらの向き: 手のひら三角形(手首・人差し指付け根・小指付け根)の見かけ面積と手の長さの比から「カメラ正面向き度」を推定。正面向きほど黒龍が手前へ迫る挙動になる
- 黒龍の軌道: 進行する渦中心の周りを高速回転しながら半径が広がる螺旋。正面向きのときは指数的に拡大して着弾演出
- エフェクト: Canvas 2Dの自前実装(黒龍のトレイル、黒炎パーティクル、衝撃波リング、画面揺れ・暗転・着弾フラッシュ・発射終了時のブラックアウト)
- 効果音: WebAudioで生成(チャージ=ローパスノイズ、発射=ノイズバースト+のこぎり波スイープ)。音声ファイル不使用

外部への依存はMediaPipeのCDN読み込みのみ。カメラ映像はブラウザ内で処理され、外部送信されない。
# black-dragon-wave-simulator
