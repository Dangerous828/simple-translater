# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** — externalOriginalText 未同步到 Translator 输入框
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the bug exists
  - **Scoped PBT Approach**: Scope the property to concrete failing cases — any non-empty trimmed string set via `setExternalOriginalText` should appear in the Translator textarea
  - Install `fast-check` as a dev dependency (`pnpm add -D fast-check`)
  - Create test file `src/common/components/__tests__/Translator.externalText.test.tsx`
  - Mock dependencies: `styletron-engine-atomic`, `baseui-sd`, `react-hot-toast/headless`, `react-i18next`, `../translate`, `../lang`, `../hooks/useSettings`, `../hooks/useTheme`, `../internal-services/db`, `../services/history`, `../utils`, `@/tauri/bindings`
  - Use `fast-check` to generate arbitrary non-empty trimmed strings as `externalOriginalText`
  - For each generated string: call `setExternalOriginalText(text)`, render `<Translator>`, assert textarea value equals the generated text (from Bug Condition `isBugCondition` in design: `externalOriginalText IS NOT undefined AND trim() IS NOT empty AND translatorTextState !== externalOriginalText`)
  - The test assertions should match Expected Behavior Properties from design: Translator SHALL synchronize `externalOriginalText` into textarea `text` state
  - Run test on UNFIXED code with `pnpm test -- --run src/common/components/__tests__/Translator.externalText.test.tsx`
  - **EXPECTED OUTCOME**: Test FAILS (this is correct — it proves the bug exists because `Translator` never subscribes to `externalOriginalText`)
  - Document counterexamples found (e.g., `setExternalOriginalText("Hello World")` → textarea remains empty)
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2, 2.1, 2.2_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** — 手动输入与非外部文本路径行为不变
  - **IMPORTANT**: Follow observation-first methodology
  - Create test in same file or a separate `Translator.preservation.test.tsx`
  - Observe on UNFIXED code: manual typing into textarea updates `text` state correctly; Clear button resets textarea to empty; when `externalOriginalText` is undefined/empty, textarea is not affected
  - Write property-based test with `fast-check`: for all arbitrary strings (including empty), simulating manual `onChange` on textarea, assert textarea value equals the typed string — this captures that manual input path is independent of `externalOriginalText`
  - Write property-based test: for all cases where `externalOriginalText` is undefined or empty string or whitespace-only, textarea value remains unchanged from manual input (from Preservation Requirements in design: non-`externalOriginalText` input paths are unaffected)
  - Verify tests pass on UNFIXED code with `pnpm test -- --run`
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.5_

- [x] 3. Fix: Translator 组件订阅 externalOriginalText 并自动翻译

  - [x] 3.1 Implement the fix in `src/common/components/Translator.tsx`
    - Import `useTranslatorStore` and `setExternalOriginalText` from `../../common/store` (or `../store` depending on relative path)
    - Subscribe to `externalOriginalText` via `const externalOriginalText = useTranslatorStore((s) => s.externalOriginalText)`
    - Add a `useEffect` that watches `externalOriginalText`: when it is a non-empty trimmed string, call `setText(externalOriginalText)` to sync to textarea, then call `setExternalOriginalText('')` to reset store and avoid repeated consumption
    - Add auto-translate trigger: use a ref flag (e.g., `needsAutoTranslateRef`) set to `true` when external text is synced; add a second `useEffect` watching `text` that checks the ref and calls `startTranslate()` when flagged, then resets the ref
    - Ensure empty/whitespace-only `externalOriginalText` values are ignored (no sync, no translate)
    - _Bug_Condition: isBugCondition(input) where externalOriginalText is non-empty trimmed string AND Translator text state !== externalOriginalText_
    - _Expected_Behavior: Translator SHALL sync externalOriginalText into text state and auto-invoke startTranslate()_
    - _Preservation: Manual input, button clicks, language switching, settings toggle, window focus — all unaffected_
    - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x] 3.2 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** — externalOriginalText 同步到输入框
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms the expected behavior is satisfied
    - Run `pnpm test -- --run src/common/components/__tests__/Translator.externalText.test.tsx`
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 3.3 Verify preservation tests still pass
    - **Property 2: Preservation** — 非外部文本路径行为不变
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm all tests still pass after fix (no regressions)

- [x] 4. Checkpoint — Ensure all tests pass
  - Run full test suite: `pnpm test -- --run`
  - Ensure all tests pass, ask the user if questions arise.
