# 小竹Flash浏览器 1.6.2 变更说明

日期：2026-09-05　基线：1.6.1 → 1.6.2
性质：第三方审查（2026-09-04）逐条核对属实后的第一批修改。全部改动只做过静态验证（语法、i18n 对称、契约复核、独立代理复审），没有真机启动过。

## 备份与回滚

应用包内：`app/_backup_20260904_234311_pre_batch2/`（改前全部顶层 js/css/html/c/json 和 Info.plist）。
变速插件：`app/plugins/PepperFlashPlayerSpeed.plugin.bak-20260904_234311`（本次没有重编译，插件二进制没变，这份备份只是保险）。
仓库：工作区未提交，`git diff` 能看到全部改动；`git checkout -- app scripts` 即回到 c21b13b。

整体回滚：

```
cp "/Applications/小竹Flash浏览器.app/Contents/Resources/app/_backup_20260904_234311_pre_batch2/"*.{js,css,html,c,json} \
   "/Applications/小竹Flash浏览器.app/Contents/Resources/app/"
cp "/Applications/小竹Flash浏览器.app/Contents/Resources/app/_backup_20260904_234311_pre_batch2/Info.plist" \
   "/Applications/小竹Flash浏览器.app/Contents/"
```

注意：仓库里有一个空的 `.git/index.lock`（远程会话跑 `git status` 时留下、没有删除权限），先 `rm .git/index.lock` 再用 git。

## 一、多开：新账号后台加入，不抢当前账号

`createTab(url, opts)` 新增 `opts.background`：为 true 时不激活新标签、不切路由（窗口里已有活动标签时才生效，避免空窗）。焦点模式的 `onTabCreated` 仍在建标签时同步调用，后台标签照样拿到槽位。

焦点模式加号（`openProfiles`）从「每 700ms 硬开一个、每个都抢焦点、最后才切回」改成串行：建一个，等它的 webview `did-stop-loading`（或 15 秒超时），再建下一个；全程 `background: true`，正在打的账号不会被切走。结束后只做保险：当前账号不是原来那个时才切回。

账号中心非网格批量打开：原来 renderer 用 700ms 节拍逐个 `window:open`，现在一次 `window:open-accounts` 交给主进程已有的 `openWindowsSequentially`（等 `window:ready`，20 秒超时），和网格打开走同一条队列。

会话恢复（session-client.js）：第一个标签同步建并激活（`window:ready` 靠它），后续标签 `background: true`，每个等 `did-stop-loading` 或 8 秒超时再建下一个；拿不到 webview 时退回原来的 `scatterMs()` 节拍。

## 二、打开设置、便签等页面时游戏不再暂停

根因核对：`#webviews-container` 是 `#route-browser` 的子元素，切走路由时 `.route { display:none }` 把游戏一起藏了，Flash 随即降频。原 `visibility` 切换只是表象。

新行为：`#route-browser` 在非活动时保持 `display:block; z-index:0`；其它路由页 `.route.active` 取 `z-index:1` 并画不透明底（照抄 `body::before` 的三层渐变，锚在 `#main`），游戏被盖住但持续全速运行。`body::before` 的装饰层在新行为下关闭（被不透明路由页盖住后看不见，只会空跑动画）。

键盘：进入非浏览路由时若焦点在 webview 上则 `blur()`；从非浏览路由切回时 `focusActiveGame()`（`webview.focus()` + `xz:focus-game`），只在路由真的变化时触发一次。

逃生门：设置文件里手写 `"pauseGamesOffRoute": true` 即回到旧行为（含视觉），没有设置界面。

## 三、变速插件 C 源码（未重编译）

`xzspeed.c`：新增 `g_diag_enabled`，只有环境变量 `XZFLASH_SPEED_DIAG=1` 时才开启诊断；`diag_record()` 和 `flush_diag()` 第一句就短路，关闭时不拿锁、不计数、不写盘。诊断文件名带进程号（`/tmp/xzflash-speed-diag-<uid>-<pid>.json`，走 `XZFLASH_SPEED_DIAG_FILE` 时追加 `.<pid>`），多个插件进程不再互相覆盖。
`xzspeed.c` / `ppapi_speed_shim.c`：文件降级读取的 `if (ok != 1) return;` 改为 `if (ok < 1) return;`。主进程写的是「倍率 模式」两个字段，原判定会拒掉有效记录（只影响 notify 通道不可用时的退路）。
`scripts/build-speed-shim.sh`：重建前先把现有 `PepperFlashPlayerSpeed.plugin` 复制为 `.bak-<时间>`；`trap EXIT` 在失败时自动恢复原插件；成功时打印备份路径、不删备份。

