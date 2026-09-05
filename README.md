# Neurosignal Testbed

The Real data lab now includes `@neurosignal/trace-viewer` 0.4.0 after FIF import. It reads only
the requested time/channel window from the imported working copy, offers Canvas navigation,
and preserves the original recording. The portable package tarball is in `apps/web/vendor/`.
Trace metadata/window routes are read-only; **Refresh traces** reloads changed working-copy metadata.
Run `.venv/bin/python -m pytest tests/oracle/test_trace_window.py` for MNE/immutability checks and
`npm test --prefix apps/web` for the transport adapter tests. The sibling EEG-Tracer repository's
`npm run check:real-data` exercises the complete import-to-viewer browser workflow with temporary data.

## NeuroSignal — Phase 1–6 web vertical slices

The repository includes the first five working slices of the product described in
[`PRD.md`](PRD.md) and [`implementation_plan.md`](implementation_plan.md): a local-first,
truth-first sampling/filtering lesson and a rank-aware ICA artifact-recovery lesson with a
separately testable Python scientific core, FastAPI service, and React/TypeScript workspace.

The lesson plants known 2, 10, and 60 Hz sources, mixes them into sensor channels, applies a
reversible reference/filter recipe, and lets the learner compare the raw trace, filtered trace,
Welch PSD, actual digital filter response, and explicit mixing matrix before revealing truth.
Every result records its seed, units, rank, software versions, and recipe hash.

The ICA lesson first creates three neural sources plus a planted blink and exposes the mixed
sensor EEG for inspection. The learner then fits FastICA or extended Infomax using a dedicated
1–100 Hz copy, reviews the component trace, PSD, and scalp topography, and treats ICLabel as
strictly advisory. Exclusions remain manual; the app checks channel/reference compatibility and
reports artifact attenuation plus neural distortion only after the learner applies a selection.
The pinned default fixture recovers the blink above 0.95 source correlation while retaining more
than 80% of the neural control signal.

The connectivity lesson starts with four explicitly named virtual sources: Frontal L/R and
Posterior L/R. All contain alpha oscillations, but only the frontal pair shares a controllable
phase component; these are schematic locations, not anatomical coordinates. Generate EEG first
(`POST /connectivity/simulate`) to inspect an actual example epoch before estimating across all
epochs (`POST /connectivity/runs`). The preview and estimator use identical deterministic input.
Traces use arbitrary units, not calibrated microvolts.

The first completed estimate is saved as A. Change coupling, phase offset, field spread, or
reference, then generate and estimate B. Shortcuts reset to A and change exactly one setting.
A/B matrices use identical channel order and a fixed blue–yellow–red 0–1 color scale; scalp maps
use the same weight colors, emphasize strong edges with a fixed nonlinear width scale, and show only edges above each run's own shuffled-null threshold.
A B−A matrix uses a separate symmetric −1 to +1 scale, with exact changes listed below.
Metric and spectral mode are shared measurement settings: changing either automatically
re-estimates saved A and B on identical seeded EEG and replaces the pair together. Failures
restore the previous pair and selector. Draft B signal edits and previews remain available.
Before the first estimate, metric changes reuse the generated EEG. Source-space estimates are computed from original
simulation sources, not inverse-reconstructed EEG. Controls and old results retain separate
settings while a new run is pending or fails.

Spectral metrics (coherence, imaginary coherence, PLV, PPC, PLI, wPLI) use MNE-Connectivity.
The existing engine displays absolute values, including broadband Pearson |r| and PPC magnitude;
these conventions are stated beside the metric selector. Coherence is the magnitude of
coherency, not magnitude-squared coherence. Advanced diagnostics retain the source Welch and
multitaper spectra, specparam fit, and space-specific shuffled nulls. Connectivity never implies
an anatomical or causal connection.

