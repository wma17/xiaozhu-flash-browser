# 小竹浏览器主题系统

这一版把 UI 从固定暖橙色升级为主题 token，并接入当前主题资产。主题会切换颜色和主题预览图；侧栏 badge、左下角艺术位和关于页徽章使用统一的新狼麦视觉，以保证所有主题的基础品牌质感一致。

## 已预置主题

| ID | 名称 | 定位 |
| --- | --- | --- |
| `xiaozhu-native` | 小竹原生 | 默认主版本。竹青、米白、浅木色，清爽耐看。 |
| `bamboo-morning` | 晨雾竹影 | 轻竹青、柔米白和晨光金，更低饱和。 |
| `orange-special` | 暖橙 | 奶油橙与焦糖棕，保留温度但不再指向小橙子版本。 |
| `flash-archive` | Flash 档案馆 | 旧纸、铜金、收藏库气质。 |
| `wolf-wheat` | 狼麦旅人 | 麦穗金、旅人斗篷、角色陪伴感；包含新版侧栏徽章和左下角吉祥物。 |
| `tea-garden` | 焙茶庭院 | 焙茶棕、旧纸色和低饱和庭院绿。 |
| `mist-blue` | 雾蓝 | 雾面蓝灰与柔和铜色点缀，更冷静、干净。 |
| `moonlight` | 月下模式 | 深灰绿与琥珀点缀，夜间护眼。 |
| `arcade-night` | 怀旧游戏厅 | 深色霓虹改成低饱和深靛、青蓝与玫瑰色。 |
| `graphite` | macOS 石墨 | 银灰、蓝灰、专业工具感。 |
| `custom` | 自定义 | 用户在设置里选择颜色、上传徽章/吉祥物，并进行缩放、裁切和透明化。 |

## 实现方式

- 主题颜色定义在 `app/index.html` 的 `:root[data-theme="..."]` 中。
- 主题资产放在 `app/assets/themes/`，文件名沿用 `badge-*`、`mascot-*`、`theme-preview-*`、`empty-*`。
- 全主题共用 `badge-wolf-wheat-browser.png` 和 `mascot-wolf-wheat-tiny-footer.png`，通过 CSS token 调整透明度、混合模式和阴影，让侧栏艺术位融入当前主题色，而不是被卡片框住。
- 当前主题保存在 `settings.theme`。
- 启动时由 `renderer.js` 的 `applyTheme()` 写入 `document.documentElement.dataset.theme`。
- 设置页的「外观」区域由 `renderThemeGrid()` 动态生成主题卡片。
- 设置页外观区域默认折叠，只显示当前主题摘要；展开后可以切换主题或编辑 `custom`。
- 自定义主题保存在 `settings.customTheme`，颜色以 hex 存储，上传图像会在前端 canvas 中输出为透明 PNG data URL。
- 首页右下角有低透明度角色插图，用来让更多角色资产自然出现；它不参与交互，也不占用布局。
- 空状态插图由 `placeholderHtml()` 统一渲染，默认也切换到新的狼麦插图素材，避免旧主题下继续出现不协调的旧图。
- 侧栏导航图标使用 `app/assets/icons/nav-*.svg` 作为 CSS mask，由主题色实时上色。
- `wolf-wheat` 的原图来自纯色背景素材，本地后处理成 RGBA cutout；主题预览保持完整背景。
- 文案在 `app/i18n.js` 中维护中英双语。

## 下一步

1. 用主题图继续精修首页、游戏库卡片和关于页。
2. 给特别主题补齐更多空状态和工具页插图。
3. 后续如需继续大批量引入新资产，再单独新增生产 brief。
