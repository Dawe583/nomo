# Mobile layout checkpoint — 2026-09-14

The mobile sizing contract now lives in `apps/control-plane/ui/src/mobile.css`,
loaded after the shared styling and ASCII identity. Desktop panel preferences do
not determine mobile drawer width or alignment. No CSS zoom, transform scaling,
or viewport zoom restrictions are used.

## Delivered

- Workspace drawer: 240–280 CSS pixels, proportional to narrow viewports,
  with one scrollable surface so settings remain reachable on short phones.
- Compact navigation typography and spacing, including when the desktop sidebar
  was previously collapsed. Touch targets remain at least 44 pixels.
- Smaller welcome text, starter spacing and composer; shared sizing for the
  authenticated workspace and public demo.
- Compact action menus, bounded dialogs and 16-pixel mobile text fields.
- Crossing the desktop breakpoint closes the drawer and releases the inert main
  content. Keyboard height handling and browser pinch zoom remain enabled.

## Verification

Built with `pnpm build:web`; disposable servers:

```sh
node scripts/src/preview-workspace.mjs
node scripts/src/preview-mobile-demo.mjs
```

Browser checks used the actual built application and fixture providers. The
workspace fixture completed a model response and created `plan.md` through the
real document tool; the public demo completed a message. This does not verify a
live model provider.

| Viewport | Checks and observed result |
| --- | --- |
| 320 × 568 | Drawer 240 px, menu scroll reaches Settings; chat, settings and public menu stay within viewport; workspace message completed. |
| 390 × 844 | Drawer 280 px, versus 310 px before; composer area 170 px, versus 201.5 px before; public action menu 320 px wide. |
| 430 × 932 | Drawer 280 px after collapsing the desktop sidebar; labels remain left aligned and visible. |
| 390 × 360 | Public composer remains visible; menu bounds 12–348 px, with internal scrolling. |
| 768 × 1024 | Resizing with the drawer open closes it; no remaining drawer overlay or horizontal overflow. |
| 1440 × 900 | Desktop navigation and chat remain available; collapsing navigation still works. |

Repeat the menu checks after collapsing navigation on desktop. Verify Settings
is reachable by scrolling on the smallest viewport, close dialogs with Escape,
and check that new chat remains usable after switching across 768 px.

A useful read-only assertion in the browser console, while a menu dialog is open:

```js
const dialog = document.querySelector('dialog[open]');
const bounds = dialog?.getBoundingClientRect();
console.assert(document.documentElement.scrollWidth <= innerWidth, 'Horizontal overflow');
console.assert(!bounds || (bounds.top >= 0 && bounds.bottom <= innerHeight), 'Dialog outside viewport');
```

Physical iOS/Android keyboards, installed-PWA safe areas and device-specific text
settings were not tested on hardware. The reduced-height check is a viewport
regression, not a hardware keyboard test.
