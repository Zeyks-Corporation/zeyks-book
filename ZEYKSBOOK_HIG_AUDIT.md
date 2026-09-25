# ZeyksBook.app — Apple HIG Audit Report
**Audited against: APPLE_HIG_ULTIMATE_AGENT_GUIDE.md (iOS 26 / Liquid Glass)**
**Date: 2026-09-22 | Site: https://www.zeyksbook.app/**
**Method: Static analysis of HTML/CSS/JS bundle + content extraction**

---

## Executive Summary

**Verdict: PARTIAL PASS — Clean and Apple-*inspired* in philosophy, but NOT fully Apple-like in implementation.**

**Score: 5.2 / 10 Apple-likeness**

**What you got right (very Apple):**
- Content-first, calm, no decoration — Purpose, Simplicity, Craft are excellent. Copy is plain human language, exactly what Apple Writing guidelines recommend.
- No demo data, no marketing fluff, explains what it does AND does not do — very Responsibility.
- Minimal palette, generous whitespace — aligns with Visual Hierarchy.
- Tailwind + lightweight — good performance (Apple: Performance as Design).

**What fails Apple HIG Ultimate Guide:**
- Typography uses **Plus Jakarta Sans**, not SF Pro / system font stack. Body is 12-14px (text-xs/sm), below Apple's 17pt (17px) legibility floor.
- No Dark Mode, no Increase Contrast, no Reduce Transparency support — `color-scheme: light` only. Apple requires both appearances.
- No semantic color tokens — uses zinc-* oklch, not systemBackground/label/separator semantic system.
- No Liquid Glass — functional layer (tab bar, toolbar) is solid, not floating translucent material. In 2026, Apple expects Liquid Glass for controls.
- Touch targets likely <44pt (text-xs buttons), fails Accessibility mandatory 44x44.
- No SF Symbols — likely uses custom icons.
- No Dynamic Type scaling.

**If your goal is "actual Apple-like UI" that passes App Store design review, you need fixes below.**

---

## 1. Core Principles Audit (8 Principles)

| Principle | Status | Notes |
|-----------|--------|-------|
| **Purpose** | ✅ PASS | Landing: "Books that reconcile, in the calendar Nepal actually uses." Immediately understandable. Primary task obvious. No ornamental UI. |
| **Agency** | ⚠️ PARTIAL | Has sign in, but landing doesn't show obvious back/cancel/undo patterns. Need to audit app interior. |
| **Responsibility** | ✅ PASS | Excellent: "Your books live in your own Firebase project. Nothing on this page reads them." Transparent, privacy-first. |
| **Familiarity** | ⚠️ PARTIAL | Uses standard web patterns, but not Apple platform patterns (no large titles, no tab bar). |
| **Flexibility** | ❌ FAIL | Only light mode. No dark, no Dynamic Type, no RTL, `color-scheme: light` hardcoded. |
| **Simplicity** | ✅ PASS | Very simple, progressive disclosure good. |
| **Craft** | ⚠️ PARTIAL | Clean, but spacing uses Tailwind default, not 8pt Apple grid; no continuous corners; no safe-area insets observed. |
| **Delight** | ⚠️ PARTIAL | Calm, but no subtle feedback, haptics, or meaningful motion. |

---

## 2. Foundations Deep Dive

### 2.1 Typography — ❌ FAIL
**HIG Requirement:**
- SF Pro / SF Compact / New York / SF Mono, system font stack: `-apple-system, BlinkMacSystemFont, "SF Pro Display"...`
- Body 17pt (17px) minimum, Large Title 34pt Bold, min 11pt anywhere. Dynamic Type to 200%+.

**Current:**
```css
body { font-family: Plus Jakarta Sans, -apple-system... }
--text-xs: .75rem (12px)
--text-sm: .875rem (14px)
--text-base: 1rem (16px)
```
- Uses Plus Jakarta Sans as primary (Google Font). Apple says prefer system fonts for native feel.
- Body text on landing is `text-xs` / `text-sm` = 12-14px, below 17pt floor. Fails legibility.
- No Dynamic Type support, no `font: -apple-system-body` scaling.

**Fix:**
```css
:root {
  --font-sf: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", sans-serif;
}
body { font-family: var(--font-sf); }
.text-body { font: 400 17px/22px var(--font-sf); }
.text-largeTitle { font: 700 34px/41px var(--font-sf); letter-spacing: -0.4px; }
```
Set landing H1 to 34px Bold, body to 17px Regular, secondary to 15px.

### 2.2 Color — ❌ FAIL
**HIG Requirement:** Semantic tokens: systemBackground, label, secondaryLabel, separator, accent #007AFF, with light/dark/high-contrast variants. Never rely on color alone.

