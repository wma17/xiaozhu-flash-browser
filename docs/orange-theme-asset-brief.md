# 小橙子定制主题素材需求

本文档用于交给设计师制作“小橙子”定制版浏览器主题素材。目标是把浏览器从现有“竹小春三零 + 赫萝/暖色”方向，定制成以“小橙子”和她的三个游戏角色为核心的橙金魔女旅行主题。

## 主题方向

- 主题名建议：小橙子 Flash 浏览器 / 小橙子魔女旅行主题。
- 关键词：橙子、好运、发财、魔女、公会、旅行、金币、星星、邮票、怀表、魔法书。
- 主色建议：橙金、奶油白、暖棕。
- 辅助色建议：玫瑰红用于“好运小橙子”，宝石蓝用于“超好运橙子”。
- 不建议：整套主题只用单一橙色；复杂小字塞进图标；直接裁游戏截图作为最终 UI 素材。

## 角色分工

### 发财小橙子

- 主题定位：主 mascot、代表用户本人和定制版核心。
- 视觉特征：橙色系、白色橙帽、短灰发、橙子糖/魔杖、金币、幸运感。
- 适合出现位置：App 图标、侧边栏 mascot、首页欢迎区、关于页、DMG 背景。

### 好运小橙子

- 主题定位：战斗、修复、警示、游戏医生。
- 视觉特征：粉红/玫瑰红、暗黑玫瑰、蜘蛛/哥特魔女元素。
- 适合出现位置：游戏医生、修复当前页、错误/警示空状态、战斗感装饰。

### 超好运橙子

- 主题定位：知识、记录、设置、工具说明、多开管理。
- 视觉特征：蓝发、眼镜、小礼帽/帽子、魔法书、怀表、蓝色魔法。
- 适合出现位置：设置、便签、历史记录、多开档案选择、帮助/关于。

## 交付格式通用要求

- 最终交付：PNG，透明背景，sRGB。
- 同时保留源文件：PSD、AI、Procreate、Figma 或其他可编辑源文件。
- 图标类素材必须在 22x22 像素显示时仍然可辨认。
- 小图标不要包含中文或细小英文。
- 透明 PNG 外边缘要干净，不要有白边、黑边、脏像素。
- 所有图标建议保留 12%-15% 安全边距，避免贴边。
- 主视觉可以复杂；UI 图标、徽章、按钮图标必须简洁。

## 必做素材清单

### 1. macOS App 图标源图

- 文件名：`app_icon_orange_1024.png`
- 尺寸：1024x1024
- 背景：可以非透明，但需要适合 macOS 圆角图标裁切。
- 用途：生成 `.icns`，替换应用图标。
- 内容建议：橙子徽章 + 发财小橙子头像/橙帽/魔法星/金币。
- 设计要求：
  - 不放细小文字。
  - 小尺寸下仍能看出“橙子”和“浏览器/魔法工具”的识别点。
  - 图标中心主体清楚，四角不要放关键内容。

### 2. 品牌徽章

- 文件名：`badge.png`
- 尺寸：512x512
- 背景：透明 PNG
- 当前替换位置：`app/assets/badge.png`
- 用途：左侧品牌区小徽章、关于页徽章。
- 内容建议：橙片、叶子、幸运星、金币、公会徽章感。
- 设计要求：
  - 不依赖文字识别。
  - 可以和 App 图标同源，但要更扁平、更适合 44x44 显示。
  - 需要能在奶油白背景上清楚显示。

### 3. 侧边栏主 mascot

- 文件名：`mascot.png`
- 尺寸：768x768
- 背景：透明 PNG
- 当前替换位置：`app/assets/mascot.png`
- 用途：侧边栏底部角色，目前 UI 中显示约 120x120。
- 角色建议：发财小橙子。
- 姿态建议：坐姿、挥手、抱橙子、拿橙子糖魔杖、带一点金币/星星。
- 设计要求：
  - 轮廓完整，缩小后脸和橙色识别点清楚。
  - 不要有过长文字飘带。
  - 角色外轮廓最好带轻微浅色描边，便于贴在不同背景上。

### 4. 发财小橙子透明立绘

- 文件名：`char_fortune_orange.png`
- 尺寸：建议 1200x1600；最低 1024x1024
- 背景：透明 PNG
- 用途：首页欢迎区、关于页、空状态、节日彩蛋。
- 参考：第一张大海报中心角色 + 第三张游戏角色截图。
- 设计要求：
  - 需要完整角色，不要被裁切。
  - 服装和发型要能对应“发财小橙子”。
  - 可以保留橙帽、橙子糖、金币、幸运星。

### 5. 好运小橙子透明立绘

- 文件名：`char_lucky_orange.png`
- 尺寸：建议 1200x1600；最低 1024x1024
- 背景：透明 PNG
- 用途：游戏医生、修复页、警示状态、战斗感装饰。
- 参考：第一张大海报左侧红色角色 + 第二张游戏角色截图。
- 设计要求：
  - 需要完整角色，不要被裁切。
  - 保留玫瑰红、暗黑魔女、玫瑰/蛛网等识别元素。
  - 不要过暗，放在浏览器浅色界面里要看得清。

