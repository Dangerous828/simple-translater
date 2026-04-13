# Global Selection Hotkey Fix — Bugfix Design

## Overview

全局划词翻译快捷键（`CmdOrControl+Shift+E`）触发后，Rust 后端成功获取选中文本并通过 `change-text` 事件发送到前端，`TranslatorWindow` 正确监听该事件并将文本写入 `externalOriginalText` Zustand store。然而 `Translator` 组件从未订阅该 store，导致选中文字无法填入输入框，也不会触发自动翻译。

修复策略：在 `Translator` 组件中订阅 `externalOriginalText` store，当其值变化时同步更新输入框文本（`text` state），并自动触发翻译。修复范围严格限定在 `Translator` 组件内部，不涉及后端或 `TranslatorWindow` 的改动。

## Glossary

- **Bug_Condition (C)**: `externalOriginalText` store 被更新为非空字符串时，`Translator` 组件未读取该值
- **Property (P)**: 当 `externalOriginalText` 更新时，`Translator` 应将其同步到输入框并自动执行翻译
- **Preservation**: 手动输入翻译、仅显示窗口（无选中文本）、自动隐藏窗口等现有行为不受影响
- **`externalOriginalText`**: `src/common/store.ts` 中的 Zustand store 字段，由 `TranslatorWindow` 在收到 `change-text` 事件时写入
- **`setExternalOriginalText`**: 更新 `externalOriginalText` 的 action 函数
- **`Translator`**: `src/common/components/Translator.tsx` 中的核心翻译 UI 组件，管理输入框文本（`text` state）和翻译逻辑
- **`TranslatorWindow`**: `src/tauri/windows/TranslatorWindow.tsx` 中的窗口容器组件，监听 Tauri 事件并渲染 `Translator`

## Bug Details

### Bug Condition

当用户在外部程序中选中文字并按下划词翻译快捷键时，Rust 后端调用 `get_selected_text()` 获取文本，通过 `utils::send_text()` 发射 `change-text` 事件。`TranslatorWindow` 监听该事件并调用 `setExternalOriginalText(selectedText)` 写入 store。但 `Translator` 组件内部的 `text` state 完全独立于该 store，从未订阅 `externalOriginalText` 的变化，因此输入框始终为空。

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type { externalOriginalText: string | undefined, translatorTextState: string }
  OUTPUT: boolean

  RETURN input.externalOriginalText IS NOT undefined
         AND input.externalOriginalText.trim() IS NOT empty
         AND input.translatorTextState !== input.externalOriginalText
         // Translator 组件未将 store 值同步到 text state