The source-modeling lab uses an explicitly illustrative 14-channel standard 10–20 spherical
volume template. It plants four ROI-proxy time courses, projects them with MNE's EEG forward
solution, and reconstructs every candidate with minimum norm. The default 20 mm grid has 250
locations; a 40 mm / 26-point grid remains available for comparison. Inference accepts EEG,
forward geometry and analysis settings only. Fixed theta (4–8), alpha (8–13), beta (13–30)
and broadband (4–30 Hz) maps integrate Hann-periodogram power in nAm². Spatial local maxima
pass a relative threshold and distance suppression; neither four peaks nor known waveforms
are supplied to detection. Users can inspect any candidate's current and average-referenced
forward map before revealing truth.

After inference, one-to-one spatial matching within each nonoverlapping frequency band uses
a declared 40 mm tolerance. Reveal shows matched distances, missed sources and unmatched
peaks; no matches yield null errors rather than zero. Broadband is exploratory and not scored
twice. Truth-coordinate waveform correlation and resolution-matrix leakage are explicitly
post-reveal diagnostics. The old oracle waveform matching and benchmark-pass badge are removed.
Relative peak thresholds are descriptive, not significance tests. This fixed-orientation sphere
shares forward/inverse geometry and does not test individual anatomy or head-model mismatch.
See [source_localization_plan.md](source_localization_plan.md) for the implementation boundary.

The real-data lab opens FIF, EDF/BDF, BrainVision, or EEGLAB recordings read-only, surfaces
format/channel/filter/annotation/digitization evidence, and writes only a separate local FIF
working copy. It provides descriptive QC, project-manifest recovery/migration, a cached EEGBCI
eyes-open/eyes-closed lesson path, and an `mne.Report` HTML export that records provenance and
caveats without simulation-score language.

The QEEG lab continues from any imported project without modifying that project's FIF working
copy. Each run creates its own filtered/optionally ICA-cleaned FIF derivative and JSON record,
then exposes Welch PSD, absolute and relative delta/theta/alpha/beta/gamma power, channel-wise
theta/beta ratios, verified-position topomaps, and sensor-level coherence and PLV. ICA exclusions
are manual and repeatable: a first fit reveals component summaries, and a later run applies only
the component indices selected by the user. QEEG output is explicitly descriptive, has no
normative-database comparison, and is not a clinical diagnosis.

### Run the app locally

```bash
# Terminal 1 · scientific service
uv sync --extra dev --extra ica
uv run neurosignal-api

# Terminal 2 · browser client
cd apps/web
npm install
npm run dev
```