### 6. 超好运橙子透明立绘

- 文件名：`char_super_lucky_orange.png`
- 尺寸：建议 1200x1600；最低 1024x1024
- 背景：透明 PNG
- 用途：设置页、便签页、多开档案选择、帮助/关于。
- 参考：第一张大海报右侧蓝色角色 + 第四张游戏角色截图。
- 设计要求：
  - 需要完整角色，不要被裁切。
  - 保留蓝发、眼镜、帽子、魔法书/怀表等识别元素。
  - 气质更偏聪明、管理、记录、工具向。

### 7. 首页/关于页主视觉

- 文件名：`home_hero_orange.png`
- 尺寸：建议 2400x1200；最低 1800x900
- 背景：非透明 PNG/JPG 均可，推荐 PNG
- 用途：首页顶部横幅、关于页大图、主题宣传图。
- 参考：第一张“橙子家族/魔女旅途特辑”大海报。
- 设计要求：
  - 三位角色都可以出现，但画面要比参考海报更干净。
  - 左右或上方预留可放 UI 文案的空间。
  - 不要大量细小中文、战斗力面板、复杂说明框。
  - 需要适合裁切成 16:9、2:1、3:1 横幅。

## 导航图标清单

所有导航图标建议统一风格，尺寸 256x256，透明 PNG。当前 UI 中显示为 22x22，所以图形必须简洁。

### 8. 首页图标

- 文件名：`nav_home.png`
- 当前替换位置：`app/assets/nav_home.png`
- 建议图形：橙子小屋、魔法门、橙色指南针。

### 9. 游戏库图标

- 文件名：`nav_library.png`
- 当前替换位置：`app/assets/nav_library.png`
- 建议图形：魔法书 + 橙片书签。

### 10. 收藏图标

- 文件名：`nav_favorites.png`
- 当前替换位置：`app/assets/nav_favorites.png`
- 建议图形：心形橙片、星星橙片、收藏徽章。

### 11. 最近游玩图标

- 文件名：`nav_recent.png`
- 当前替换位置：`app/assets/nav_recent.png`
- 建议图形：怀表 + 橙叶。

### 12. 窗口图标

- 文件名：`nav_windows.png`
- 当前替换位置：`app/assets/nav_windows.png`
- 建议图形：叠放窗口 + 橙色光点。

### 13. 档案图标

- 文件名：`nav_profiles.png`
- 当前替换位置：`app/assets/nav_profiles.png`
- 建议图形：三颗小橙子、三枚角色头像徽章、三张身份卡。

### 14. 设置图标

- 文件名：`nav_settings.png`
- 当前替换位置：`app/assets/nav_settings.png`
- 建议图形：齿轮 + 橙叶。

### 15. 关于图标

- 文件名：`nav_about.png`
- 当前替换位置：`app/assets/nav_about.png`
- 建议图形：公会徽章、橙子纹章、信息徽章。

### 16. 账号图标

- 文件名：`nav_accounts.png`
- 当前状态：代码里暂时是文字 `A`，后续我会接入图片。
- 建议图形：钥匙 + 橙子头像、账号卡片、金币钥匙。

### 17. 游戏医生图标

- 文件名：`nav_doctor.png`
- 当前状态：代码里暂时是文字 `D`，后续我会接入图片。
- 建议图形：玫瑰魔杖、修复十字、好运小橙子的小法器。

### 18. 便签图标

- 文件名：`nav_notes.png`
- 当前状态：代码里暂时是 emoji，后续我会接入图片。
- 建议图形：邮票、信纸、橙色便签、魔法笔。

### 19. 待办图标

- 文件名：`nav_tasks.png`
- 当前状态：代码里暂时是符号，后续我会接入图片。
- 建议图形：金币勾选、幸运清单、橙片对勾。

### 20. 快捷键图标

- 文件名：`nav_shortcuts.png`
- 当前状态：代码里暂时是符号，后续我会接入图片。
- 建议图形：键盘按键 + 橙片，或者 `⌘` 符号 + 橙子徽章。

## 浏览器工具图标

这些图标用于后续把“工具”菜单升级成图文菜单。建议尺寸 256x256，透明 PNG，也可以先交 128x128。

### 21. 修复当前页

- 文件名：`tool_repair.png`
- 建议图形：玫瑰魔杖、修复光环、小医疗箱。
- 角色关联：好运小橙子。

### 22. 截图当前游戏

- 文件名：`tool_screenshot.png`
- 建议图形：橙子相机、相框 + 星星。

### 23. 选择档案多开

- 文件名：`tool_multiopen.png`
- 建议图形：三颗橙子分身、叠放窗口、三角色小头像。

### 24. 便签开关

