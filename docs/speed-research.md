# Flash 变速研究记录

本文记录小竹 Flash 浏览器在 macOS 上实现变速时的发现、失败现象和后续方向。当前结论是：变速功能暂时封印，普通版本优先保证游戏稳定。

## 当前状态

- macOS 正式启动默认加载 `PepperFlashPlayerSpeed.plugin`，但每次启动都先回到 `1x`，避免上次加速影响登录。
- 默认正式档位是第 6 档 `弹弹堂推荐（Tick + mach）`。这是当前测试里能变速、又避开 wall-clock 卡死路径的保守默认。
- `scripts/sync-to-app.sh` 默认会构建并同步 `PepperFlashPlayerSpeed.plugin`。如需强制原始 Flash，可用 `BUILD_SPEED_SHIM=0 scripts/sync-to-app.sh` 或启动参数 `--xz-no-speed-mode`。
- 速度源码保留在 `app/ppapi_speed_shim.c` 和 `app/xzspeed.c`。
- 实验模式现在会写诊断文件：`/tmp/xzflash-speed-diag-$(id -u).json`。里面记录 Flash 实际命中的时间/调度符号、调用次数，以及是否被当前 profile 改写。
- 用户测试显示：第 3 档会让游戏界面切换变快；第 4 档能实现变速；第 5 档也能变速运行；旧第 6 档墙上时间源会直接卡住。
- 因此主线改为避开 wall-clock：第 6 档现在是弹弹堂推荐组合 `Tick + mach`；第 7/8 档也不再包含墙上时间源；wall-clock 只保留为第 9 档危险诊断。
- 第 8 档 `Safe native + cautious schedule` 会额外尝试保守调度加速：`dispatch_time`、`dispatch_source_set_timer`、`nanosleep`、`usleep`、`pthread_cond_timedwait*` 可缩短等待；`poll/select` 只有在没有 fd 的纯 sleep 用法下才缩短，避免把网络等待一起加速。
- 继续研究时需要显式运行：

```bash
scripts/sync-to-app.sh
open -n /Applications/小竹Flash浏览器.app
```

## Windows 样本观察

糖果浏览器：

- `TGClock.dll` 导入了 `QueryPerformanceCounter`、`GetTickCount`、`Sleep`。
- 字符串里出现 `NtHookEngine.dll`、`HookFunction`、`UnhookFunction`。
- 判断它更接近 Windows 经典做法：在浏览器或 Flash 进程中 hook 原生时间 API。

36 脚本大厅：

- 安装包内有 WKE/MiniBlink 相关接口，如 `wkeCreateWebView`、`wkeRunJS`、`wkePaint`、`wkeSetMediaVolume`、`wkeLimitPlugins`。
- 压缩 DLL 中能看到 `timeSetEvent`。
- 判断它是游戏专用浏览器壳，结合浏览器内核、插件控制和计时接口优化。

## macOS 实验结果

已尝试的方向：

- PPAPI 层包装 `PPB_Core.GetTime` / `GetTimeTicks`。
- PPAPI 层包装 `CallOnMainThread` / `PPB_MessageLoop.PostWork`。
- 原生层重绑定 `mach_absolute_time`、`TickCount`、`clock_gettime`、`gettimeofday`、`time`、`CFAbsoluteTimeGetCurrent`。
- 原生层继续重绑定 `dispatch_time`、`dispatch_source_set_timer`、`pthread_cond_timedwait_relative_np`、`pthread_cond_timedwait`、`nanosleep`、`usleep`、`poll`、`select$1050`。
- 从 1 到 8 档拆分不同时间源，便于逐档测试。

测试现象：

- 温和 PPAPI 档位对弹弹堂没有明显变速。
- 早期强力原生钩子能看到一瞬间加速，但很快画面卡住。
- 后续 1 到 8 档在用户测试中没有稳定产生可用变速。

推断：

- 弹弹堂真正依赖的时间源可能不在 PPAPI 浏览器接口层。
- Flash 内部时间源被粗暴加速时，游戏逻辑、渲染、网络心跳或 worker 调度可能一起被扰乱。
- M 系列 Mac 上整条 Flash 路径是 x86_64 Rosetta，原生 hook 更脆弱。

## 当前测试办法

1. 同步正式版并打开：

```bash
scripts/sync-to-app.sh
open -n /Applications/小竹Flash浏览器.app
```

2. 打开弹弹堂或其他 Flash 游戏，正式默认先用第 6 档。建议每个档位先用 `1.1x`，稳定后再试 `1.25x`、`1.5x`。第 9 档 wall-clock 已不放在正式菜单里，只用于手工诊断。

3. 玩 30 秒后查看诊断文件：

```bash
cat /tmp/xzflash-speed-diag-$(id -u).json
```

重点看：

- `calls > 0`：说明 Flash 确实命中了这个符号。
- `changed > 0`：说明当前 profile 实际改写了这个符号。
- `dispatch_*`、`nanosleep/usleep`、`pthread_cond_timedwait*` 是否有大量调用：这会决定下一步是否继续往调度方向推进。

## 后续方向

优先考虑低风险诊断，而不是继续硬加速：

- 根据诊断文件确认 Flash 是否主要依赖调度、原生 tick，还是 PPAPI 时间。
- 尝试帧限幅：虚拟时间不持续快跑，而是限制每次最大推进量。
- 尝试只影响 ActionScript `getTimer` 相关路径，避免影响网络、SSL、等待和调度。
- 将实验日志显示到菜单或诊断页，避免靠体感猜测。

## 不再默认启用的原因

变速实验目前对游戏稳定性收益不明确，且存在黑屏、定格、登录失败等风险。小竹浏览器当前目标是先成为稳定、流畅、好用的 Flash 游戏浏览器；变速作为研究项保留，但不进入普通用户路径。
