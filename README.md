# questvr – immersive VR player for Stash on Meta Quest

A UI-only [Stash](https://github.com/stashapp/stash) plugin that plays scenes as a proper **immersive WebXR VR video** in the Meta Quest Browser (tested on Quest 3), with its own VR controls. On desktop browsers it switches Stash's built-in VR view on automatically for VR scenes.

- **180° side-by-side by default**, with tags or a per-scene choice for 180/360 × SBS/TB/Mono
- **A compact media-player bar in VR:** wide seek bar with scene-marker ticks, transport buttons, volume and zoom; it auto-fades, you can grab and move it, and a cursor dot shows where you point
- **Comfort controls:** distance, depth (eye shift), zoom, turn/tilt/roll correction saved per scene, and grab-to-turn the video
- **Render quality 50–150 %**, switched inside VR without leaving it (150 % is the Quest 3 browser maximum and is clearly sharper)
- **Thumbstick shortcuts:** seek, volume, mute, zoom
- **Uses Stash's own video player,** so resume points, play counts and volume memory keep working
- **No database changes,** no Stash core changes, no external requests (Three.js is bundled)

## Requirements
- Stash v0.32 (other versions may work; questvr switches itself off with a notice if Stash's player looks different)
- **Stash served over HTTPS.** Browsers only allow immersive WebXR on secure pages. Stash enables HTTPS when `stash.crt` and `stash.key` are in its config directory; a self-signed certificate works (accept the warning once per device).
- Meta Quest Browser for immersive VR. Any desktop browser works for the desktop VR view.

## Installation
**As a plugin source** (once this repository is public): in Stash, go to *Settings → Plugins → Available Plugins → Add Source* and add
```
https://devonaa.github.io/stash-questvr/stable/index.yml
```
Then install **questvr** from that source.

**Manually:** copy the `questvr/` folder into Stash's `plugins` directory, then click *Settings → Plugins → Reload plugins*.

## Usage
On the Quest, open a scene. VR-tagged scenes (Stash setting `ui.vrTag`) get a big **Enter VR** button; every scene gets a **VR** button in the control bar. Don't use fullscreen, because that opens the Quest's built-in player.

| Input | Action |
|---|---|
| Trigger | buttons and sliders; outside the bar it shows the bar, or hides it instantly |
| Grip on the bar | move the bar (the position is remembered) |
| Grip elsewhere | drag the video: left/right = turn, up/down = tilt (saved per scene) |
| Right stick ← → / ↑ ↓ / click | seek ±10 s / volume / mute |
| Left stick ↑ ↓ | zoom ±0.05 |
| A / X | play / pause |
| B / Y | show / hide the bar |

Advanced panel (•••): Distance, Depth, Turn, Tilt, Roll, Render quality, Swap eyes, Follow head, Loop, Recenter view, Reset bar, Reset scene.

**If a scene feels too close:** increase Depth (+0.3 to +1.0), and keep Distance at 20 m or more with Follow head on.

## Settings (Settings → Plugins → questvr)
| Setting | Default | Meaning |
|---|---|---|
| Default projection | `180_SBS` | `180_SBS`, `180_TB`, `180_MONO`, `360_SBS`, `360_TB`, `360_MONO` |
| Default zoom (%) | `100` | 115 = 1.15× (Stash stores whole numbers only) |
| Default distance (m) | `50` | radius of the virtual dome |
| VR render quality (%) | `100` | 50–150; a choice made in VR overrides this on that device |
| Hide VR button on non-VR scenes | off | only VR-tagged scenes get the button |

Per-scene choices are stored in each device's browser storage, and only values you changed are kept. Nothing is written to Stash.

## Known limitations
- **"Browser audio" panel:** the Quest shows a system media panel in VR as soon as the page plays sound. Horizon OS shows it for every background 2D app that plays audio, and a web page can't hide it.
- **180° top-bottom** isn't available in Stash's desktop VR view; it works on the Quest.

## Building the package
`scripts/build-package.sh` creates `dist/stable/questvr.zip` and `index.yml` in the Stash plugin source format. The GitHub Actions workflow runs it on every push.

## License
questvr is released under [CC0 1.0](LICENSE) (public domain).
It bundles [Three.js](https://threejs.org) r170 (`questvr/assets/three.module.js`), © 2010–2024 Three.js Authors, MIT License; its notice is kept at the top of that file.
