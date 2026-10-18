OFFPEAK — FRONT-FACING LIVE COMPUTE CITY

CURRENT WEBSITE HERO
A transparent, interactive SVG world, with a 1600 x 700 viewbox. The camera has
horizontal front facades and shallow 3D roofs/sides. A panoramic 3-by-2 layout
fills the hero and can overflow its lateral edges. It has no opaque backdrop or
enclosing floor slab. The original video is a legacy optional export, not the
current hero.

The six districts depict spare GPU capacity, accepted quotes, per-call
authorization, model inference, usage metering / unused-balance release, and
private receipts. Architecture and product motions are editable in
render-city.mjs and ../city-interactive.js.

LIVE OUTPUTS
../assets/offpeak-city-live.svg — architecture, robot eyes and instruments.
../assets/offpeak-city-live-state.json — camera and animated object anchors.
../assets/offpeak-city-live-poster.png — static fallback, genuine transparency.
city-live-proof.png — visual review flattened on #f8f8f8; not the deployed asset.
live-validation.json — dimensions, alpha coverage and source loop verification.

LIVE REBUILD
Requires Node.js and Sharp. No binaries or fonts are bundled.
  npm install
  node render-city.mjs --live

Camera mapping:
  screenX = 800 + 2.25 * x - 0.2 * y
  screenY = 435 + 0.9 * y - 1.35 * z
The exported state and browser runtime use the same camera, including the
vertical scale of moving objects. Static architecture loads once. Per-frame
work updates transforms and attributes; it never rebuilds the SVG tree.

ILLUSTRATIVE ANALYTICS
Three shallow graphite instruments are integrated into the city's front edge.
The selected district controls three metrics and their sparklines, with 18
metrics across all six districts. Examples include GPU utilization, available
capacity, token throughput, time to first token and proof verification time.
Labels and values use responsive HTML aligned over the SVG instrument bodies.
Readouts update once per second and follow a deterministic 20-second cycle.
Every instrument is labeled ILLUSTRATIVE. These locally generated examples
are not live production measurements or promised rates or performance.

MOTION AND INTERACTION
19 rooftop cooling fans; 41 status lights; electric shuttles; a five-car light
rail; four courier drones; visitors; route pulses; quote dial; ticket conveyor;
authorization scanner and gate; sorting arms; inference parcels; usage bars;
sorting diverter; balance-return parcels; printer paper; root beacon; service
lift. Paired Robin Neon #CCFF00 eyes connect the machinery to the approved CRT
identity. Cursor proximity energizes districts, accelerates fans and attracts
nearby courier/data motes.

Six accessible district controls switch the illustrative instrument readings
and explain each product concept. Mobile provides native horizontal panning
plus six always-visible district tabs. A footer below the world explains the
selection and contains pause/resume. Reduced motion starts paused; offscreen
and hidden tabs suspend animation. Authored clock-driven mechanisms use a
20-second period; interactive fan acceleration remains continuous.

MOUNT
../city-interactive.js automatically mounts [data-city-host], or call
window.OffpeakCity.mount(host). ../city-interactive.css styles only this scene
and its controls. Allow the host height to be auto so its footer participates
in layout; .opcity-stage supplies the artwork aspect ratio.

State datasets: cityView=front, cityAnalytics=illustrative, citySelected,
cityMetricSet, cityPaused, cityTime. API at host._offpeakCity exposes select(id),
pause(), play(), getState() and destroy().

VERIFICATION
The current RGBA source renders at t=0 and t=20 are byte-identical. All four
poster corners have alpha zero. Exact measurements are in live-validation.json.
The retained Sharp proof is separate from browser validation of user interaction.

LEGACY ISOMETRIC VIDEO
The following outputs preserve the earlier isometric version. They are not
referenced by the current live hero:
../assets/offpeak-city.mp4 — silent H.264, 1600 x 900, 24 fps, 20 seconds.
../assets/offpeak-city-poster.png — legacy opaque poster.
city-contact-sheet.png — legacy frames at 0, 5.5, 11 and 16.5 seconds.
city-ground.svg and city-architecture.svg — legacy static vector layers.
validation.json — legacy MP4 metadata, frame/loop checks and SHA-256.
render-work/ — regenerated legacy cached layers and proof frames.

Legacy rebuilding additionally needs FFmpeg. Set OFFPEAK_FFMPEG to its
executable path; the original workstation path is a fallback.
  node render-city.mjs             # legacy poster and contact sheet
  node render-city.mjs --render    # legacy MP4 and loop validation

If reused independently, play the legacy MP4 muted with loop and playsinline,
use its PNG as a poster, honor reduced motion and stop decoding when offscreen.