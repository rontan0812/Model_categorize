# Model Categorize

フォルダ内の 3D モデルファイルを一覧・プレビューしながら、チームで決めたラベルを手動で付けていく Web アプリです（Next.js / Vercel 向け）。

## できること

- **フォルダ選択**: ブラウザでフォルダを選ぶと、サブフォルダも含めて 3D モデルを一覧表示
  - 対応形式: `.stl` `.obj` `.fbx` `.gltf` `.glb` `.ply` `.3mf` `.dae`
  - ファイルはアップロードされません。ブラウザ内だけで読み込み、保存されるのは「パス」と「ラベル」のみ
- **3D プレビュー**: 回転・ズーム、ワイヤーフレーム表示、頂点数・ポリゴン数・サイズ表示
  - glTF の `.bin` やテクスチャ、OBJ の `.mtl` も同じフォルダから自動で読み込み
- **ラベル管理**: 自由に作成・名前変更・色変更・削除
- **ラベル付け**: 1 ファイルずつ、またはチェックした複数ファイルにまとめて付け外し
- **絞り込み**: ラベル（複数選択で AND）、未ラベルのみ、ファイル名検索
- **出力**: CSV（Excel で開ける）/ JSON 出力、JSON 取り込み

### キーボード操作

| キー | 動作 |
|---|---|
| ↑ ↓ / j k | ファイルを移動 |
| 1〜9 | ラベルの付け外し（ラベル一覧の上から順） |
| Space | チェックの切り替え |

## 保存先

| 状態 | 保存先 |
|---|---|
| Upstash Redis を接続済み | サーバー（チーム全員で共有。15 秒ごと・画面に戻った時に他の人の変更を反映） |
| 未接続 | 各自のブラウザ（localStorage）。JSON 出力/取込で受け渡し可能 |

画面右上のバッジ（「チーム共有」/「このブラウザのみ保存」）でどちらか確認できます。

ラベルはファイルの「選んだフォルダ名から始まる相対パス」（例: `models/chars/hero.stl`）に紐づきます。チームで共有する場合は、全員が同じ名前のフォルダを選ぶようにしてください。

## ローカルで動かす

```bash
npm install
npm run dev
# http://localhost:3000
```

共有保存を試す場合は `.env.example` を `.env.local` にコピーして Upstash の URL / トークンを設定します。

## Vercel へのデプロイ

1. Vercel で このリポジトリを Import（設定はデフォルトのままで OK）
2. プロジェクトの **Storage** タブ → **Marketplace** から **Upstash (Redis)** を作成してプロジェクトに接続
   - `KV_REST_API_URL` / `KV_REST_API_TOKEN` が自動で設定されます
3. 再デプロイ

※ URL を知っている人は誰でもラベルを編集できます。アクセスを制限したい場合は Vercel の Deployment Protection（パスワード保護など）を使ってください。

## 構成

```
app/
  page.tsx                 画面
  api/status/route.ts      共有ストレージの有無
  api/labels/route.ts      ラベルの取得・作成/更新・削除
  api/assignments/route.ts ファイル→ラベルの割り当て
components/
  App.tsx                  メイン UI
  ModelViewer.tsx          three.js による 3D プレビュー
lib/
  models.ts                3D ファイルの読み込み
  store.ts                 Redis への保存（サーバー側）
  client-store.ts          保存先の切り替え（サーバー / localStorage）
```
