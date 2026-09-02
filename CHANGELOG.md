# Change Log

All notable changes to the "minecraft-language-file-gui-editor" extension will be documented in this file.

## [Unreleased]

### Added

- 原生自定义编辑器（Custom Editor）注册为语言文件的**打开方式**：不拦截正常文件打开，用户通过 “Open With… / Reopen With…”、资源管理器右键菜单或命令面板显式打开。
- 多语言并排网格：一行一个翻译 key，一列一种语言；单元格直接编辑，空值标记“未翻译”。
- 语言列显隐开关（顶部语言徽章）及实时翻译覆盖率统计。
- 详情面板：选中 key 后在所有语言下对照编辑（多行文本框），含 `%s` / `%d` 等占位符一致性 ⚠ 提示；key 可直接在详情中编辑重命名（Enter 提交 / Esc 还原，同步所有语言文件）。
- 添加 / 删除 / 重命名 key：对同目录**所有**语言文件同时生效，可撤销 / 重做（`Ctrl+Z` / `Ctrl+Y`）。
- 筛选（key 或任意译文）、仅显示未翻译、按语言排序。
- 代码补全：key 输入联想已有 key（标注缺失语言）与常见 Minecraft key 前缀；译文输入联想其它语言的 `%s`/`%d`/`%1$s` 占位符。
- 编辑字号/字体跟随 VS Code `editor.fontSize`/`editor.fontFamily`（改动即时生效、行高自适应）；配色使用活动主题变量并按主题种类回退，key 与占位符按代码配色高亮，切换主题自动更新。
- 写回保留各文件原始 key 顺序、缩进风格（空格/制表符）、末尾换行与 BOM；新 key 追加到文件末尾。
- 外部修改自动从磁盘重载。
- 容错：空/纯空白的语言文件视为可编辑的空语言（正常打开、可新增翻译）；JSON 解析失败或无法读取的文件被隔离为错误横幅、不被改写，且不阻塞同目录其它语言文件的打开与编辑。
- 若干可配置项（确认删除、撤销上限、缩进）。
