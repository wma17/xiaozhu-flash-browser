# 小竹Flash浏览器

小竹Flash浏览器是一个面向 macOS 经典 Flash 网页游戏的 Electron 浏览器壳，重点是：

- 独立档案：每个档案隔离 Cookie、localStorage 和缓存，适合小号多开。
- Flash 游戏优化：保留 PPAPI Flash 支持，默认关闭破坏性注入。
- 实验变速：普通模式稳定优先；实验模式通过 PPAPI 代理插件包装 `PPB_Core` 时间接口。
- 游戏模式：压缩浏览器 UI，把更多屏幕空间留给游戏。
- 账号辅助：检测登录表单、保存账号密码、同站点多账号选择填充。

> 注意：Adobe Pepper Flash 插件和 Electron 运行时不放进仓库。仓库保存小竹浏览器的应用源码与构建/同步脚本。

## 目录

- `app/`：Electron 应用源码，会同步到 `.app/Contents/Resources/app`。
- `app/ppapi_speed_shim.c`：实验变速的 PPAPI 代理插件源码。
- `app/xzspeed.c`：旧的 DYLD interpose 实验源码，保留供研究，不默认使用。
- `scripts/sync-to-app.sh`：把 `app/` 同步到本机应用包并重新签名。
- `scripts/build-speed-shim.sh`：构建实验变速代理插件。

## 本机开发

```bash
scripts/sync-to-app.sh
open -n /Applications/小竹Flash浏览器.app
```

实验变速模式：

```bash
/Applications/小竹Flash浏览器.app/Contents/MacOS/小竹Flash浏览器 --xz-speed-mode
```

普通启动不会启用实验变速，确保 4399 等 Flash 游戏优先稳定加载。