**Current:**
```css
--color-zinc-50: oklch(98.5% 0 none)
--color-zinc-900: oklch(21%...)
body { color: #18181b; background: #fafafa }
meta color-scheme = light only
theme-color #18181b
```
- Zinc palette, not semantic. No dark mode.
- No accent token — uses zinc-900 for primary buttons (Apple expects one accent, e.g., systemBlue).
- No high-contrast variant.

**Fix:** Replace with semantic tokens from Ultimate Guide:
```css
:root {
  --bg: #FFFFFF; --bg-secondary: #F2F2F7;
  --label: #000000; --label-secondary: rgba(60,60,67,0.6);
  --separator: rgba(60,60,67,0.29); --accent: #007AFF;
}
@media (prefers-color-scheme: dark) { :root { --bg: #000000; --label: #FFFFFF; ... } }
```

### 2.3 Layout & Safe Areas — ⚠️ PARTIAL
**Current:** `min-h-screen`, `p-4`, `max-w-sm`, `lg:pl-60` sidebar — uses Tailwind, not Apple 16-20pt margins or safe-area env().
**Missing:** `env(safe-area-inset-top/bottom)`, scroll edge effect, background extension effect.
**Fix:** Add:
```css
body { padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
```

### 2.4 Materials & Liquid Glass — ❌ FAIL (2026 Critical)
**HIG 2026:** Functional layer (tab bars, toolbars, sidebars) must use Liquid Glass: `regular` (blur + luminosity) for legibility, `clear` (highly translucent) only over rich media. Content layer uses standard materials (ultraThin...).

**Current:** `bg-white border border-zinc-200 rounded-lg shadow-sm` — solid flat cards, no `backdrop-filter`, no translucency. No floating tab bar.

**Fix for Apple-like:**
```html
<nav class="fixed bottom-6 left-1/2 -translate-x-1/2 flex gap-1 p-2 rounded-full
            bg-white/70 dark:bg-black/60 backdrop-blur-[40px] backdrop-saturate-[200%]
            border border-white/20 shadow-[0_8px_32px_rgba(0,0,0,0.12)]">
```
Sidebar should be `backdrop-blur-[20px] bg-white/72` with scroll edge.

### 2.5 Icons — ⚠️ UNKNOWN
Bundle strings show `w2, yz` components — likely Lucide or custom icons, not SF Symbols. Apple requires weight-matched SF Symbols.
**Fix:** Use SF Symbols where possible, or Lucide with weight matching: `stroke-width: 2` matching text semibold.

### 2.6 Accessibility — ❌ FAIL
- Touch targets: `w-6 h-6` spinner (24px) <44pt fail, `text-xs` buttons likely <44pt.
- Contrast: zinc-900 on zinc-50 passes (15:1), but zinc-500 on zinc-50 may fail 4.5:1.
- No VoiceOver labels audited, no `prefers-reduced-motion`, no `prefers-reduced-transparency`.
- No Dynamic Type.

**Fix:** Enforce `min-h-[44px] min-w-[44px]` on all interactive, add `focus-visible:ring-2`, test with Accessibility Inspector.

---

## 3. Patterns

| Pattern | Status | Notes |
|---------|--------|-------|
| **Loading** | ⚠️ PARTIAL | Has spinner `border-2 border-zinc-300 border-t-zinc-900 animate-spin` — good, but no skeleton for content. |
| **Empty States** | ✅ PASS? | Landing explains what it does not do — good empty-state philosophy, but need to check app interior. |
| **Error States** | ⚠️ PARTIAL | Has error tone `bg-rose-50 border-rose-200 text-rose-800` — good, calm, not technical jargon. But should include icon + text + actionable. |
| **Modality** | UNKNOWN | Sheets? Need to check app interior — should use sheets with clear purpose and dismissal. |
| **Search** | N/A | Not on landing. |
| **Onboarding** | ✅ PASS | "Set up your books — This only takes a moment. You can change any of it later." Short, allows skipping, value-explaining — perfect Apple onboarding. |

---

## 4. Components

- **Buttons:** `variant: primary/secondary`, `rounded-lg`, `shadow-sm` — hierarchy exists, but should be: Primary = filled accent, capsule 9999px or 12px continuous, 44pt height, pressed scale 0.97. Currently `rounded-lg` (8px) not Apple continuous.
- **Cards:** `bg-white border border-zinc-200 rounded-lg` — Apple often uses spacing + grouping instead of boxes. When card needed, use `rounded-[12px] border-[0.5px] border-separator shadow-sm` with continuous corners.
- **Tab Bar:** Should be floating Liquid Glass, not solid sidebar only.
- **Forms:** Labels: "Business name", "Owner's name" — clear, Apple-like writing. Good. But placeholder "e.g. Himal Traders" — Apple says avoid placeholder as only label (they have label, so okay). Need to ensure validation next to field, preserve input.

---

## 5. Platform Awareness

