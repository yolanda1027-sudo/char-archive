# 人物檔案館（char-archive）

SillyTavern（酒館）前端擴充：追蹤聊天中出現過的人物、年齡與外貌變化、經歷時間軸，以及人物之間的關係和看法，並在每輪把相關資料送給主聊天 AI。

## 安裝

1. 酒館上方的「擴充功能」（方塊圖示）→「安裝擴充功能」（Install extension）。
2. 貼上網址：`https://github.com/yolanda1027-sudo/char-archive`
3. 選「只為我安裝」，裝好後重新整理頁面。

如果之前是手動把檔案複製進去的，請先刪掉舊的資料夾再安裝，不然會同時載入兩份。
人物檔存在每個聊天的資料裡，設定存在酒館的擴充設定裡，刪掉擴充資料夾不會不見。

## 更新

「擴充功能」→「管理擴充功能」（Manage extensions）→ 找到人物檔案館，按更新按鈕，再重新整理頁面。
標題旁邊的版本號變了就是更新成功。

## 開發

詳細說明見 [HANDOFF.md](HANDOFF.md)。測試：

```bash
node --check index.js
node tests/mock-run.js
node tests/keep-recent.js
```
