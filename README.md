# wanzan-jisooclick

JISOO《CLICK》专辑预售销量追踪站,由 wanzan 制作。

- `index.html` — 网站本体,GitHub Pages 直接托管这个文件
- `data.json` — 销量数据,`scripts/scrape.js` 每小时自动追加一条新记录
- `.github/workflows/hourly-scrape.yml` — 定时任务配置,每小时整点跑一次抓取并自动提交

## 首次发布步骤

1. 在这个仓库的 Settings → Pages 里,Source 选 `main` 分支、`/ (root)` 目录,保存
2. 等 1-2 分钟,页面顶部会出现绿色的访问链接
3. Settings → Actions → General 里确认 "Workflow permissions" 设置为
   "Read and write permissions"(定时任务需要这个权限才能自动提交 data.json)
4. 之后完全自动:每小时整点抓取一次,追加进 `data.json`,网站会自动显示最新数据

## 手动立刻跑一次

仓库上方 **Actions** 标签页 → 左侧选 "Hourly sales scrape" → 右侧 **Run workflow** 按钮,
不用等到下一个整点。

## 密码

网站需要密码才能查看,密码是发布时设定好的那个,忘记了找 wanzan。
