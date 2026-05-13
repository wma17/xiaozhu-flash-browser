# 小竹Flash浏览器

小竹Flash浏览器是一个面向 macOS 经典 Flash 网页游戏的 Electron 浏览器壳，重点是：

- 独立档案：每个档案隔离 Cookie、localStorage 和缓存，适合小号多开。
- Flash 游戏优化：保留 PPAPI Flash 支持，并默认启用安全变速代理。
- 弹弹堂变速：正式默认使用第 6 档 `Tick + mach` 推荐组合；启动时固定回到 `1x`，避免上次加速影响登录。
- 多开优化：关闭后台节流、减少后台服务，并提供窗口网格排列和账号网格打开。
- 游戏模式：压缩浏览器 UI，把更多屏幕空间留给游戏。
- 账号中心：保存游戏、网址、账号、档案、备注和默认速度，支持批量打开。
- 游戏工具：在游戏页集中提供修复当前页、截图、选择档案多开、便签显示、全局静音和标签静音。
- 游戏医生：一键清理当前档案、重置速度/缩放、忽略缓存刷新，也可清理全部档案。
- 账号辅助：检测登录表单、保存账号密码、同站点多账号选择填充。
- 主题系统：内置小竹原生、晨雾竹影、暖橙、Flash 档案馆、狼麦旅人、焙茶庭院、雾蓝、月下模式、怀旧游戏厅、macOS 石墨和自定义主题。

> 注意：Adobe Pepper Flash 插件和 Electron 运行时不放进仓库。仓库保存小竹浏览器的应用源码与构建/同步脚本。

## 目录

- `app/`：Electron 应用源码，会同步到 `.app/Contents/Resources/app`。
- `app/ppapi_speed_shim.c`：PPAPI Flash 变速代理插件源码。
- `app/xzspeed.c`：macOS 原生时间/调度 hook 源码，配合 PPAPI 代理使用。
- `scripts/sync-to-app.sh`：把 `app/` 同步到本机应用包并重新签名。
- `scripts/build-speed-shim.sh`：构建 `PepperFlashPlayerSpeed.plugin`。
- `scripts/build-dmg.sh`：从本机 `.app` 生成 `dist/` 下的 DMG 和 SHA256。
- `docs/theme-system.md`：主题 ID、主题 token 和后续主题资产接入说明。
- `docs/speed-research.md`：变速研究记录、失败现象和后续方向。

## 本机开发

```bash
scripts/sync-to-app.sh
open -n /Applications/小竹Flash浏览器.app
```

同步脚本默认会构建并加载变速代理。若需要强制回到原始 Flash，可运行：

```bash
BUILD_SPEED_SHIM=0 scripts/sync-to-app.sh
open -n /Applications/小竹Flash浏览器.app --args --xz-no-speed-mode
```

## 打包

```bash
scripts/sync-to-app.sh
scripts/build-dmg.sh
```

生成文件示例：

- `dist/XiaozhuFlashBrowser-macOS-v1.5.0.dmg`
- `dist/XiaozhuFlashBrowser-macOS-v1.5.0.dmg.sha256`

`dist/` 不进入 Git 仓库，发布包请上传到 GitHub Release。

## 测试建议

1. 打开弹弹堂，先用第 6 档从 `1.1x` 开始测，稳定后再试 `1.25x`、`1.5x`。
2. 在「账号中心」给不同账号绑定不同档案，测试单开、批量打开和网格打开。
3. 三开或四开后在「窗口」页点「网格排列」，确认窗口能自动铺开。
4. 登录或加载异常时先用「游戏医生」的「重置当前标签」；仍异常再用「一键修复」。
5. 在游戏页点「工具」，测试截图保存、选择档案多开、便签显示/隐藏、全局静音和标签静音。