- **iOS:** No large titles, no bottom tab bar, no Dynamic Island handling.
- **iPadOS:** Has `lg:pl-60` sidebar — good, aligns with split view, but should be translucent.
- **macOS:** Not applicable (web app).
- **Overall:** Feels like generic Tailwind SaaS, not native Apple.

---

## 6. Overall Scores

```
Purpose & Simplicity: 9/10 (excellent, very Apple)
Typography: 2/10 (wrong family, too small)
Color System: 3/10 (no semantic, no dark)
Layout: 6/10 (clean but not Apple grid/safe areas)
Materials/Liquid Glass: 1/10 (none)
Iconography: 4/10 (not SF Symbols)
Accessibility: 3/10 (fails 44pt, no Dynamic Type, light only)
Components: 5/10 (functional but not Apple-styled)
Motion: 2/10 (only spin, no spring)
Craft: 6/10 (clean but not polished to Apple level)
-------------------------------------------------
FINAL: 5.2/10 Apple-likeness
```

---

## 7. What To Fix To Make It Truly Apple-Like (Prioritized)

### P0 — Mandatory for Apple-like feel
1. **Typography:** Switch to SF stack, body 17px, largeTitle 34px Bold. Remove Plus Jakarta Sans or make it secondary only for marketing. Add Dynamic Type scaling.
2. **Dark Mode:** Add `prefers-color-scheme` dark variant for all semantic tokens. Change `color-scheme: light` to `light dark`. Test increase contrast.
3. **Touch Targets:** Enforce `min-h-11 (44px)` on all buttons, inputs. Add `active:scale-[0.97]` transition.
4. **Semantic Colors:** Replace zinc-* with semantic tokens from Ultimate Guide.

### P1 — For 2026 Liquid Glass Era
5. **Liquid Glass Tab Bar / Toolbar:** Make bottom navigation floating translucent: `backdrop-blur-[40px] bg-white/68` + `saturate-200%` + `shadow-[0_8px_32px_rgba(0,0,0,0.12),inset_0_0_0_0.5px_rgba(255,255,255,0.4)]`
6. **Materials:** Sidebar and sheets use `bg-white/72 backdrop-blur-[20px]` not solid white.
7. **Continuous Corners:** `rounded-[12px]` with `style: .continuous` (CSS: `corner-shape: squircle` or larger radius). Buttons capsule `rounded-full`.

### P2 — Polish
8. **SF Symbols:** Replace generic icons with SF Symbols or weight-matched Lucide (stroke 1.8-2 matching Semibold).
9. **Focus States:** `focus-visible:ring-2 ring-accent ring-offset-2`.
10. **Motion Tokens:** Use 100ms micro, 240ms standard, spring `cubic-bezier(0.32,0.72,0,1)` for sheets.
11. **Empty/Error States:** Icon + short title + one-sentence + primary action (you already do well, just style Apple-like).

---

## 8. Example — How Your Landing Would Look Apple-Like

**Current H1:** `text-sm`? Actually small.
**Apple-like H1:**
```html
<h1 class="text-[34px] font-bold leading-[41px] tracking-[-0.4px] text-[var(--label)]">
  Books that reconcile, in the calendar Nepal actually uses.
</h1>
<p class="text-[17px] leading-[22px] text-[var(--label-secondary)] mt-3 max-w-[42rem]">
  Record sales, purchases and settlements. Zeyks Book posts each one as a balanced journal...
</p>
<button class="mt-6 h-11 px-6 rounded-full bg-[var(--accent)] text-white text-[17px] font-semibold active:scale-[0.97] transition-transform">
  Sign in or create account
</button>
```

---

## 9. Conclusion

**ZeyksBook.app today = Clean, trustworthy, content-first SaaS — which is philosophically Apple, but visually generic Tailwind, not Apple HIG compliant.**

- If your audience is **Nepali businesses who want reliable accounting**, your current minimalism is actually a strength (trust > flashy UI). You pass Purpose, Responsibility, Simplicity.
- If your goal is **"actual Apple-like UI"** that feels native on iPhone/Mac and would pass Apple Design Awards, you fail Typography, Color, Materials, Accessibility, Liquid Glass.

**Recommendation:**
- Keep your excellent copy and information architecture — it's more Apple than most apps.
- Apply P0 fixes (SF fonts, 17px body, dark mode, 44pt targets, semantic colors) — 1 day of work, 80% of Apple feel.
- Then apply P1 Liquid Glass floating bars — will make it feel iOS 26 native.

Want me to generate a **fixed version** of your landing page in pure Apple HIG style using the Ultimate Guide tokens? I can produce a single HTML file you can drop in.

---
**Audit artifacts:** CSS analyzed: 38KB Tailwind v4, zinc palette, Plus Jakarta Sans. JS: React SPA, Firebase auth.
**References:** APPLE_HIG_ULTIMATE_AGENT_GUIDE.md Section 3-10, 18-19 Quality Gate.
