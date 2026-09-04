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

The connectivity challenge plants one lagged alpha-band edge in a four-node latent graph, projects
the sources into eight mixed scalp sensors, and estimates Pearson correlation, coherence, imaginary
coherence, PLV, PPC, PLI, or wPLI. Spectral estimators use MNE-Connectivity; Welch and multitaper
PSDs are shown beside a linear-input specparam
fit. Every edge is evaluated against the 95th percentile of epoch-shuffled maximum-edge surrogates;
the UI coordinates matrix, scalp, circle, spectrum, and null-distribution views while keeping
functional connectivity distinct from causality. Volume-conduction and reference-sensitivity lesson
fixtures preserve the same latent graph for direct comparison.

The source-modeling lab uses an explicitly illustrative 14-channel standard 10–20 spherical
volume template. It plants four ROI-proxy time courses, projects them with MNE's EEG forward
solution, reconstructs them with a locked minimum-norm inverse, and exposes reconstructed ROI
traces, forward lead fields, location error, and the MNE source-resolution cross-talk matrix.
The lesson labels this geometry as non-individualized throughout: source recovery is benchmarked
against planted simulation truth, and leakage is a required interpretation checkpoint.

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