这些改动没有生效：远程环境是 Linux，编不了 Mach-O。要在 Mac 上执行 `scripts/build-speed-shim.sh` 才会替换插件。执行前确认 `xcode-select -p` 有效；脚本自己会备份并在失败时回滚。首次构建（插件不存在）时失败不会回滚。

## 四、界面修复

`aspect-ratio` 在 Chromium 87 不支持（88 才有），五处比例盒塌成细条。加 `@supports not (aspect-ratio: 16/10)` 回退：首页卡片封面与库卡片封面用零宽 `::before` 撑高（里面有内容，不能用 padding 方案）；主题预览、游戏医生插画用 `height:0; padding-top`；占位插画固定 `height:160px`（其宽度不是 100%，百分比 padding 算不对）。88+ 引擎完全不受影响。

首页「继续」和最近记录点击时带上历史条目里的 profileId（`resolveTabProfile` 优先用显式 profileId），同站多账号/多区服不再认错档案。收藏没有 profileId 字段，行为不变。

历史标题：`recordHistory` 在导航时写入，那时标题还是上一页的或「Loading…」。现在 `did-navigate` 置 `tab.titleStale`，写历史时标题未到就先记 URL，`page-title-updated` 再回写真标题并刷新首页/最近视图。

状态条：主框架 `did-fail-load` 后紧跟的 `did-stop-loading` 不再把状态覆盖成正常（`__xzLoadFailed`）。

## 五、文案与保护

标签上的移窗按钮 title 改为「移到新窗口（会重新加载）」；`detachTab()` 内置确认「移到新窗口会重新加载这个页面，正在进行的对局会中断。继续？」，菜单项和命令面板同一入口自动继承；「散开到多窗口并平铺」自己已确认过，传 `{confirmed:true}` 不重复弹。

「挂起其它账号」实际只是 `win.minimize()`，改名「最小化其它窗口」，toast 注明「游戏仍在运行」；「全部还原」改「还原所有窗口」。键名不变。命令面板兜底文案与关键词同步。

状态条「正常」改「页面已加载」（它只表示页面加载结束，不代表游戏长连接在线）；「GPU」改「GPU进程」（那一项是 GPU 进程的 CPU 时间）。

快捷键录制拒绝没有 ⌘/⌥/⌃ 的裸键（空格、方向键、单个字母或数字、Enter、Tab；只加 Shift 也算裸键；F1–F12 允许），toast 提示「这个按键会直接进游戏」。转发和匹配逻辑不变。

## 六、真机验证清单（按重要性）

1. 能开；⌘Q 后重开能恢复会话。开一个 5–6 标签的快照：标签应一个接一个较快出现，而不是恒定每 8 秒一个。若是后者，说明非焦点模式下 `display:none` 的后台 webview 不触发 `did-stop-loading`，把 `session-client.js` 里 `makeTab(plan.tabs[i], true)` 的第二参改回 `false`。
2. 焦点模式里点加号加 2–3 个账号：当前账号全程不被切走，方向键一直进当前账号；新账号逐个出现在条带。
3. 打开便签停 10 秒再切回：游戏动画没停、不追帧；停留时按方向键不进游戏；切回后不点游戏直接按方向键人物就动。焦点模式下再来一次。
4. 首页封面、主题预览、游戏医生插画的比例正常。逐个主题看设置页/首页底色和以前一致（glass、lively 两类主题重点看）。
5. 浏览路由开竞技辅助测量层，确认不受影响。
6. 变速：跑 `scripts/build-speed-shim.sh`，看编译无警告、变速 1→2→3→10→1 切换正常；`~/ddt-crash.log` 或 stderr 里应有 `[xzspeed] active in pid ... diag (off)`。

## 七、没做的（留给下一批）

倍速快速入口按 1x/2x/3x 重排、临时倍速；参战标签锁定（防误关/误刷新）；设置页分组重排；Tab 键仍可能把焦点走进被盖住的 webview；`crashed`/`plugin-crashed` 之后的 `did-stop-loading` 仍会覆盖成正常；Flash 嵌入参数（wmode/quality）实验需要先在真实游戏页看现状。
