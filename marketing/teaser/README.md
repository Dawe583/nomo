# VOID / Signal Control

Original 15-second vertical teaser, designed for Instagram Reels, Stories and TikTok.

Master: `VOID-TEASER-1080x1920.mp4`, 1080 × 1920, 9:16, 30 fps, H.264 High, Rec.709, AAC stereo 48 kHz. The edit uses 160 BPM, with a 2.625-second final “COMING SOON” hold. Text remains inside a conservative central social safe area.

Delivery verified: 450 frames decoded without errors; video and audio are both exactly 15.000 seconds. Encoded audio measures −14.06 LUFS integrated and −1.63 dBTP. Eight key compositions were visually reviewed, including the logo macro shots and final card. Cover image: `VOID-TEASER-cover.jpg`.

## Creative treatment

The palette comes from the VOID web client: charcoal `#12100a`, paper `#f6f0e3`, and orange `#e8702c`. Instrument Serif and JetBrains Mono are the same fonts used on the site. The extruded aperture logo follows `apps/control-plane/ui/src/brand.tsx`.

The film combines an original 3D data canyon, hard camera cuts, reverse travel, luminance-driven ASCII, scanlines, horizontal displacement, precision-machined logo details and an assembling logo reveal. The original synthesized industrial score includes timed impacts, bass, percussion, risers and a final logo sting.

| Time | Message |
| --- | --- |
| 0–1.5 s | AI moves fast. |
| 1.5–3 s | Keep control. The control layer for AI agents. |
| 3–5.25 s | You approve. Policy checks before tool writes. |
| 5.25–7.5 s | Every action. On record. Signed, verifiable audit trail. |
| 7.5–9.75 s | Undo changes. Restore captured, reversible actions. |
| 9.75–10.5 s | Macro cuts of the extruded VOID logo. |
| 10.5–12.375 s | VOID. Control for AI agents. |
| 12.375–15 s | VOID. COMING SOON. |

Copy reflects the project's documented capabilities. Undo is explicitly limited to captured, reversible actions. No release date or unsupported guarantee is introduced.

## Rebuild

Use Blender 4.5 LTS, Python 3 with `pillow numpy fonttools brotli`, and FFmpeg with libx264. Run from the repository root:

```sh
mkdir -p /tmp/void-teaser/frames
blender -b --python marketing/teaser/scene.py -- /tmp/void-teaser/frames
python marketing/teaser/finish.py /tmp/void-teaser marketing/teaser
python marketing/teaser/verify.py marketing/teaser/VOID-TEASER-1080x1920.mp4
```

Frames are cached. When modifying scene geometry, lighting or animation, use a fresh frame directory or remove only the affected cached frames before rendering again. `scene.py` also accepts inclusive start and end frame numbers. `finish.py --stills` generates a contact sheet when the corresponding rendered frames exist.

## Asset provenance

3D geometry, animation, procedural effects and synthesized sound are original to this production. Brand geometry and fonts are reused from this repository; font licenses remain in `site/fonts/`. No Mixkit footage or audio is included. The linked “Cyberpunk world concept” clip was used only as a visual reference; its free download is restricted to personal use.

## Version 2: fully 3D

`VOID-TEASER-V2-3D-1080x1920.mp4` preserves the 15-second, 1080 × 1920, 30 fps delivery and the final “COMING SOON” card. Version 1 remains unchanged.

The second edit uses six original 3D sets: a rolling aperture tunnel, a counter-rotating gimbal core, a mechanical policy gate with intercepted write packets, a dimensional signed ledger, a 245-piece snapshot reconstruction, and the exploding and reassembling VOID logo. It adds foreground signal particles, spatial ASCII ribbons, an observatory grid, rotating signature arcs, physical iris transitions and four rapid macro views of the logo. Titles and feature copy are extruded geometry rendered in Blender, with a depth entrance animation and controlled bevel shading. Only brief displacement effects and encoding are applied after the 3D render.

The expanded original score retains 160 BPM and adds stereo transients synchronized to the new camera cuts. The final card remains readable for 2.6 seconds while its surrounding 3D rings continue moving.

V2 delivery verified: exactly 15.000 seconds for both streams, 450 frames decoded without errors, square pixels and complete Rec.709 metadata. Encoded audio measures −14.07 LUFS integrated and −2.65 dBTP. Ten editorial keyframes and the mechanical transitions were visually inspected. The cover is `VOID-TEASER-V2-cover.jpg`.

```sh
python marketing/teaser/finish_v2.py /tmp/void-teaser-v2 marketing/teaser --prepare
blender -b --python marketing/teaser/scene_v2.py -- /tmp/void-teaser-v2/frames
python marketing/teaser/finish_v2.py /tmp/void-teaser-v2 marketing/teaser
python marketing/teaser/verify.py marketing/teaser/VOID-TEASER-V2-3D-1080x1920.mp4
```

Use `--preview` with `scene_v2.py` to render ten editorial keyframes first. Use `--stills` with `finish_v2.py` to inspect those frames as a contact sheet. All render caches and converted fonts belong in the selected temporary directory. Clear or move the affected cache after changing scene code.
