# 紙上彈筆對戰 3D

[haifengli0527/pencil-duel-space](https://github.com/haifengli0527/pencil-duel-space)（MIT）的 Three.js 3D 重製版。

遊戲規則、彈射數學、MQTT 連線訊息格式與原版**完全相同**（常數逐一對照 `pencil.html`），
所以本 3D 版可以和原版 2D 網頁在同一個房間代碼裡連線對戰。

## 玩法

猜拳決先手 → 各放 10 艘船、選一艘旗艦（雙血）→ 輪流按住自己的船往「反方向」拖曳彈射。
航跡掃到敵船扣血；中央小行星帶落點淘汰；衝出邊界被黑洞吞噬；精準降落敵方基地光環內直接獲勝。

## 執行

```bash
cd 3d
python3 -m http.server 8618
```

開 http://localhost:8618 即可。任何靜態伺服器都行（ES modules 不能用 file:// 直開）。
Three.js 由 CDN 載入（jsDelivr，鎖版本 0.181.2），需要網路。

## 結構

- `index.html` — 頁面與樣式（沿用原版太空主題）
- `src/game.js` — 規則、狀態機、彈射數學、手刻 MQTT 3.1.1 客戶端（與原版逐行一致）
- `src/render3d.js` — Three.js 場景：SVG 船艦輪廓擠出成 3D、seed 42 小行星帶、彈射動畫、爆炸粒子
- `src/main.js` — 大廳 / 猜拳 / 狀態列 / 指標事件接線

## 與原版的差異

- 3D 太空場景（透視相機、星空、立體船艦、飛行動畫、爆炸粒子、鏡頭震動）
- 未移植「紙上版」主題（2D 專屬的視覺彩蛋）
- 尊重 `prefers-reduced-motion`：關閉粒子、震動與閒置動畫，彈射動畫縮短

## License

MIT（沿用原專案授權，見 LICENSE）。
