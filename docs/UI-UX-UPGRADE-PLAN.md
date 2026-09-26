# VOID UI/UX Upgrade Plan - Mobile-First, Claude Chat Parity

> **Superseded, 2026-09-26. Not the plan of record, and its checklist is not
> status.** Nothing below has been maintained since it was written: all forty
> items are still unchecked even where the work demonstrably shipped, and the
> two facts it leads with are wrong now. The default provider is NVIDIA NIM
> with `z-ai/glm-5.3-flash` and `NVIDIA_API_KEY`, not OpenCode Zen, and there is
> no silent keyless Pollinations fallback. The test and lint tooling is
> `node:test` plus `tsc`, not Vitest, Playwright or ESLint; those are not in
> this repository.
>
> Read the plans of record instead: [GUI-UPGRADE-PLAN.md](GUI-UPGRADE-PLAN.md)
> and [GUI-UPGRADE-DELIVERY.md](GUI-UPGRADE-DELIVERY.md) for the GUI,
> [TUI-WORKSPACE.md](TUI-WORKSPACE.md) for the terminal,
> [PLAN-STATUS.md](PLAN-STATUS.md) for what is actually built, and
> [HANDBOOK.md](HANDBOOK.md) for how to use the product.

**Goal**: Transform VOID into a professional, mobile-first AI chat interface matching Claude Chat web experience, with OpenCode Zen as default provider.

## 1. Provider Configuration - OpenCode Zen as Default

### 1.1 OpenCode Zen Configuration

- **Provider**: OpenCode Zen (`opencode-zen`)
- **Endpoint**: `https://opencode.ai/zen/v1` (or `https://opencode.ai/zen/v1`)
- **API Key**: From `OPENCODE_ZEN_API_KEY` env var or local opencode auth via `/connect opencode:zen`
- **Default Model**: First available model from OpenCode Zen catalog
- **Fallback**: Pollinations (keyless) if OpenCode Zen unavailable

### 1.2 Configuration Files to Update

- `packages/workbench/src/provider-defaults.ts` - Add opencode-zen as first preset
- `packages/workbench/src/index.ts` - Update default provider to opencode-zen
- `apps/control-plane/ui/src/settings.tsx` - Update default model display
- `apps/control-plane/ui/src/chat.tsx` - Update default model state
- `apps/control-plane/ui/src/demo.tsx` - Update demo model display
- `AGENTS.local.md` - Update documentation

## 2. Mobile-First Web Redesign (Priority #1)

### 2.1 Mobile Layout Architecture

```
┌─────────────────────────────────────┐
│  Status Bar (model, ctx, approvals) │  ← Fixed top
├─────────────────────────────────────┤
│                                     │
│                                     │
│         Chat Messages               │  ← Scrollable, flex-1
│                                     │
│                                     │
├─────────────────────────────────────┤
│  Composer Bar (fixed bottom)        │  ← Fixed bottom
│  [@] [+] [mic] [text] [send]        │
└─────────────────────────────────────┘
```

### 2.2 Key Mobile Components

1. **Fixed Header**: Model selector, context bar, approvals badge
2. **Chat Area**: Virtualized list, auto-scroll, pull-to-refresh
3. **Composer**: Auto-resize textarea, attachment button, send button
4. **Bottom Sheet**: Command palette, model picker, settings
5. **Side Drawer**: Sessions, documents, settings (swipe from left)

### 2.3 Mobile-Specific Features

- Touch gestures: swipe right for sessions drawer, swipe left for tools
- Pull-to-refresh for new messages
- Haptic feedback on actions
- Safe area insets (notch, home indicator)
- PWA manifest for installability
- Offline queue for messages

### 2.4 Responsive Breakpoints

- Mobile: < 640px (primary target)
- Tablet: 640px - 1024px
- Desktop: > 1024px (enhanced layout)

## 3. Desktop App Upgrades (Tauri)

### 3.1 Native Feel Improvements

- Native title bar with traffic lights (macOS) / standard (Windows/Linux)
- Native menus (File, Edit, View, Window, Help)
- Keyboard shortcuts matching OS conventions
- Native file dialogs
- System theme detection (light/dark)
- Native notifications

### 3.2 Desktop-Specific Features

- Multi-window support (detached chats)
- Global shortcut (Cmd+Shift+V / Ctrl+Shift+V)
- Dock/Taskbar badge for approvals
- Auto-updater with native prompts
- Native spell check
- Drag & drop files from OS

## 4. Expanded Menus & Features (Claude Chat Parity)

### 4.1 Command Palette (Cmd+K / Ctrl+K)

- Search commands, sessions, models, settings
- Fuzzy search with keyboard navigation
- Recent items at top
- Custom commands support

### 4.3 Chat Features

- Message threading/replies
- Code block copy/download
- Message editing (up arrow in empty composer)
- Branching conversations
- Message search (Cmd+F)
- Export conversation (JSON, MD, PDF)

