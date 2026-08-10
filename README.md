# BLACK DRAGON WAVE SIMULATOR

Webカメラに向かってジェスチャーすると邪王炎殺黒龍波を撃てるWebアプリ。

## HOW TO USE

Go to https://ryosukedtomita.github.io/black-dragon-wave-simulator/


1. ✊ 拳を握る → チャージ開始。「邪眼の力を舐めるなよ…」が表示され、額に邪眼(第三の目)が開眼、体に黒いオーラをまとい、紫の妖気が手に収束していく(画面も暗転)
2. 🖐 手を開く → 手のひらの向きに黒龍が渦を巻きながら放たれる

---

## For Developer

### localで起動する

```sh
python3 -m http.server 8765
# または
npx serve .
```

### デプロイ(GitHub Pages)

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