Open [http://127.0.0.1:5174](http://127.0.0.1:5174). The API documentation is available at
[http://127.0.0.1:8001/docs](http://127.0.0.1:8001/docs). These ports are reserved for
NeuroSignal development so it does not collide with ScholarPen on ports 5173 and 8000. The web
server uses a strict port and exits instead of silently moving to another port when 5174 is busy.

### Verify

```bash
uv run python -m pytest
uv run ruff check .
cd apps/web && npm test && npm run typecheck && npm run build
```

The web client contains no Electrobun or Tauri imports. Desktop packaging remains deferred until
the browser MVP gate in the implementation plan is complete.

---

## V2.1 — Exploratory EEG Prototype Validation

Neurosignal Testbed is a research-oriented EEG analysis and machine-learning prototype built with Python and MNE-Python.

The V2.1 pipeline loads a real 64-channel EEG recording, performs preprocessing and event/epoch analysis, extracts time- and frequency-domain features, evaluates T1/T2 classification with support-vector machines (SVM), and performs cross-validation, repeated cross-validation, feature analysis, and permutation testing.

**Research status:** Exploratory EEG Prototype Validation

The current dataset is intentionally treated as a prototype dataset. The present results do not establish generalizable classification performance or clinical validity.

---

## 1. Project Objectives

The current project is designed to establish a reproducible EEG analysis workflow that connects:

- Real EEG data acquisition/loading
- EEG montage and sensor-position inspection
- Signal preprocessing
- Event detection and epoching
- Event-related potential (ERP) analysis
- Global Field Power (GFP)
- EEG topographical analysis
- Time-domain feature extraction
- Frequency-domain feature extraction
- Combined feature representation
- Machine-learning classification
- Cross-validation and repeated validation
- Feature-weight analysis
- Permutation testing
- Reproducible research documentation

This V2.1 release establishes the analytical foundation for subsequent EEG/BCI research.

---

## 2. Dataset

The current pipeline uses a real EEG recording from the MNE EEGBCI dataset.

### Current recording

- **File:** `S001R04.edf`
- **Channels:** 64 EEG channels
- **Recording duration:** 125.0 seconds
- **Samples:** 20,000
- **Sampling frequency:** 160 Hz
- **Events detected:** 15
- **T1 trials:** 8
- **T2 trials:** 7

The recording contains event annotations:

- `T0`
- `T1`
- `T2`

The current analysis focuses on the `T1` and `T2` conditions.

---

## 3. EEG Preprocessing

The V2.1 preprocessing pipeline includes:

1. Loading the EDF recording with MNE-Python.
2. Applying the EEG sensor montage.
3. Inspecting the raw EEG.
4. Applying a 60 Hz notch filter.
5. Applying a 1–40 Hz band-pass filter.
6. Inspecting the filtered EEG.
7. Computing power spectral density (PSD).
8. Detecting the annotated events.
9. Creating epochs from −1 to 4 seconds around events.
10. Applying baseline correction using the −1 to 0 second interval.

The resulting epoch structure is:

```text
15 total epochs
├── T1: 8
└── T2: 7

No epochs were dropped in the current run.

4. Restored EEG Visualizations

The V2.1 refactored pipeline explicitly restores the major inspection figures from the original analysis workflow.

These include:

64-channel EEG sensor positions
Raw EEG
Raw EEG power spectral density
Filtered EEG
Filtered EEG power spectral density
EEG event timeline
All task epochs
T1 epochs
T2 epochs
T1 averaged 64-channel EEG
T2 averaged 64-channel EEG

These figures are intended for visual inspection and quality-control during execution.

5. ERP and GFP Analysis

The pipeline creates averaged evoked responses for T1 and T2.

Central electrodes analyzed quantitatively
C3
Cz
C4

Global Field Power (GFP) was also calculated from the EEG channels.

Peak GFP
Condition	Peak GFP	Time
T1	27.38 µV	1.788 s
T2	28.13 µV	0.388 s

The pipeline also generates EEG topographical comparisons at the peak GFP times.

6. Quantitative ERP Results
C3
T1 mean: 2.42 µV
T2 mean: −3.97 µV
T1 − T2: 6.40 µV
Cz
T1 mean: 2.89 µV
T2 mean: −3.65 µV
T1 − T2: 6.55 µV
C4
T1 mean: 2.77 µV
T2 mean: 1.32 µV
T1 − T2: 1.45 µV
7. Statistical ERP Comparison

Welch's t-tests were used for the exploratory comparison between T1 and T2.

Channel	t-statistic	p-value	Cohen's d
C3	1.245	0.2387	0.656
Cz	1.254	0.2354	0.661
C4	0.363	0.7244	0.194

The current p-values do not provide statistically significant evidence at the conventional 0.05 threshold.

These statistics should be interpreted cautiously because only 15 trials are available.

8. Feature Engineering

The pipeline creates three feature representations.

Time-domain features
Matrix: (15, 15)
Features: 15
Frequency-domain features

Frequency bands currently evaluated:

Delta
Theta
Alpha
Beta
Gamma
Matrix: (15, 15)
Features: 15
Combined features
Matrix: (15, 30)
Features: 30

The combined representation contains the time-domain and frequency-domain features.

9. Initial SVM Classification

A support-vector machine (SVM) was used for exploratory T1/T2 classification.

Time-domain SVM
Accuracy: 60.00%
Precision: 50.00%
Recall: 50.00%
F1-score: 50.00%

Confusion matrix:

[[2, 1],
 [1, 1]]
Combined-feature SVM
Accuracy: 60.00%
Precision: 50.00%
Recall: 50.00%
F1-score: 50.00%

Confusion matrix:

[[2, 1],
 [1, 1]]

The combined representation did not improve the initial held-out test accuracy relative to the time-domain representation.

10. Cross-Validation

The current feature-representation comparison produced:

Representation	Mean CV Accuracy	Standard Deviation
Time-domain	40.00%	24.94 percentage points
Frequency-domain	60.00%	32.66 percentage points
Combined	40.00%	13.33 percentage points

The frequency-domain representation produced the highest mean cross-validation accuracy in this exploratory experiment.

However, the variability is substantial and the sample size is very small.

11. Repeated Cross-Validation

The repeated validation analysis produced:

Number of validation scores: 50
Mean accuracy: 46.67%
Standard deviation: 23.09 percentage points
Minimum accuracy: 0.00%
Maximum accuracy: 100.00%
NaN scores: 0
Infinite scores: 0

The wide range of validation performance demonstrates that the current classifier estimate is highly sensitive to trial composition.

12. Exploratory Feature Analysis

The strongest T1–T2 mean-separation features included:

Cz_theta
C3_theta
C4_theta
Cz_peak_to_peak
Cz_max

The strongest individual SVM coefficient in the initial model was:

Feature: C3_max
Coefficient: -0.349925
Absolute coefficient: 0.349925

Repeated validation identified C3_alpha as the most frequently appearing feature among the top 10 SVM features:

C3_alpha: 48/50 validations

These are exploratory model-level findings and should not be interpreted as definitive physiological importance.

13. Permutation Test

The permutation analysis produced:

Observed CV accuracy: 40.00%
Permutation mean: 48.14%
Permutation SD: 14.75 percentage points
Permutation minimum: 0.00%
Permutation maximum: 93.33%
Permutation p-value: 0.7772

The observed classification performance was not statistically distinguishable from the label-permutation null distribution at the 0.05 significance level.

Therefore, the current dataset does not provide strong statistical evidence that the classifier performs above the permutation baseline.

14. Current Scientific Interpretation

The V2.1 pipeline is operational and produces a complete end-to-end EEG analysis.

However, the current dataset contains only 15 trials from the available recording. Consequently:

Classification estimates are sensitive to individual trial composition.
Cross-validation performance is variable.
Feature separation does not demonstrate generalization.
SVM coefficients are model-level weights rather than definitive physiological biomarkers.
The analysis is not clinical validation.
Independent subjects and recordings have not yet been used for validation.
A substantially larger dataset is required for stronger conclusions.

The project should therefore be regarded as an exploratory EEG/BCI prototype, not a clinically validated diagnostic or classification system.

15. V2.1 Validity Checks

The final pipeline checks for invalid feature values and consistency between labels, trials, and features.

Current results
Combined feature NaN values: 0
Combined feature infinite values: 0
Number of labels: 15
Number of trials: 15
Number of features: 30

Validity status: PASS

The complete V2.1 execution reached:

PART 1AG COMPLETE
16. Repository Structure

The primary research files are organized as follows:

Neurosignal-Testbed/
│
├── neurobridge_eeg_pipeline_v2_1.py
├── mne_first_real_eeg.py
├── neurobridge_eeg_framework.py
│
├── eeg_feature_dataset.csv
├── model_comparison.csv
│
├── requirements.txt
├── README.md
├── LICENSE
├── .gitignore
│
├── Backups/
├── DEVELOPMENT_ARCHIVE/
└── __pycache__/              # local Python cache; should not be committed
Primary V2.1 pipeline

The main V2.1 refactored pipeline is:

neurobridge_eeg_pipeline_v2_1.py

The Backups/ and DEVELOPMENT_ARCHIVE/ directories are excluded from version control through .gitignore.

17. Installation

Create and activate a Python virtual environment, then install the required packages.

Create the environment
python -m venv .venv-mne
Activate the environment
.\.venv-mne\Scripts\Activate.ps1
Install dependencies
pip install -r requirements.txt

The project has been tested with:

MNE-Python: 1.12.1
18. Running the V2.1 Pipeline

From the project directory, first perform a Python syntax check:

python -m py_compile .\neurobridge_eeg_pipeline_v2_1.py

If the syntax check completes without an error, run:

python .\neurobridge_eeg_pipeline_v2_1.py

A successful complete execution ends with:

PART 1AG COMPLETE

The pipeline displays the restored EEG inspection figures and analytical visualizations during execution.

19. Reproducibility and Data

The repository is intended to contain the analysis code and documentation rather than a local Python virtual environment or unnecessary generated files.

The EEG recording is obtained through the MNE EEGBCI dataset workflow used by the analysis script.

Large raw EEG recordings and local environments should not be committed to the Git repository unless there is a specific reason and appropriate licensing/distribution permission.

20. Limitations

The current V2.1 prototype has several important limitations:

Only 15 EEG trials are currently analyzed.
The classification estimates are sensitive to the small sample size.
Repeated cross-validation demonstrates substantial variability.
There is no independent-subject validation in the current experiment.
Feature separation does not establish generalization.
SVM coefficients should not be treated as definitive physiological importance.
The permutation test does not provide evidence of above-chance classification in the present dataset.
The system has not undergone clinical validation.
The current analysis should not be used for medical diagnosis or clinical decision-making.
21. Recommended Next Stage

The next research stage should focus on increasing experimental and statistical robustness rather than simply optimizing the classifier.

Recommended directions include:

Increase the number of EEG trials.
Include multiple subjects.
Include independent recordings for validation.
Improve artifact detection and rejection.
Evaluate additional EEG features.
Compare multiple classifiers under the same validation framework.
Use subject-independent evaluation where appropriate.
Preserve strict separation between training and testing data.
Quantify uncertainty and confidence intervals.
Investigate whether identified EEG features remain stable across subjects.
22. Research Roadmap
V2.1
│
├── Real EEG loading                         ✓
├── EEG preprocessing                        ✓
├── Events and epochs                        ✓
├── ERP / GFP analysis                       ✓
├── Topographical analysis                   ✓
├── Feature engineering                      ✓
├── SVM classification                       ✓
├── Cross-validation                         ✓
├── Repeated validation                      ✓
├── Permutation testing                      ✓
└── Exploratory validation                   ✓
        │
        ▼
Next stage
│
├── Larger EEG datasets
├── Multi-subject validation
├── Independent test recordings
├── More robust artifact handling
├── Improved feature engineering
└── Stronger BCI generalization analysis
23. License

See the LICENSE file included in this repository.

24. Project Status

Neurosignal Testbed V2.1

STATUS: EXPLORATORY EEG PROTOTYPE VALIDATION

The analysis pipeline is operational. The present dataset is insufficient to establish generalizable classification performance.

The V2.1 release establishes a reproducible foundation for continued EEG signal-processing, BCI, machine-learning, and neuroengineering research.


### After pasting

Press:

**`Ctrl + S`**

Then **do not push yet**. We will verify the README first with these commands:

```powershell
Get-Content .\README.md -Encoding UTF8 -TotalCount 5

Then:

Get-Content .\README.md -Encoding UTF8 | Measure-Object -Line

Then:

git diff --check

And finally:

git status --short

### QEEG simulation lesson

The QEEG lab now opens a seeded simulation and frequency atlas without importing a recording. Its five views are **EEG → Geometry → Atlas → Metrics → Norms**. Adjust posterior alpha, frontal theta, central beta, alpha frequency, right alpha gain, 19/32 electrodes, reference and skull conductivity; regenerate to apply changes. A banner distinguishes changed controls from the last generated results.

`POST /qeeg/simulate` accepts `QeegLabRecipe`. MNE computes a four-layer spherical forward model for six radial dipoles; A1/A2 are explicitly generated for linked-mastoid reference. PSD uses all 32 s at 128 Hz, 4 s Hann windows, 50% overlap and 0.25 Hz bins. The trace preview contains the first 10 s. Band intervals partition `[1,45)` Hz. Scalp images use azimuthally projected template coordinates and inverse-distance interpolation with labeled per-map ranges (default) or a shared comparison scale; they are not cortical source estimates. Frequency maps span 1–45 Hz in three pages.

Metrics include absolute/relative band power, theta/beta, alpha maximum bin, median frequency, SEF95, normalized spectral entropy, `ln(alpha F4) − ln(alpha F3)`, magnitude-squared coherence, and band-filtered Hilbert PLV. Coherence averages 15 Welch windows before normalization; PLV trims one second from each edge. Reference and shared source mixing can inflate sensor connectivity.

The independent synthetic reference cohort has 20–200 members. Each member receives lognormally varying oscillation amplitudes, a varying alpha frequency/right alpha gain, independent phases, 1/f background and sensor noise, then the identical measurement/analysis pipeline. The cohort is fixed under subject-only changes. Comparison uses log absolute power, logit relative fractions, or log theta/beta, sample SD (`ddof=1`) z scores and empirical percentiles. No age, state or clinical population validity is claimed. JSON export contains the generated recipe, subject metrics, transformed individual cohort values, geometry, spectra and software versions.

The previous import/filter/ICA derivative workflow remains available through **Advanced: imported EEG**, and its API remains unchanged. The lesson specification is `lessons/qeeg/simulated-atlas.yaml`; the implementation boundary and validation record are in `qeeg_redesign_plan.md`.

### Password-protected remote access

Run `npm --prefix apps/web run build`, then `.venv/bin/python scripts/remote_access.py start` to start a production frontend and scientific API behind a temporary Cloudflare HTTPS tunnel. Requires `cloudflared` (`brew install cloudflared`). The remote server binds only `127.0.0.1:8765`; the local development services on 5174/8001 are unchanged. The frontend and every `/api` endpoint require HTTP Basic authentication. Use the generated username/password in `.remote-access/credentials.json` (owner-only permissions, ignored by Git). Anyone receiving those credentials can use the app's local-file analysis functions; share them only with intended users.

Use `.venv/bin/python scripts/remote_access.py status` for the current URL and `.venv/bin/python scripts/remote_access.py stop` to close external access. The URL changes when a new tunnel starts. Keep the Mac awake and connected; this is a temporary session, not an always-on hosted deployment. Rebuild the frontend after UI changes; restart remote access after Python changes. Credentials are reused across restarts.

The remote wrapper serves only the production `dist` assets, guards both frontend and API before routing, rejects cross-origin writes and disables caching. The original local-only API is mounted inside this wrapper rather than exposed directly. Cloudflare quick-tunnel setup: https://developers.cloudflare.com/tunnel/setup/.

### Direct router port forwarding (5174)

The development server listens on `0.0.0.0:5174`, accepts the explicit DDNS hostname `anselmjeong.synology.me`, and proxies `/api` to the loopback-only API on port 8001. Forward TCP external port 5174 to the Mac's LAN IP and internal port 5174 (verified as `192.168.0.9` on 2026-09-05; reserve this address in DHCP). Browse to `http://anselmjeong.synology.me:5174`, not `0.0.0.0`. Non-loopback requests require the existing `.remote-access/credentials.json` login before serving either frontend code or proxied API requests. Local loopback use does not require a login. Changing `Host` to an unrelated hostname remains blocked by Vite.

Port 5174 uses plain HTTP; it does not encrypt credentials or EEG traffic. Use the HTTPS tunnel above when transport encryption is required. The development server and API must both be running for direct access. The Mac's firewall need not be disabled; allow the specific service if a firewall is enabled.