### 4.4 Session Management

- Session list with search/filter
- Pin/favorite sessions
- Archive/restore
- Session tags/labels
- Bulk operations

### 4.4 Tools & Integrations

- MCP server management UI
- Tool approval history
- Custom tool creation
- Tool usage analytics

### 4.5 Settings Panels

- Providers & API keys (encrypted)
- Model preferences per provider
- Theme customization
- Keyboard shortcuts editor
- Data export/import
- Privacy controls

## 5. Visual Design System

### 5.1 Design Tokens (CSS Variables)

- Colors: semantic (primary, surface, background, text, border)
- Spacing: 4px base unit
- Typography: Inter (UI), JetBrains Mono (code)
- Shadows: elevation system (0-4)
- Border radius: 4px, 8px, 12px, 16px, full
- Transitions: 150ms, 200ms, 300ms

### 5.2 Component Library

- Button variants: primary, secondary, ghost, danger, link
- Input states: default, focus, error, disabled, loading
- Card, Modal, Drawer, Toast, Tooltip, Popover
- Avatar, Badge, Chip, Divider, Skeleton
- Virtualized List, Infinite Scroll

### 5.3 Animations

- Micro-interactions (button press, hover, focus)
- Page transitions (slide, fade)
- Loading states (skeleton, spinner, progress)
- Reduced motion support

## 6. Implementation Phases

### Phase 1: Foundation (Week 1)

- [ ] OpenCode Zen provider setup
- [ ] Design token system
- [ ] Component library core
- [ ] Mobile layout structure
- [ ] Provider config updates

### Phase 2: Mobile Chat Core (Week 2)

- [ ] Mobile chat layout
- [ ] Message rendering
- [ ] Composer with auto-resize
- [ ] Touch gestures
- [ ] Virtualized message list

### Phase 3: Desktop Enhancements (Week 3)

- [ ] Native menus
- [ ] Keyboard shortcuts
- [ ] Native title bar
- [ ] System theme sync
- [ ] Native notifications

### Phase 4: Features & Polish (Week 4)

- [ ] Command palette
- [ ] Session management
- [ ] Settings panels
- [ ] Animations
- [ ] PWA support

### Phase 5: Polish & Ship (Week 5)

- [ ] Cross-browser testing
- [ ] Accessibility audit
- [ ] Performance optimization
- [ ] Documentation
- [ ] Release

## 7. Subagent Team Structure

| Agent                | Role          | Responsibilities                               |
| -------------------- | ------------- | ---------------------------------------------- |
| **Mobile Lead**      | Mobile UI/UX  | Mobile layout, touch gestures, PWA, responsive |
| **Desktop Lead**     | Desktop App   | Tauri integration, native menus, native feel   |
| **Chat Core Lead**   | Chat Engine   | Messages, composer, streaming, branching       |
| **Components Lead**  | Design System | Tokens, components, animations, a11y           |
| **Provider Lead**    | Providers     | OpenCode Zen, model management, keys           |
| **Desktop App Lead** | Tauri App     | Native menus, notifications, auto-updater      |
| **QA Lead**          | Testing       | E2E tests, a11y, performance, cross-browser    |

## 8. Success Criteria

- [ ] Mobile Lighthouse > 95 (Performance, A11y, Best Practices, SEO)
- [ ] Desktop Lighthouse > 95
- [ ] Mobile: < 3s TTI on 3G
- [ ] Desktop: < 1.5s TTI
- [ ] WCAG 2.1 AA compliance
- [ ] All tests pass (unit, integration, e2e)
- [ ] OpenCode Zen works as default provider
- [ ] Mobile PWA installable
- [ ] Desktop app builds for macOS/Windows/Linux

## 9. Technical Stack

- **Frontend**: React 18, TypeScript, Vite
- **Styling**: CSS Modules + CSS Variables (no Tailwind)
- **State**: TanStack Query, React Context
- **Animations**: Framer Motion
- **Desktop**: Tauri 2, Rust backend
- **Testing**: Vitest, Playwright, Playwright MCP
- **Linting**: ESLint, Prettier, TypeScript strict

## 10. Risk Mitigation

| Risk                     | Mitigation                                            |
| ------------------------ | ----------------------------------------------------- |
| OpenCode Zen API changes | Abstract provider interface, fallback to Pollinations |
| Mobile Safari quirks     | Test on real devices, polyfills                       |
| Tauri 2 migration issues | Pin Tauri version, test early                         |
| Provider API changes     | Abstract provider interface                           |
| Performance on low-end   | Virtualization, lazy loading, code splitting          |

---

**Next Steps**:

1. Update provider configuration for OpenCode Zen
2. Create design token system
3. Set up component library
4. Build mobile chat layout
5. Create subagent team and begin parallel implementation
