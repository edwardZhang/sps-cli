# Accessibility

Semantic HTML, keyboard, ARIA, focus, contrast. Not optional.

## Who benefits

- 15–20% of users have a disability (motor, visual, cognitive, temporary).
- Everyone benefits from good a11y: keyboard shortcuts, screen readers, screen-reader-like voice assistants, low-light contrast, slow networks.

Treat it as a correctness requirement, not a "nice to have".

## Semantic HTML first

Every control you use should be the right element for the job.

| Use | For |
|---|---|
| `<button>` | Action |
| `<a href>` | Navigation |
| `<form>` | Group inputs, submit behaviour |
| `<input type="checkbox">` / `<input type="radio">` | Single / exclusive choice |
| `<select>` / `<option>` | Enumerated choice from list |
| `<label>` | Associate text with an input |
| `<fieldset>` / `<legend>` | Group related inputs |
| `<nav>`, `<main>`, `<aside>`, `<header>`, `<footer>` | Landmarks |
| `<h1>` … `<h6>` | Document outline |

**Rule**: if the right element exists, use it. `<div onClick>` with `role="button"` is twice the work and half the behaviour.

## Keyboard navigation

Every interactive control must be operable with keyboard only:

- **Tab** / **Shift+Tab** — move focus.
- **Enter** / **Space** — activate (varies: buttons on both, links on Enter).
- **Arrows** — move within composite widgets (menus, tablists, listboxes, grids).
- **Escape** — dismiss modal, popover, typeahead.

Test periodically: unplug the mouse.

### Visible focus

Don't remove the focus outline.

```css
/* ❌ */
*:focus { outline: none; }

/* ✅ style it, don't remove it */
:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 2px;
}
```

`:focus-visible` shows on keyboard focus but not mouse click — best of both.

### Focus management

Modal opens → move focus into the modal. Modal closes → return focus to the trigger.

```
function Modal() {
  useEffect(() => {
    const prev = document.activeElement;
    firstInput.focus();
    return () => prev.focus();        // restore on unmount
  }, []);
}
```

Route changes → announce and move focus to the new page's `<h1>` or main landmark (framework routers handle some of this; verify).

## ARIA — the rule

First rule of ARIA: **don't use ARIA.** Use semantic HTML. Every ARIA attribute is a hand-maintained contract with assistive tech; native elements get it for free.

When you must use ARIA (custom widgets), follow the [ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/) patterns — they are the source of truth.

Common attributes:

| Attribute | Meaning |
|---|---|
| `aria-label` | Override accessible name (use sparingly) |
| `aria-labelledby` | Name by reference to another element |
| `aria-describedby` | Extra hint / help text |
| `aria-hidden="true"` | Hide purely decorative element from AT |
| `aria-live="polite"` / `"assertive"` | Announce changes |
| `aria-expanded` | Disclosure state on buttons |
| `aria-controls` | Associates a control with the thing it controls |
| `aria-current` | The active item in a set (e.g. nav) |

Rules:
- Don't set `aria-hidden` on a focusable element — screen readers skip, but keyboard doesn't.
- Don't name duplicates: `<button aria-label="Close">Close</button>` — pick one.

## Labels and descriptions

Every form control has a label. Either:

```
<label for="email">Email</label>
<input id="email" name="email">

<!-- or wrap -->
<label>
  Email
  <input name="email">
</label>
```

Placeholder is NOT a label. It disappears on focus and has poor contrast.

For help text / errors:

```
<label for="pw">Password</label>
<input id="pw" type="password" aria-describedby="pw-help pw-err">
<span id="pw-help">At least 12 chars.</span>
<span id="pw-err" role="alert">Too short.</span>
```

## Color contrast

Minimum WCAG AA:
- Normal text vs. background: **4.5 : 1**
- Large text (18 pt+ or 14 pt bold+): **3 : 1**
- UI components (border, icon vs. background): **3 : 1**

Don't rely on color alone. "Red = error" + icon + text is accessible; red alone isn't for the color-blind.

Tools: Lighthouse flags most contrast issues; for design systems, contrast-aware token generators (radix colors, Open Props).

## Live regions — announce changes

Status updates that aren't caused by the user's last action (notifications, background sync) need an ARIA live region.

```
<div aria-live="polite" aria-atomic="true">
  {status}
</div>

<!-- For urgent errors -->
<div role="alert">
  {errorMessage}
</div>
```

`polite` queues the announcement; `assertive` / `role="alert"` interrupts. Use `assertive` sparingly.

## Images and alt text

- Content image: `<img alt="screen reader text">` describing what it shows.
- Decorative image: `<img alt="">` (empty alt, NOT no alt).
- SVG icon with text next to it: `<svg aria-hidden="true">`.
- Standalone SVG icon that means something: provide an accessible name.

## Motion and animation

- Respect `prefers-reduced-motion`:
  ```css
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
  }
  ```
- Don't autoplay videos with audio.
- Avoid content flashing more than 3 times per second (seizure risk).

## Screen reader testing

Two minutes in a screen reader beats an hour of reading spec.

- macOS: **VoiceOver** (Cmd+F5).
- Windows: **NVDA** (free) or **JAWS**.
- iOS: **VoiceOver**. Android: **TalkBack**.

Walk through key flows. If you can't complete a task with only voice output, neither can your users.

## Automated testing

Tools that catch a lot cheaply:

- **axe-core** (or `@axe-core/react`, `vitest-axe`) — unit-test with it.
- **Lighthouse a11y score** — smoke test in CI.
- **Playwright / Cypress + axe** — E2E a11y checks.
- **ESLint `jsx-a11y`** — catches basics at write time.

Automated tools find roughly 30% of issues. The rest needs a human.

## Common patterns — the right way

| Widget | Key rules |
|---|---|
| Modal | Trap focus, restore on close, `aria-modal`, visible backdrop |
| Menu | Button with `aria-expanded`, arrow-key navigation, Escape to close |
| Tabs | Arrow keys move focus; Tab exits; `aria-selected` on active |
| Combobox | WAI-ARIA APG pattern — complex; use a library |
| Tooltip | `aria-describedby`, hover + focus triggers, escape to dismiss |
| Toast | `role="status"` or `aria-live="polite"`, don't auto-dismiss critical messages |
| Accordion | Button with `aria-expanded`, content with `role="region"` |

## i18n hooks

Accessibility overlaps with i18n:
- `lang` attribute on `<html>` and on sections that differ.
- `dir="rtl"` / `dir="ltr"` for text direction.
- Locale-aware number / date formatting.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| `<div onClick>` acting as a button | `<button>` |
| `outline: none` with no replacement | Style `:focus-visible` |
| Placeholder-as-label | Visible `<label>` |
| Tab order that skips around visually | Match DOM order to visual order |
| Modal without focus trap | Library (`focus-trap-react`) or correct hand-rolled |
| Color-only error state | Add icon + text |
| Auto-focusing unexpected things | Focus jumps break the user's place |
| `aria-hidden` on a focusable control | Either hide visually too, or remove aria-hidden |
| Missing `lang` | Set on `<html>` |
| "Click here" link text | Descriptive link text: "Read the pricing guide" |
