
---

## Solved: this is Sonar's standard captcha

The picture is `jonesdevelopment/sonar` / `standard` (`StandardCaptchaGenerator`): Kingthings
Trypewriter 2 glyphs, radial HSB gradient paint, FBM noise background, three cubic decoy curves,
per-pixel gaussian noise. We compiled the real generator with the plugin's own font and it
reproduces the style exactly — see `proof-our-capture-vs-sonar-render.png` in this folder.

The reader is now a small CNN (`../captcha_nn.js`, 1.03 MB of weights) trained on 60 000 captchas
from that generator plus 10 000 published labelled ones. On the four labelled captures it scores
2/3 on the top guess and 3/3 within the first three guesses (`594` ✓ 0.90, `5r6n` ✓ 0.55,
`yd7z` → `yq7z` 0.24 with `yd7z` at rank 3).

## Current corpus — build 2026-11-05z (supersedes earlier counts above)

16 complete saved maps are now included. All 16 match their supplied labels on first-guess reread after fine-tuning; nine were used for fitting, seven were excluded from these fine-tuning rounds. This is not a fresh live accuracy test. Per-file `labelSource` and `usedForFineTuning` describe provenance. `nle` is user-supplied, not server-confirmed. The incomplete ttu crop is still excluded.

## Current training status — build 2026-11-05aa

Supersedes earlier split counts: ALL 16 complete maps have now been used in fine-tuning. Their 16/16 reread is a training-image regression check, not independent accuracy. Each JSON now records `usedForFineTuning: true`. `nle` remains user-labelled, not server-confirmed. Fresh server captures are needed for independent validation.

## Current corpus — build 2026-11-05ab

20 labelled complete maps; 18 used in fitting. Newly accepted j5m and edop remain excluded. All 20 first guesses match supplied labels on saved reread. User-confirmed a3l and pa8 were added to training. Low-confidence a3l remains held by the default submission policy despite correct transcription. Earlier corpus counts above are historical.

## Current corpus — EXPERIMENTAL build 2026-11-05ac

23 complete labelled maps; 20 used for fitting. j5m, edop and zkp remain excluded from fitting and correct. Saved reread matches 23/23 supplied labels. New 050e and OOu labels were used in training, and both still require manual confirmation under the default confidence threshold. OOu preserves uppercase O exactly; uppercase O support is experimental with an external regression. Earlier counts above are historical.

## Label correction — 2026-11-05ad

Supersedes ac's uppercase claim: OOu was corrected by the user to 00u (two digit zeros, lowercase u). Active OOu.json has been removed and replaced with 00u.json. All active labels use lowercase letters and digits only. Dataset count remains 23; 20 fitted, j5m/edop/zkp excluded. Saved reread matches 23/23.
