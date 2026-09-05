# Source localization without simulation answers

Scope: replace oracle waveform matching in the source lesson. Preserve unrelated work.

1. Isolate inference: EEG + forward geometry + explicit inverse/detection settings only.
2. Reconstruct all grid currents; compute fixed theta, alpha, beta and broadband power maps.
3. Detect spatial local maxima with a relative threshold and minimum separation. Never force four.
4. Freeze inference before truth evaluation. Use gated one-to-one spatial matching within frequency
   bands; show missed sources, unmatched peaks, and nullable errors when nothing matches.
5. UI: power map and candidate traces before reveal; truth markers and evaluation only on reveal.
   Expose regularization, grid spacing, threshold and peak separation; explain ambiguities.
6. Test independence from truth metadata, null/flat signals, peak multiplicity, matching gates,
   default and difficult simulations, API and UI reveal behavior. Verify a production build.

Scientific limits: spherical fixed-orientation model with matched simulation/inverse geometry;
14 average-referenced sensors provide at most 13 independent measurements. Grid density is not
spatial resolution. Relative thresholds are descriptive and do not establish significance.

## Delivered and verified

- Inference is isolated in `source_modeling/localization.py`; it accepts raw EEG, a forward
  model and inverse settings. Oracle waveform-based location selection is removed.
- Default 20 mm grid: 250 points; 40 mm comparison grid: 26 points. All candidate currents,
  band powers and average-referenced forward maps are inspectable.
- Truth metadata and truth waveform corruption tests leave power maps and detected peaks
  unchanged. Zero/flat inputs do not force peaks; synthetic inputs can produce 1, 2, 3 or 5.
- Gated one-to-one scoring leaves missing and extra detections visible. No matches produce
  null distance metrics. Sources outside analysis bands are explicitly unscored.
- Default fixture: mean matched displacement 24.14 mm, maximum 28.28 mm (40 mm match tolerance).
  Noise 5 µV produces 19 unmatched detections across theta/alpha/beta under default settings.
- Browser verified: same EEG, threshold 35% → 90% changes two alpha peaks to one; reveal
  reports the missed right frontal source and the remaining peak's 20 mm error.
- Full Python suite (70 tests at the full-suite checkpoint), full web suite (31 tests), lint
  and build passed. Final source tests (15, including an additional out-of-band test) and
  web source tests (6) passed after final refinements. Browser console had no errors.
- Checked narrow and wide layouts, candidate traces, forward maps, truth-coordinate
  diagnostics, score reset after settings changes, and explicit reveal behavior.

No claim is made that a relative-power peak is statistically significant or that a spatial
match proves a detected physical source. The simulation remains an idealized matched-model case.