- 文件名：`tool_note.png`
- 建议图形：橙色便签、邮票、羽毛笔。
- 角色关联：超好运橙子。

### 25. 静音

- 文件名：`tool_mute.png`
- 建议图形：铃铛/喇叭 + 橙叶，不要用太复杂的文字。

### 26. 变速

- 文件名：`tool_speed.png`
- 建议图形：闪电橙片、怀表、速度光环。

### 27. 游戏模式

- 文件名：`tool_game_mode.png`
- 建议图形：全屏角标 + 橙子徽章，或者魔法舞台。

## 可选增强素材

### 28. DMG 安装盘背景

- 文件名：`dmg_background.png`
- 尺寸：1200x800
- 背景：非透明 PNG
- 用途：以后制作安装包时作为 DMG 背景。
- 内容建议：小橙子主题横向构图，左侧应用图标区域、右侧 Applications 区域要留干净空间。

### 29. 空状态插画：游戏库

- 文件名：`empty_library.png`
- 尺寸：800x600 或 1024x768
- 背景：透明 PNG
- 建议图形：魔法书还没打开、橙子书签。

### 30. 空状态插画：收藏

- 文件名：`empty_favorites.png`
- 尺寸：800x600 或 1024x768
- 背景：透明 PNG
- 建议图形：空心橙片爱心、等待收藏的星星。

### 31. 空状态插画：历史

- 文件名：`empty_recent.png`
- 尺寸：800x600 或 1024x768
- 背景：透明 PNG
- 建议图形：怀表、脚印、旅行邮戳。

### 32. 空状态插画：账号

- 文件名：`empty_accounts.png`
- 尺寸：800x600 或 1024x768
- 背景：透明 PNG
- 建议图形：钥匙、身份卡、三角色小头像。

### 33. 空状态插画：便签

- 文件名：`empty_notes.png`
- 尺寸：800x600 或 1024x768
- 背景：透明 PNG
- 建议图形：超好运橙子的魔法书、信纸、邮票。

### 34. 加载/等待小图

- 文件名：`loading_orange.png`
- 尺寸：512x512
- 背景：透明 PNG
- 建议图形：旋转橙片、幸运星、金币。

### 35. 三个档案头像

- 文件名：
  - `avatar_lucky_orange.png`
  - `avatar_fortune_orange.png`
  - `avatar_super_lucky_orange.png`
- 尺寸：512x512
- 背景：透明 PNG 或圆形头像底。
- 用途：档案选择、多开菜单、账号管理。
- 设计要求：头像要能在 24x24、32x32、44x44 下识别。

## 建议交付目录结构

```text
orange-theme-assets/
  app_icon_orange_1024.png
  badge.png
  mascot.png
  home_hero_orange.png
  characters/
    char_lucky_orange.png
    char_fortune_orange.png
    char_super_lucky_orange.png
  nav/
    nav_home.png
    nav_library.png
    nav_favorites.png
    nav_recent.png
    nav_windows.png
    nav_profiles.png
    nav_accounts.png
    nav_doctor.png
    nav_notes.png
    nav_tasks.png
    nav_settings.png
    nav_shortcuts.png
    nav_about.png
  tools/
    tool_repair.png
    tool_screenshot.png
    tool_multiopen.png
    tool_note.png
    tool_mute.png
    tool_speed.png
    tool_game_mode.png
  optional/
    dmg_background.png
    empty_library.png
    empty_favorites.png
    empty_recent.png
    empty_accounts.png
    empty_notes.png
    loading_orange.png
    avatar_lucky_orange.png
    avatar_fortune_orange.png
    avatar_super_lucky_orange.png
  source/
    editable-source-files-here
```

## 最小交付版本

如果先做一版可上线的定制主题，最低需要这些素材：

1. `app_icon_orange_1024.png`
2. `badge.png`
3. `mascot.png`
4. `home_hero_orange.png`
5. `char_lucky_orange.png`
6. `char_fortune_orange.png`
7. `char_super_lucky_orange.png`
8. 现有 8 个导航图标：`nav_home.png`、`nav_library.png`、`nav_favorites.png`、`nav_recent.png`、`nav_windows.png`、`nav_profiles.png`、`nav_settings.png`、`nav_about.png`

做完最小版本后，我可以先把浏览器换成小橙子主题；后续再逐步接入账号、医生、便签、待办、快捷键、工具菜单图标。

## 参考图使用方式

- 第一张大海报：作为整体世界观、配色、角色关系和首页主视觉参考。
- 第二张游戏截图：用于提取“好运小橙子”的实际发型、服装、战斗/玫瑰红元素。
- 第三张游戏截图：用于提取“发财小橙子”的实际发型、橙帽、橙色服装和幸运发财元素。
- 第四张游戏截图：用于提取“超好运橙子”的实际蓝发、眼镜、帽子、书卷/智慧感元素。

这些参考图可以给设计师看，但最终浏览器素材建议重新绘制成干净的透明 PNG，不建议直接截图裁切。
