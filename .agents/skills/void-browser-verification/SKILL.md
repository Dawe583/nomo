---
name: void-browser-verification
description: "How to run browser checks on this machine without lagging the user's PC: one headless tab, opened once, never several."
---

# Browser verification on this machine

The user runs this machine as their daily driver, with an editor and a chat
client open. Several visible browser windows while I verified work loaded it
hard enough that they asked me to stop. Treat that as a hard rule.

## The rule

**One headless tab (`headed: false`). Opened once. Never a second window.**

- Reuse the one tab with `goto`. Do not `browser.open` again per page.
- If a tab dies, open exactly one replacement, not several.
- `browser.close(all=True)` when the work is done, and check with
  `ps aux | grep omp/puppeteer/chrome` that nothing is left: `browser.close`
  releases the tab, and the managed Chromium tree sometimes outlives it.

## Why several tabs are expensive

Each is a separate Chromium process tree with its own GPU context and
compositor. A dozen of them at once pushed the load average past 24. One tab
does the same work; the limit was never the tabs, it was how many at once.

## Driving the tab

One `evaluate` that waits inside itself, because an idle tab freezes its timers
between turns and component state carries across calls:

```python
tab = await browser.open(name="check", url="http://127.0.0.1:PORT/", headed=False)
await tab.waitForSelector("#rollout", {"timeout": 20000})
result = await tab.evaluate("""(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  document.querySelector('#rollout').scrollIntoView({block:'center'});
  await wait(600);
  return { where: document.querySelector('.rollout-where').innerText };
})()""")
```

`element.click()` from JS does not move focus, so a focus ring left over from a
keyboard test will still be on the old control. `document.activeElement.blur()`
before a screenshot meant to show the selected state.

## Viewport

The `viewport` option on `browser.open` did not take effect; the tab reported
1440 regardless. Use `tab.emulate({"viewport": {"width": 390, "height": 844,
"isMobile": True, "hasTouch": True}})` and confirm with `window.innerWidth`
before trusting any layout claim. One tab can be checked at both widths.

## Screenshot

`screenshot({"selector": "#rollout"})` writes a webp to a temp path, and
`read` on that path renders it inline. The `:img` selector is svg only.

## Serving the site

`pnpm --filter @workspace/void run build` then, from `artifacts/void`:
`PORT=18990 BASE_PATH=/ pnpm exec vite preview --port 18990 --strictPort`.
Stop it with `pkill -f "vite preview --port 18990"`. The supervised process
then exits 1, which is expected and is not a failure to chase.

## Prefer curl when the answer is in the document

The prerendered `index.html` is the shell plus head metadata, not the rendered
content. Grepping it for `role="tablist"` finds nothing on a correct build. Use
curl for status codes and document metadata, and a browser only when the
rendered DOM is the thing being checked.

## What a unit suite cannot tell you

Six separate lies across the compensation trace and the rollout passed the
suite between them: a timer that played a decision nobody made, a chain that
counted an entry before it was recorded, a vetoed call running through a
compensation, copy that said "a person approves" to a reader who had vetoed,
and a rail that measured the scrollbar instead of the step. All of them are
tests now, and not one would have been found without driving the page.