END FUNCTION
```

### Examples

- 用户选中 "Hello World" 并按下 `CmdOrControl+Shift+E` → 期望：输入框显示 "Hello World" 并自动翻译；实际：输入框为空，无翻译
- 用户选中一段中文 "你好世界" 并按下快捷键 → 期望：输入框显示 "你好世界" 并自动翻译；实际：输入框为空
- 用户连续两次选中不同文本并按下快捷键 → 期望：输入框每次更新为最新选中文本；实际：输入框始终为空
- 用户未选中任何文本时按下快捷键 → 期望：窗口显示但输入框为空，不触发翻译；实际：窗口显示，输入框为空（此场景行为恰好正确，因为后端不会发射 `change-text` 事件）

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- 用户在翻译窗口内手动输入文字并点击翻译按钮，系统正常执行翻译并显示结果
- 用户按下显示翻译窗口快捷键（`CmdOrControl+Shift+D`）时，仅显示翻译窗口而不填入任何文字
- 用户在外部程序中未选中任何文字时按下划词翻译快捷键，窗口显示但不填入空白文本
- 翻译窗口失去焦点且 `autoHideWindowWhenOutOfFocus` 设置开启时，自动隐藏翻译窗口
- 用户清空输入框或手动修改输入框内容时，允许自由编辑不受外部文本状态干扰

**Scope:**
所有不涉及 `externalOriginalText` store 变化的输入路径应完全不受此修复影响。包括：
- 手动键盘输入到翻译输入框
- 点击翻译/停止/清空按钮
- 切换目标语言
- 打开/关闭设置面板
- 窗口焦点变化与自动隐藏

## Hypothesized Root Cause

基于代码分析，根因明确：

1. **`Translator` 组件未订阅 `externalOriginalText` store**: `Translator` 使用独立的 `const [text, setText] = useState('')` 管理输入框文本，从未调用 `useTranslatorStore` 读取 `externalOriginalText`。这是唯一的根因。

2. **缺少自动翻译触发逻辑**: 即使文本被填入输入框，当前代码也没有在外部文本到达时自动调用 `startTranslate()` 的逻辑。翻译仅在用户点击 "Translate" 按钮时触发。

3. **`externalOriginalText` 消费后未重置**: store 中的 `externalOriginalText` 在被消费后未被重置为 `undefined`，可能导致重复消费或与手动输入冲突。需要在同步到 `text` state 后清除 store 值。

## Correctness Properties

Property 1: Bug Condition — 外部选中文本填入输入框并自动翻译

_For any_ input where `externalOriginalText` store is updated to a non-empty trimmed string, the fixed `Translator` component SHALL synchronize that value into the input textarea's `text` state and automatically invoke `startTranslate()`, resulting in a translation being performed without user interaction.

**Validates: Requirements 2.1, 2.2, 2.3**

Property 2: Preservation — 非外部文本路径行为不变

_For any_ input that does NOT involve `externalOriginalText` store changes (manual typing, button clicks, language switching, settings toggle, window focus changes), the fixed `Translator` component SHALL produce exactly the same behavior as the original code, preserving all existing manual input, translation, and UI interaction functionality.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

## Fix Implementation

### Changes Required

假设根因分析正确：

**File**: `src/common/components/Translator.tsx`

**Function**: `Translator`

**Specific Changes**:

1. **导入 store hook**: 在文件顶部导入 `useTranslatorStore` 和 `setExternalOriginalText`（用于消费后重置）
   - `import { useTranslatorStore, setExternalOriginalText } from '../store'`

2. **订阅 `externalOriginalText`**: 在组件内部使用 `useTranslatorStore` 读取 `externalOriginalText`
   - `const externalOriginalText = useTranslatorStore((s) => s.externalOriginalText)`

3. **添加 `useEffect` 同步外部文本到 `text` state**: 当 `externalOriginalText` 变化且为非空字符串时，调用 `setText(externalOriginalText)` 更新输入框，然后重置 store 值为 `undefined` 以避免重复消费
   ```tsx
   useEffect(() => {
       if (externalOriginalText && externalOriginalText.trim()) {
           setText(externalOriginalText)
           setExternalOriginalText('')  // 或 undefined，重置以避免重复消费
       }
   }, [externalOriginalText])
   ```

4. **添加自动翻译触发逻辑**: 在外部文本同步到 `text` state 后，自动调用 `startTranslate()`。由于 `startTranslate` 依赖 `text` state，需要使用一个 ref 或额外的 effect 来确保在 `text` 更新后触发翻译
   - 方案 A：使用一个 `needsAutoTranslate` ref 标记，在 `text` 更新后的下一个 effect 中检查并触发
   - 方案 B：在同步 effect 中使用 `setTimeout` 或 `queueMicrotask` 延迟调用

5. **store 重置函数**: 可能需要在 `src/common/store.ts` 中添加一个 `clearExternalOriginalText` 函数，或复用 `setExternalOriginalText` 传入空字符串

## Testing Strategy

### Validation Approach

测试策略分两阶段：首先在未修复代码上运行探索性测试以确认 bug 存在并验证根因假设，然后在修复后验证正确性和行为保持。

### Exploratory Bug Condition Checking

**Goal**: 在实施修复前，通过测试用例表面化 bug 的反例，确认或否定根因分析。如果否定，需要重新假设。

**Test Plan**: 编写测试模拟 `externalOriginalText` store 更新，断言 `Translator` 组件的输入框文本是否同步更新。在未修复代码上运行这些测试以观察失败。

**Test Cases**:
1. **Store 更新测试**: 调用 `setExternalOriginalText("Hello")` 后渲染 `Translator`，断言输入框值为 "Hello"（未修复代码将失败）
2. **自动翻译触发测试**: 设置 `externalOriginalText` 后断言 `startTranslate` 被调用（未修复代码将失败）
3. **连续更新测试**: 连续两次更新 `externalOriginalText` 为不同值，断言输入框显示最新值（未修复代码将失败）
4. **空文本测试**: 设置 `externalOriginalText` 为空字符串，断言输入框不更新（未修复代码可能通过）

**Expected Counterexamples**:
- `Translator` 组件渲染后输入框始终为空，不论 `externalOriginalText` 值如何
- 根因确认：组件内部无任何代码路径读取 `externalOriginalText`

### Fix Checking

**Goal**: 验证对于所有满足 bug condition 的输入，修复后的函数产生期望行为。

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  setExternalOriginalText(input.text)
  render Translator component
  ASSERT textarea.value === input.text
  ASSERT startTranslate() was invoked
  ASSERT externalOriginalText store is reset after consumption
END FOR
```

### Preservation Checking

**Goal**: 验证对于所有不满足 bug condition 的输入，修复后的函数与原始函数行为一致。

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT Translator_original(input) = Translator_fixed(input)
END FOR
```

**Testing Approach**: 属性基测试（Property-Based Testing）推荐用于保持性检查，因为：
- 自动生成大量测试用例覆盖输入域
- 捕获手动单元测试可能遗漏的边界情况
- 对所有非 bug 输入提供强行为不变保证

**Test Plan**: 先在未修复代码上观察手动输入、按钮点击等交互的行为，然后编写属性基测试捕获该行为。

**Test Cases**:
1. **手动输入保持**: 验证用户手动输入文字后，输入框值正确反映用户输入，不受 `externalOriginalText` 干扰
2. **按钮功能保持**: 验证翻译/停止/清空按钮在修复后行为不变
3. **设置面板保持**: 验证打开/关闭设置面板不影响输入框状态
4. **仅显示窗口保持**: 验证 `show` 事件（无 `change-text`）不会导致输入框被填入文本

### Unit Tests

- 测试 `externalOriginalText` store 更新后 `Translator` 输入框文本同步
- 测试外部文本到达后自动翻译触发
- 测试 store 消费后重置为 undefined/空字符串
- 测试空字符串和纯空白字符串不触发同步
- 测试手动输入不受外部文本状态干扰

### Property-Based Tests

- 生成随机非空字符串作为 `externalOriginalText`，验证每次都能正确同步到输入框
- 生成随机手动输入序列，验证在无 `externalOriginalText` 变化时行为与原始代码一致
- 生成混合场景（交替手动输入和外部文本），验证两种路径互不干扰

### Integration Tests

- 端到端测试：模拟 `change-text` 事件 → `TranslatorWindow` 处理 → `externalOriginalText` 更新 → `Translator` 同步 → 自动翻译触发
- 测试连续快速按下快捷键时的竞态处理
- 测试在设置面板打开时收到外部文本的行为
