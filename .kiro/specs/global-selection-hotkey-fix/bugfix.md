# Bugfix Requirements Document

## Introduction

全局划词翻译快捷键功能未正常工作。用户在任意外部程序中选中文字后按下划词翻译快捷键（默认 `CmdOrControl+Shift+E`），期望选中的文字自动填入翻译原文输入框并自动执行翻译。当前的实现中，Rust 后端通过 `get_selected_text()` 获取选中文本并通过 `change-text` 事件发送到前端，`TranslatorWindow` 监听该事件并将文本写入 `externalOriginalText` store，但 `Translator` 组件从未订阅该 store，因此选中的文字无法填入输入框，也不会触发自动翻译。

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN 用户在外部程序中选中文字并按下划词翻译快捷键 THEN 翻译窗口显示但原文输入框为空，选中的文字未被填入

1.2 WHEN 选中的文字通过 `change-text` 事件成功传递到 `TranslatorWindow` 并写入 `externalOriginalText` store THEN `Translator` 组件不读取该 store 值，输入框文本不更新

1.3 WHEN 选中的文字未填入原文输入框 THEN 系统不会自动执行翻译，用户必须手动粘贴文字并点击翻译按钮

### Expected Behavior (Correct)

2.1 WHEN 用户在外部程序中选中文字并按下划词翻译快捷键 THEN 翻译窗口 SHALL 显示并将选中的文字自动填入原文输入框

2.2 WHEN `externalOriginalText` store 被更新为新的文本值 THEN `Translator` 组件 SHALL 读取该值并同步更新原文输入框的内容

2.3 WHEN 选中的文字成功填入原文输入框 THEN 系统 SHALL 自动执行翻译，无需用户手动点击翻译按钮

### Unchanged Behavior (Regression Prevention)

3.1 WHEN 用户在翻译窗口内手动输入文字并点击翻译按钮 THEN 系统 SHALL CONTINUE TO 正常执行翻译并显示结果

3.2 WHEN 用户按下显示翻译窗口快捷键（`displayWindowHotkey`，默认 `CmdOrControl+Shift+D`） THEN 系统 SHALL CONTINUE TO 仅显示翻译窗口而不填入任何文字

3.3 WHEN 用户在外部程序中未选中任何文字时按下划词翻译快捷键 THEN 系统 SHALL CONTINUE TO 显示翻译窗口但不填入空白文本，不触发翻译

3.4 WHEN 翻译窗口失去焦点且 `autoHideWindowWhenOutOfFocus` 设置开启 THEN 系统 SHALL CONTINUE TO 自动隐藏翻译窗口

3.5 WHEN 用户清空输入框或手动修改输入框内容 THEN 系统 SHALL CONTINUE TO 允许用户自由编辑，不受外部文本状态干扰
