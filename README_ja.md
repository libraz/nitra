# nitra

[![CI](https://img.shields.io/github/actions/workflow/status/libraz/nitra/ci.yml?branch=main&label=CI)](https://github.com/libraz/nitra/actions)
[![License](https://img.shields.io/badge/license-AGPL--3.0-green)](https://github.com/libraz/nitra/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white)](https://react.dev/)
[![Platform](https://img.shields.io/badge/platform-browser%20%7C%20WebGL2-lightgrey)](https://nitra.libraz.net)
[![Demo](https://img.shields.io/badge/demo-nitra.libraz.net-2563eb)](https://nitra.libraz.net)

**nitra は、撮影済みの写真に美顔カメラ相当の加工を後から掛けます。写真は端末から出ません。** ブラウザの中で WebGL2 を使って動き、サーバーはなく、何もアップロードしません。顔解析のモデルもアプリ自身が配信しています。

**[nitra を開く](https://nitra.libraz.net)** · **[ドキュメント](https://github.com/libraz/nitra/blob/main/docs/ja/introduction.md)** · **[はじめかた](https://github.com/libraz/nitra/blob/main/docs/ja/getting-started.md)**

> **状態** — 1.0 前です。レシピ形式はバージョン付きですが、それ以外の画面や操作は変わる可能性があります。

## できること

- **開いて階調を整える** — JPEG・PNG・WebP・AVIF・HEIC を開き、リニアの Display-P3・チャンネルあたり 16bit で処理します。露出、コントラスト、ハイライトとシャドウ、ホワイトバランス、Oklch のクロマとしての彩度、色ごとの色相・彩度・明度、仕上げの効果を扱います。[階調補正](https://github.com/libraz/nitra/blob/main/docs/ja/grading.md)
- **人物を補正する** — 肌、目、唇、歯、頬、髪、背景、あとから足す光 1 灯、それに上限を設けた顔の変形です。変形量は実測して表示します。[人物の補正](https://github.com/libraz/nitra/blob/main/docs/ja/retouching-a-person.md)
- **シミと映り込みを消す** — シミは周囲の肌から埋め、瞳・鏡・ガラスに映り込んだ第三者は置いた円の中だけでぼかします。[シミと映り込み](https://github.com/libraz/nitra/blob/main/docs/ja/blemishes-and-reflections.md)
- **AI 編集で変わった顔を戻す** — 生成 AI の編集で描き直された画像に、元の写真から撮影時の顔を戻します。[顔を戻す](https://github.com/libraz/nitra/blob/main/docs/ja/restoring-a-face.md)
- **構図と文字** — 反転、90 度回転、傾き補正、Instagram・X・Facebook・YouTube・TikTok に合わせたトリミング、手元の任意の書体での文字入れ。[構図と文字](https://github.com/libraz/nitra/blob/main/docs/ja/framing-and-text.md)
- **グリッドに分割する** — 1 枚の絵をプロフィールグリッド用に切り分け、投稿すべき順番をファイル名に入れます。[グリッド分割](https://github.com/libraz/nitra/blob/main/docs/ja/grid-split.md)
- **メタデータを扱う** — 既定では書き出しのたびに削除します。残すことも、項目ごとに書き込むこともでき、ファイルに入るのはパネルに表示した項目だけです。[メタデータ](https://github.com/libraz/nitra/blob/main/docs/ja/metadata.md)
- **結果を見せる** — 写真から提案する初期補正、自分の写真のサムネイルで選ぶ仕上げ、肌の質感の残り具合や顔の移動量の計測、書き出しの 1 画素が画面の 1 画素になるまでの拡大、シンプルと詳細の 2 モード、英語と日本語、ライトとダーク。[画面と操作](https://github.com/libraz/nitra/blob/main/docs/ja/interface.md)

編集は非破壊です。元画像は書き換えず、量はすべて画像に対する比率で持ち、書き出しで拡大はしません。編集はタブの中にしかなく、手元に残るのは書き出したファイルです。

## はじめに

使うだけならインストールは要りません。[nitra.libraz.net](https://nitra.libraz.net) はこのリポジトリと同じビルドを配信しています。写真を開いて調整し、書き出してください。

手元で動かしたり開発したりする場合は次のとおりです。

```bash
bun install
bun run dev        # http://localhost:5173
```

初回は顔解析のモデルを `public/models` に取得します。40MB ほどあり、ダイジェストで固定してあって、リポジトリには入れていません。なくてもアプリは動き、顔まわりの操作は解析が使えないことを表示します。WebGL2 と half-float のレンダーターゲットに対応したブラウザが必要です。Chrome・Edge・Safari・Firefox の最新版で動きます。

```bash
bun run check      # lint とフォーマット
bun run typecheck
bun run test
bun run build      # dist/ に静的ファイルを出力。どの静的ホスティングにも置けます
```

## ドキュメント

- **知る** — [概要](https://github.com/libraz/nitra/blob/main/docs/ja/introduction.md) · [はじめかた](https://github.com/libraz/nitra/blob/main/docs/ja/getting-started.md) · [画面と操作](https://github.com/libraz/nitra/blob/main/docs/ja/interface.md)
- **ガイド** — [階調補正](https://github.com/libraz/nitra/blob/main/docs/ja/grading.md) · [人物の補正](https://github.com/libraz/nitra/blob/main/docs/ja/retouching-a-person.md) · [シミと映り込み](https://github.com/libraz/nitra/blob/main/docs/ja/blemishes-and-reflections.md) · [顔を戻す](https://github.com/libraz/nitra/blob/main/docs/ja/restoring-a-face.md) · [構図と文字](https://github.com/libraz/nitra/blob/main/docs/ja/framing-and-text.md) · [グリッド分割](https://github.com/libraz/nitra/blob/main/docs/ja/grid-split.md) · [メタデータ](https://github.com/libraz/nitra/blob/main/docs/ja/metadata.md)

## 非目標

nitra は補正をしますが、別人にはしません。骨格の作り替え、顔の入れ替え、体型の改変、生成による描き足し、背景の差し替えは扱いません。映り込みのぼかしは消去ではなく、ファイルから何が復元できるかについて nitra は何も主張しません。サーバー、アップロード経路、アカウントは持たず、今後も作りません。動画は当面扱いません。理由は[概要](https://github.com/libraz/nitra/blob/main/docs/ja/introduction.md#非目標)にあります。

## ライセンス

[AGPL-3.0](LICENSE)
