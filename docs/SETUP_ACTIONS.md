# GitHub に載せる手順（開発者が行う）

この手順は、公開の前の点検（コミットの作者のアドレス）が済んでから行ってください。

## 1. GitHub にリポジトリを作って push する

```
cd ~/machi-no-ashi-karte
git remote add origin https://github.com/<あなたのアカウント>/machi-no-ashi-karte.git
git push -u origin main
git push origin site        # 見に行った記録（main と履歴が分かれたブランチ）
```

リポジトリを公開にするのは、ここで行ってください。

## 2. Secrets に連絡先を入れる（GTFS_CONTACT）

1. GitHub のリポジトリの画面で **Settings** を開く
2. 左の **Secrets and variables** → **Actions** を開く
3. **New repository secret** を押す
4. Name に `GTFS_CONTACT`、Secret に User-Agent に入れる連絡先（メールアドレス）を入れて **Add secret**

- Secrets の値は、リポジトリを公開にしても、ほかの人からは見えません。
- Actions のログに値が出そうになると、GitHub が `***` に伏せ字にします。
- スクリプトも、連絡先をログに書きません（User-Agent を作るときに使うだけです）。
- fork されたリポジトリからの pull request の実行には、Secrets は渡りません。

## 3. GitHub Pages を「GitHub Actions から出す」にする

1. **Settings** → **Pages** を開く
2. **Build and deployment** の **Source** を **GitHub Actions** にする

（ブランチからの公開ではなく、workflow の中で `site` の中身をそのまま Pages に出します。）

## 4. workflow を置く（了承のあと）

```
mkdir -p .github/workflows
git mv docs/workflow-draft/daily-watch.yml .github/workflows/daily-watch.yml
git commit -m "見に行く仕組みを Actions に載せる"
git push
```

1. **Actions** タブで `daily-watch` を開き、**Run workflow** で手で1回動かす
2. 成功したら、`https://<あなたのアカウント>.github.io/machi-no-ashi-karte/` でアプリが開き、画面の下に「時刻表を最後に確かめた日時」が出ることを確かめる
3. そのあとは、6時間ごと（日本時間 3:17／9:17／15:17／21:17）と、日曜 3:47 の点検で、自動で動く

## 5. 止まっていないかを見る

- アプリの画面の下の「時刻表を最後に確かめた日時」が2日以上前になると、「しばらく確かめられていません」と出ます。
- `site` ブランチの `state/runs.csv` に、実行ごとのリクエスト数・新しい版の数・エラーの数が残ります。
- workflow が失敗すると、GitHub から通知が届きます（通知の設定による）。
