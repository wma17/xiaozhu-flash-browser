# Flash 变速研究记录

本文记录小竹 Flash 浏览器在 macOS 上实现变速时的发现、失败现象和后续方向。当前结论是：变速功能暂时封印，普通版本优先保证游戏稳定。

## 当前状态

- 普通启动只加载原始 `PepperFlashPlayer.plugin`。
- 变速按钮在普通界面隐藏。
- `scripts/sync-to-app.sh` 默认不会构建 `PepperFlashPlayerSpeed.plugin`。
- 实验源码仍保留在 `app/ppapi_speed_shim.c` 和 `app/xzspeed.c`。
- 继续研究时需要显式运行：

```bash
BUILD_SPEED_SHIM=1 scripts/sync-to-app.sh
open -n /Applications/小竹Flash浏览器.app --args --xz-speed-mode
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
- 从 1 到 8 档拆分不同时间源，便于逐档测试。

测试现象：

- 温和 PPAPI 档位对弹弹堂没有明显变速。
- 早期强力原生钩子能看到一瞬间加速，但很快画面卡住。
- 后续 1 到 8 档在用户测试中没有稳定产生可用变速。

推断：

- 弹弹堂真正依赖的时间源可能不在 PPAPI 浏览器接口层。
- Flash 内部时间源被粗暴加速时，游戏逻辑、渲染、网络心跳或 worker 调度可能一起被扰乱。
- M 系列 Mac 上整条 Flash 路径是 x86_64 Rosetta，原生 hook 更脆弱。

## 后续方向

优先考虑低风险诊断，而不是继续硬加速：

- 在实验模式中加入“实际命中的符号统计”，确认 Flash 是否调用了被 hook 的函数。
- 只记录不修改，先确认 `TickCount`、`mach_absolute_time`、`clock_gettime` 的调用频率。
- 尝试帧限幅：虚拟时间不持续快跑，而是限制每次最大推进量。
- 尝试只影响 ActionScript `getTimer` 相关路径，避免影响网络、SSL、等待和调度。
- 将实验日志显示到菜单或诊断页，避免靠体感猜测。

## 不再默认启用的原因

变速实验目前对游戏稳定性收益不明确，且存在黑屏、定格、登录失败等风险。小竹浏览器当前目标是先成为稳定、流畅、好用的 Flash 游戏浏览器；变速作为研究项保留，但不进入普通用户路径。
