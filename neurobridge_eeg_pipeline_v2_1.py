"""
NeuroBridge-EEG V2.1
=====================

Real EEG analysis prototype using the EEGBCI dataset.

Pipeline:
    Real EEG
      -> Montage
      -> Preprocessing
      -> Events / Epochs
      -> ERP / GFP analysis
      -> Time-domain features
      -> Frequency-domain features
      -> Combined features
      -> Linear SVM
      -> Cross-validation
      -> Feature analysis
      -> Repeated CV stability
      -> Permutation testing
      -> Final validation summary

Research status:
    Exploratory EEG prototype validation.

Important:
    This implementation uses only 15 EEG trials from one recording.
    Results are exploratory and are not clinical validation or evidence
    of generalization to unseen subjects.

Dataset:
    MNE EEGBCI
    Subject 1
    Run 4

Reproducibility:
    random_state = 42
"""

# ============================================================
# IMPORTS
# ============================================================

import mne
import matplotlib.pyplot as plt
import numpy as np

from scipy import stats

from matplotlib.cm import ScalarMappable
from matplotlib.colors import Normalize
from matplotlib.ticker import FuncFormatter

from mne.datasets import eegbci
from mne.io import read_raw_edf

from sklearn.model_selection import (
    StratifiedKFold,
    RepeatedStratifiedKFold,
    train_test_split,
    cross_val_score,
    permutation_test_score,
)

from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC

from sklearn.metrics import (
    accuracy_score,
    precision_score,
    recall_score,
    f1_score,
    confusion_matrix,
    classification_report,
)


# ============================================================
# CONFIGURATION
# ============================================================

RANDOM_STATE = 42

SUBJECT = 1
RUNS = [4]

NOTCH_FREQUENCY = 60
FILTER_LOW = 1.0
FILTER_HIGH = 40.0

EPOCH_TMIN = -1.0
EPOCH_TMAX = 4.0

ANALYSIS_TMIN = 0.0
ANALYSIS_TMAX = 1.0

EEG_CHANNELS = ["C3", "Cz", "C4"]

FREQUENCY_BANDS = {
    "delta": (1, 4),
    "theta": (4, 8),
    "alpha": (8, 13),
    "beta": (13, 30),
    "gamma": (30, 40),
}

TEST_SIZE = 0.30

CV_FOLDS = 5
REPEATED_CV_FOLDS = 5
REPEATED_CV_REPEATS = 10

N_PERMUTATIONS = 1000


# ============================================================
# HELPER FUNCTIONS
# ============================================================


def create_svm_pipeline():
    """Create a leakage-safe StandardScaler + linear SVM pipeline."""

    return Pipeline(
        [
            ("scaler", StandardScaler()),
            (
                "svm",
                SVC(
                    kernel="linear",
                    random_state=RANDOM_STATE,
                ),
            ),
        ]
    )


def feature_names_for_time_domain(channels):
    """Generate time-domain feature names."""

    names = []

    for channel in channels:
        names.extend(
            [
                f"{channel}_mean",
                f"{channel}_std",
                f"{channel}_max",
                f"{channel}_min",
                f"{channel}_peak_to_peak",
            ]
        )

    return names


def feature_names_for_frequency_domain(channels, bands):
    """Generate frequency-domain feature names."""

    return [
        f"{channel}_{band}"
        for channel in channels
        for band in bands
    ]


def extract_time_features(epochs, channels):
    """Extract mean, SD, max, min and peak-to-peak amplitude."""

    data = epochs.get_data()
    channel_indices = [
        epochs.ch_names.index(channel)
        for channel in channels
    ]

    features = []

    for epoch in data:

        epoch_features = []

        for channel_index in channel_indices:

            signal_uv = epoch[channel_index] * 1e6

            maximum = np.max(signal_uv)
            minimum = np.min(signal_uv)

            epoch_features.extend(
                [
                    np.mean(signal_uv),
                    np.std(signal_uv),
                    maximum,
                    minimum,
                    maximum - minimum,
                ]
            )

        features.append(epoch_features)

    return np.asarray(features, dtype=float)


def extract_frequency_features(epochs, channels, bands):
    """Extract Welch mean band power for each channel and band."""

    data = epochs.get_data()

    channel_indices = [
        epochs.ch_names.index(channel)
        for channel in channels
    ]

    sfreq = epochs.info["sfreq"]

    features = []

    for epoch in data:

        epoch_features = []

        for channel_index in channel_indices:

            signal_uv = epoch[channel_index] * 1e6

            psd, frequencies = mne.time_frequency.psd_array_welch(
                signal_uv,
                sfreq=sfreq,
                fmin=1,
                fmax=40,
                n_fft=min(256, len(signal_uv)),
                verbose=False,
            )

            for low_freq, high_freq in bands.values():

                frequency_mask = (
                    (frequencies >= low_freq)
                    & (frequencies < high_freq)
                )

                if np.any(frequency_mask):
                    band_power = np.mean(
                        psd[frequency_mask]
                    )
                else:
                    band_power = 0.0

                epoch_features.append(band_power)

        features.append(epoch_features)

    return np.asarray(features, dtype=float)


def classification_metrics(y_true, y_pred):
    """Return standard binary classification metrics."""

    return {
        "accuracy": accuracy_score(y_true, y_pred),
        "precision": precision_score(
            y_true,
            y_pred,
            zero_division=0,
        ),
        "recall": recall_score(
            y_true,
            y_pred,
            zero_division=0,
        ),
        "f1": f1_score(
            y_true,
            y_pred,
            zero_division=0,
        ),
        "confusion_matrix": confusion_matrix(
            y_true,
            y_pred,
        ),
    }


def print_metric_summary(title, metrics):
    """Print a compact classification summary."""

    print(f"\n{title}")
    print("-" * len(title))

    print(f"Accuracy:  {metrics['accuracy']:.3f}")
    print(f"Precision: {metrics['precision']:.3f}")
    print(f"Recall:    {metrics['recall']:.3f}")
    print(f"F1-score:  {metrics['f1']:.3f}")

    print("\nConfusion matrix:")
    print(metrics["confusion_matrix"])


# ============================================================
# PART 1A: LOAD REAL EEG
# ============================================================

print("\n" + "=" * 60)
print("PART 1A: REAL EEG DATASET")
print("=" * 60)

print("MNE version:", mne.__version__)

raw_fnames = eegbci.load_data(
    SUBJECT,
    RUNS,
)

print("\nDownloaded EEG file:")
print(raw_fnames)

raw = read_raw_edf(
    raw_fnames[0],
    preload=True,
)

eegbci.standardize(raw)

# Apply the standard EEG sensor montage before creating epochs
# and evoked responses so that sensor locations are preserved.
montage = mne.channels.make_standard_montage("standard_1020")

raw.set_montage(
    montage,
    on_missing="ignore",
)

print("\nEEG montage:")
print(raw.get_montage())

print("\nEEG recording:")
print(raw)

# ============================================================
# RESTORED VISUALIZATIONS: RAW EEG
# ============================================================

print("\nRestored visualization: raw EEG")

raw.plot(
    duration=10,
    n_channels=10,
    scalings="auto",
    block=True
)


# ============================================================
# RESTORED VISUALIZATION: RAW EEG POWER SPECTRAL DENSITY
# ============================================================

print(
    "\nRestored visualization: "
    "raw EEG power spectral density"
)

raw.compute_psd(
    fmax=80
).plot()

plt.show(block=True)


# ============================================================
# PART 1B: EEG PREPROCESSING
# ============================================================

print("\n" + "=" * 60)
print("PART 1B: EEG PREPROCESSING")
print("=" * 60)

raw_filtered = raw.copy()

raw_filtered.notch_filter(
    freqs=NOTCH_FREQUENCY
)

raw_filtered.filter(
    l_freq=FILTER_LOW,
    h_freq=FILTER_HIGH,
)

print(
    f"Notch filter: {NOTCH_FREQUENCY} Hz"
)

print(
    f"Band-pass filter: "
    f"{FILTER_LOW}-{FILTER_HIGH} Hz"
)

# ============================================================
# RESTORED VISUALIZATIONS: FILTERED EEG
# ============================================================

print("\nRestored visualization: filtered EEG")

raw_filtered.plot(
    duration=10,
    n_channels=10,
    scalings="auto",
    block=True
)


# ============================================================
# RESTORED VISUALIZATION: FILTERED EEG POWER SPECTRAL DENSITY
# ============================================================

print(
    "\nRestored visualization: "
    "filtered EEG power spectral density"
)

raw_filtered.compute_psd(
    fmax=80
).plot()

plt.show(block=True)


# ============================================================
# PART 1C: EEG EVENTS AND EPOCHS
# ============================================================

print("\n" + "=" * 60)
print("PART 1C: EEG EVENTS AND EPOCHS")
print("=" * 60)

events, event_id = mne.events_from_annotations(
    raw_filtered
)

print("\nEvent IDs:")
print(event_id)

task_event_id = {
    "T1": 2,
    "T2": 3,
}

epochs = mne.Epochs(
    raw_filtered,
    events,
    event_id=task_event_id,
    tmin=EPOCH_TMIN,
    tmax=EPOCH_TMAX,
    baseline=(None, 0),
    preload=True,
)

t1_epochs = epochs["T1"]
t2_epochs = epochs["T2"]

print("\nEpoch summary:")
print(epochs)

print(
    "\nT1 trials:",
    len(t1_epochs),
)

print(
    "T2 trials:",
    len(t2_epochs),
)

# ============================================================
# RESTORED VISUALIZATION: EEG EVENT TIMELINE
# ============================================================

print("\nRestored visualization: EEG event timeline")

mne.viz.plot_events(
    events,
    sfreq=raw_filtered.info["sfreq"],
    first_samp=raw_filtered.first_samp
)

plt.show(block=True)


# ============================================================
# RESTORED VISUALIZATION: ALL TASK EPOCHS
# ============================================================

print("\nRestored visualization: all task epochs")

epochs.plot(
    n_epochs=5,
    n_channels=10,
    scalings="auto",
    block=True
)


# ============================================================
# RESTORED VISUALIZATION: T1 EPOCHS
# ============================================================

print("\nRestored visualization: T1 epochs")

epochs["T1"].plot(
    n_epochs=8,
    n_channels=10,
    scalings="auto",
    block=True
)


# ============================================================
# RESTORED VISUALIZATION: T2 EPOCHS
# ============================================================

print("\nRestored visualization: T2 epochs")

epochs["T2"].plot(
    n_epochs=7,
    n_channels=10,
    scalings="auto",
    block=True
)


# ============================================================
# PART 1D: EVOKED RESPONSES
# ============================================================

print("\n" + "=" * 60)
print("PART 1D: EVOKED RESPONSES")
print("=" * 60)

t1_evoked = t1_epochs.average()
t2_evoked = t2_epochs.average()

print("T1 evoked:", t1_evoked)
print("T2 evoked:", t2_evoked)

# ============================================================
# RESTORED VISUALIZATION: T1 AVERAGED 64-CHANNEL EEG
# ============================================================

print("\nRestored visualization: T1 averaged EEG")

t1_evoked.plot(
    show=True
)

plt.show(block=True)


# ============================================================
# RESTORED VISUALIZATION: T2 AVERAGED 64-CHANNEL EEG
# ============================================================

print("\nRestored visualization: T2 averaged EEG")

t2_evoked.plot(
    show=True
)

plt.show(block=True)

mne.viz.plot_compare_evokeds(
    {
        "T1": t1_evoked,
        "T2": t2_evoked,
    }
)

plt.show()


# ============================================================
# PART 1E: GLOBAL FIELD POWER
# ============================================================

print("\n" + "=" * 60)
print("PART 1E: GLOBAL FIELD POWER")
print("=" * 60)

t1_gfp_uv = (
    np.std(t1_evoked.data, axis=0) * 1e6
)

t2_gfp_uv = (
    np.std(t2_evoked.data, axis=0) * 1e6
)

times = t1_evoked.times

t1_peak_index = np.argmax(t1_gfp_uv)
t2_peak_index = np.argmax(t2_gfp_uv)

t1_peak_time = times[t1_peak_index]
t2_peak_time = times[t2_peak_index]

t1_peak_value = t1_gfp_uv[t1_peak_index]
t2_peak_value = t2_gfp_uv[t2_peak_index]

print(
    f"T1 peak GFP: "
    f"{t1_peak_value:.2f} µV "
    f"at {t1_peak_time:.3f} s"
)

print(
    f"T2 peak GFP: "
    f"{t2_peak_value:.2f} µV "
    f"at {t2_peak_time:.3f} s"
)

plt.figure(figsize=(10, 5))

plt.plot(
    times,
    t1_gfp_uv,
    label="T1",
)

plt.plot(
    times,
    t2_gfp_uv,
    label="T2",
)

plt.axvline(
    0,
    linestyle="--",
)

plt.xlabel("Time (s)")
plt.ylabel("GFP (µV)")
plt.title("Global Field Power: T1 vs T2")
plt.legend()
plt.grid(True)

plt.tight_layout()
plt.show()


# ============================================================
# PART 1F: EEG MONTAGE
# ============================================================

print("\n" + "=" * 60)
print("PART 1F: EEG MONTAGE")
print("=" * 60)

print("EEG sensor montage:")
print(raw.get_montage())

# ============================================================
# RESTORED VISUALIZATION: 64-CHANNEL EEG SENSOR POSITIONS
# ============================================================

print(
    "\nRestored visualization: "
    "64-channel EEG sensor positions"
)

raw.plot_sensors(
    ch_type="eeg",
    show_names=True,
    show=True
)

plt.show(block=True)


# ============================================================
# PART 1G: EEG TOPOGRAPHY
# ============================================================

print("\n" + "=" * 60)
print("PART 1G: EEG TOPOGRAPHICAL ANALYSIS")
print("=" * 60)

t1_peak_idx = np.argmin(
    np.abs(
        t1_evoked.times - t1_peak_time
    )
)

t2_peak_idx = np.argmin(
    np.abs(
        t2_evoked.times - t2_peak_time
    )
)

t1_peak_data = (
    t1_evoked.data[:, t1_peak_idx]
)

t2_peak_data = (
    t2_evoked.data[:, t2_peak_idx]
)

common_vmax = max(
    np.abs(t1_peak_data).max(),
    np.abs(t2_peak_data).max(),
)

print(
    f"Common topography scale: "
    f"±{common_vmax * 1e6:.2f} µV"
)

fig = plt.figure(
    figsize=(12, 5.5),
    constrained_layout=True,
)

grid = fig.add_gridspec(
    1,
    3,
    width_ratios=[1, 1, 0.06],
)

ax_t1 = fig.add_subplot(grid[0, 0])
ax_t2 = fig.add_subplot(grid[0, 1])
ax_cbar = fig.add_subplot(grid[0, 2])

t1_evoked.plot_topomap(
    times=[t1_peak_time],
    ch_type="eeg",
    axes=ax_t1,
    vlim=(-common_vmax, common_vmax),
    cmap="RdBu_r",
    colorbar=False,
    show=False,
    time_format=f"T1: {t1_peak_time:.3f} s",
)

t2_evoked.plot_topomap(
    times=[t2_peak_time],
    ch_type="eeg",
    axes=ax_t2,
    vlim=(-common_vmax, common_vmax),
    cmap="RdBu_r",
    colorbar=False,
    show=False,
    time_format=f"T2: {t2_peak_time:.3f} s",
)

norm = Normalize(
    vmin=-common_vmax,
    vmax=common_vmax,
)

scalar_mappable = ScalarMappable(
    norm=norm,
    cmap="RdBu_r",
)

scalar_mappable.set_array([])

colorbar = fig.colorbar(
    scalar_mappable,
    cax=ax_cbar,
)

colorbar.ax.yaxis.set_major_formatter(
    FuncFormatter(
        lambda value, position:
        f"{value * 1e6:.0f}"
    )
)

colorbar.set_label(
    "EEG amplitude (µV)"
)

fig.suptitle(
    "EEG Topography: T1 vs T2 at Peak GFP"
)

plt.show()


# ============================================================
# PART 1H: ERP COMPARISON
# ============================================================

print("\n" + "=" * 60)
print("PART 1H: ERP ANALYSIS")
print("=" * 60)

fig, axes = plt.subplots(
    len(EEG_CHANNELS),
    1,
    figsize=(12, 10),
    sharex=True,
)

for ax, channel in zip(
    axes,
    EEG_CHANNELS,
):

    index = t1_evoked.ch_names.index(
        channel
    )

    t1_signal = (
        t1_evoked.data[index] * 1e6
    )

    t2_signal = (
        t2_evoked.data[index] * 1e6
    )

    ax.plot(
        t1_evoked.times,
        t1_signal,
        label="T1",
    )

    ax.plot(
        t2_evoked.times,
        t2_signal,
        label="T2",
    )

    ax.axvline(
        0,
        linestyle="--",
        alpha=0.8,
    )

    ax.axhline(
        0,
        linestyle=":",
        alpha=0.8,
    )

    ax.set_ylabel("µV")
    ax.set_title(f"{channel} ERP")
    ax.legend()
    ax.grid(True, alpha=0.3)

axes[-1].set_xlabel("Time (s)")

fig.suptitle(
    "Central EEG ERP Comparison: T1 vs T2"
)

plt.tight_layout()
plt.show()


# ============================================================
# PART 1I: QUANTITATIVE ERP ANALYSIS
# ============================================================

print("\n" + "=" * 60)
print("PART 1I: QUANTITATIVE ERP ANALYSIS")
print("=" * 60)

time_mask = (
    (times >= ANALYSIS_TMIN)
    & (times <= ANALYSIS_TMAX)
)

for channel in EEG_CHANNELS:

    index = t1_evoked.ch_names.index(
        channel
    )

    t1_signal = (
        t1_evoked.data[index] * 1e6
    )

    t2_signal = (
        t2_evoked.data[index] * 1e6
    )

    t1_window = t1_signal[time_mask]
    t2_window = t2_signal[time_mask]

    t1_mean = np.mean(t1_window)
    t2_mean = np.mean(t2_window)

    print(f"\n{channel}")
    print(
        f"T1 mean: {t1_mean:.2f} µV"
    )
    print(
        f"T2 mean: {t2_mean:.2f} µV"
    )
    print(
        f"T1 - T2: "
        f"{t1_mean - t2_mean:.2f} µV"
    )


# ============================================================
# PART 1J: ERP DIFFERENCE
# ============================================================

print("\n" + "=" * 60)
print("PART 1J: ERP DIFFERENCE")
print("=" * 60)

fig, axes = plt.subplots(
    len(EEG_CHANNELS),
    1,
    figsize=(12, 10),
    sharex=True,
)

for ax, channel in zip(
    axes,
    EEG_CHANNELS,
):

    index = t1_evoked.ch_names.index(
        channel
    )

    difference = (
        t1_evoked.data[index]
        - t2_evoked.data[index]
    ) * 1e6

    ax.plot(
        t1_evoked.times,
        difference,
        label="T1 - T2",
    )

    ax.axvline(
        0,
        linestyle="--",
    )

    ax.axhline(
        0,
        linestyle=":",
    )

    ax.set_ylabel("µV")
    ax.set_title(
        f"{channel} ERP Difference"
    )
    ax.legend()
    ax.grid(True, alpha=0.3)

axes[-1].set_xlabel("Time (s)")

fig.suptitle(
    "ERP Difference: T1 - T2"
)

plt.tight_layout()
plt.show()


# ============================================================
# PART 1K: ERP PEAK ANALYSIS
# ============================================================

print("\n" + "=" * 60)
print("PART 1K: ERP PEAK ANALYSIS")
print("=" * 60)

analysis_times = times[time_mask]

for channel in EEG_CHANNELS:

    index = t1_evoked.ch_names.index(
        channel
    )

    t1_signal = (
        t1_evoked.data[index, time_mask]
        * 1e6
    )

    t2_signal = (
        t2_evoked.data[index, time_mask]
        * 1e6
    )

    t1_positive_index = np.argmax(
        t1_signal
    )

    t1_negative_index = np.argmin(
        t1_signal
    )

    t2_positive_index = np.argmax(
        t2_signal
    )

    t2_negative_index = np.argmin(
        t2_signal
    )

    t1_positive = t1_signal[
        t1_positive_index
    ]

    t1_negative = t1_signal[
        t1_negative_index
    ]

    t2_positive = t2_signal[
        t2_positive_index
    ]

    t2_negative = t2_signal[
        t2_negative_index
    ]

    t1_ptp = (
        t1_positive - t1_negative
    )

    t2_ptp = (
        t2_positive - t2_negative
    )

    print(f"\n{channel}")

    print(
        f"T1 positive peak: "
        f"{t1_positive:.2f} µV "
        f"at "
        f"{analysis_times[t1_positive_index]:.3f} s"
    )

    print(
        f"T1 negative peak: "
        f"{t1_negative:.2f} µV "
        f"at "
        f"{analysis_times[t1_negative_index]:.3f} s"
    )

    print(
        f"T1 peak-to-peak: "
        f"{t1_ptp:.2f} µV"
    )

    print(
        f"T2 positive peak: "
        f"{t2_positive:.2f} µV "
        f"at "
        f"{analysis_times[t2_positive_index]:.3f} s"
    )

    print(
        f"T2 negative peak: "
        f"{t2_negative:.2f} µV "
        f"at "
        f"{analysis_times[t2_negative_index]:.3f} s"
    )

    print(
        f"T2 peak-to-peak: "
        f"{t2_ptp:.2f} µV"
    )


# ============================================================
# PART 1L: STATISTICAL ERP COMPARISON
# ============================================================

print("\n" + "=" * 60)
print("PART 1L: STATISTICAL ERP COMPARISON")
print("=" * 60)

erp_statistics = {}

for channel in EEG_CHANNELS:

    index = t1_epochs.ch_names.index(
        channel
    )

    t1_data = (
        t1_epochs.get_data()[
            :,
            index,
            :
        ]
    )

    t2_data = (
        t2_epochs.get_data()[
            :,
            index,
            :
        ]
    )

    t1_window = (
        t1_data[:, time_mask]
    )

    t2_window = (
        t2_data[:, time_mask]
    )

    t1_epoch_means = (
        np.mean(
            t1_window,
            axis=1,
        ) * 1e6
    )

    t2_epoch_means = (
        np.mean(
            t2_window,
            axis=1,
        ) * 1e6
    )

    t_stat, p_value = stats.ttest_ind(
        t1_epoch_means,
        t2_epoch_means,
        equal_var=False,
    )

    n1 = len(t1_epoch_means)
    n2 = len(t2_epoch_means)

    mean1 = np.mean(t1_epoch_means)
    mean2 = np.mean(t2_epoch_means)

    std1 = np.std(
        t1_epoch_means,
        ddof=1,
    )

    std2 = np.std(
        t2_epoch_means,
        ddof=1,
    )

    pooled_std = np.sqrt(
        (
            (n1 - 1) * std1**2
            +
            (n2 - 1) * std2**2
        )
        /
        (n1 + n2 - 2)
    )

    cohens_d = (
        (mean1 - mean2)
        / pooled_std
    )

    erp_statistics[channel] = {
        "t_stat": t_stat,
        "p_value": p_value,
        "cohens_d": cohens_d,
        "t1_mean": mean1,
        "t2_mean": mean2,
    }

    print(f"\n{channel}")
    print(f"T1 mean: {mean1:.2f} µV")
    print(f"T2 mean: {mean2:.2f} µV")
    print(
        f"Welch t-statistic: {t_stat:.3f}"
    )
    print(f"p-value: {p_value:.4f}")
    print(f"Cohen's d: {cohens_d:.3f}")


# ============================================================
# PART 1M: TIME-DOMAIN EEG FEATURES
# ============================================================

print("\n" + "=" * 60)
print("PART 1M: TIME-DOMAIN FEATURES")
print("=" * 60)

t1_feature_epochs = (
    t1_epochs.copy().crop(
        tmin=ANALYSIS_TMIN,
        tmax=ANALYSIS_TMAX,
    )
)

t2_feature_epochs = (
    t2_epochs.copy().crop(
        tmin=ANALYSIS_TMIN,
        tmax=ANALYSIS_TMAX,
    )
)

feature_names = (
    feature_names_for_time_domain(
        EEG_CHANNELS
    )
)

X_T1 = extract_time_features(
    t1_feature_epochs,
    EEG_CHANNELS,
)

X_T2 = extract_time_features(
    t2_feature_epochs,
    EEG_CHANNELS,
)

X = np.vstack(
    [
        X_T1,
        X_T2,
    ]
)

y = np.concatenate(
    [
        np.zeros(
            len(X_T1),
            dtype=int,
        ),
        np.ones(
            len(X_T2),
            dtype=int,
        ),
    ]
)

print(
    "Time-domain feature matrix:",
    X.shape,
)

print(
    "Time-domain feature count:",
    len(feature_names),
)


# ============================================================
# PART 1N: FEATURE VISUALIZATION
# ============================================================

print("\n" + "=" * 60)
print("PART 1N: FEATURE VISUALIZATION")
print("=" * 60)

feature_x = "C3_std"
feature_y = "Cz_std"

x_index = feature_names.index(
    feature_x
)

y_index = feature_names.index(
    feature_y
)

t1_mask = y == 0
t2_mask = y == 1

plt.figure(figsize=(10, 7))

plt.scatter(
    X[t1_mask, x_index],
    X[t1_mask, y_index],
    label="T1",
    s=80,
)

plt.scatter(
    X[t2_mask, x_index],
    X[t2_mask, y_index],
    label="T2",
    s=80,
)

plt.xlabel(
    f"{feature_x} (µV)"
)

plt.ylabel(
    f"{feature_y} (µV)"
)

plt.title(
    f"Feature Space: "
    f"{feature_x} vs {feature_y}"
)

plt.legend()
plt.grid(True, alpha=0.3)
plt.tight_layout()
plt.show()


# ============================================================
# PART 1O: TIME-DOMAIN ML DATASET
# ============================================================

print("\n" + "=" * 60)
print("PART 1O: TIME-DOMAIN ML DATASET")
print("=" * 60)

X_train, X_test, y_train, y_test = (
    train_test_split(
        X,
        y,
        test_size=TEST_SIZE,
        random_state=RANDOM_STATE,
        stratify=y,
    )
)

time_scaler = StandardScaler()

X_train_scaled = (
    time_scaler.fit_transform(
        X_train
    )
)

X_test_scaled = (
    time_scaler.transform(
        X_test
    )
)

print(
    "Training:",
    X_train_scaled.shape,
)

print(
    "Testing:",
    X_test_scaled.shape,
)


# ============================================================
# PART 1P: INITIAL TIME-DOMAIN SVM
# ============================================================

print("\n" + "=" * 60)
print("PART 1P: TIME-DOMAIN SVM")
print("=" * 60)

svm_classifier = SVC(
    kernel="linear",
    random_state=RANDOM_STATE,
)

svm_classifier.fit(
    X_train_scaled,
    y_train,
)

y_pred = svm_classifier.predict(
    X_test_scaled
)

time_metrics = classification_metrics(
    y_test,
    y_pred,
)

accuracy = time_metrics["accuracy"]
precision = time_metrics["precision"]
recall = time_metrics["recall"]
f1 = time_metrics["f1"]
cm = time_metrics["confusion_matrix"]

print_metric_summary(
    "Time-domain SVM performance",
    time_metrics,
)


# ============================================================
# PART 1Q: CLASSIFICATION EVALUATION
# ============================================================

print("\n" + "=" * 60)
print("PART 1Q: CLASSIFICATION EVALUATION")
print("=" * 60)

print(
    classification_report(
        y_test,
        y_pred,
        target_names=["T1", "T2"],
        zero_division=0,
    )
)


# ============================================================
# PART 1R: CONFUSION MATRIX VISUALIZATION
# ============================================================

print("\n" + "=" * 60)
print("PART 1R: CONFUSION MATRIX")
print("=" * 60)

from sklearn.metrics import ConfusionMatrixDisplay

ConfusionMatrixDisplay(
    confusion_matrix=cm,
    display_labels=["T1", "T2"],
).plot()

plt.title(
    "Time-Domain SVM Confusion Matrix"
)

plt.tight_layout()
plt.show()


# ============================================================
# PART 1S: TIME-DOMAIN CROSS-VALIDATION
# ============================================================

print("\n" + "=" * 60)
print("PART 1S: TIME-DOMAIN CROSS-VALIDATION")
print("=" * 60)

cv = StratifiedKFold(
    n_splits=CV_FOLDS,
    shuffle=True,
    random_state=RANDOM_STATE,
)

time_cv_pipeline = create_svm_pipeline()

cv_scores = cross_val_score(
    time_cv_pipeline,
    X,
    y,
    cv=cv,
    scoring="accuracy",
)

cv_mean = np.mean(cv_scores)
cv_std = np.std(cv_scores)

print(
    f"Mean CV accuracy: "
    f"{cv_mean * 100:.2f}%"
)

print(
    f"CV standard deviation: "
    f"{cv_std * 100:.2f} percentage points"
)


# ============================================================
# PART 1T: FREQUENCY-DOMAIN FEATURES
# ============================================================

print("\n" + "=" * 60)
print("PART 1T: FREQUENCY-DOMAIN FEATURES")
print("=" * 60)

frequency_feature_names = (
    feature_names_for_frequency_domain(
        EEG_CHANNELS,
        FREQUENCY_BANDS,
    )
)

X_frequency_T1 = (
    extract_frequency_features(
        t1_feature_epochs,
        EEG_CHANNELS,
        FREQUENCY_BANDS,
    )
)

X_frequency_T2 = (
    extract_frequency_features(
        t2_feature_epochs,
        EEG_CHANNELS,
        FREQUENCY_BANDS,
    )
)

X_frequency = np.vstack(
    [
        X_frequency_T1,
        X_frequency_T2,
    ]
)

y_frequency = np.concatenate(
    [
        np.zeros(
            len(X_frequency_T1),
            dtype=int,
        ),
        np.ones(
            len(X_frequency_T2),
            dtype=int,
        ),
    ]
)

print(
    "Frequency-domain matrix:",
    X_frequency.shape,
)

print(
    "Frequency-domain feature count:",
    len(frequency_feature_names),
)


# ============================================================
# PART 1U: FREQUENCY-DOMAIN VISUALIZATION
# ============================================================

print("\n" + "=" * 60)
print("PART 1U: FREQUENCY-DOMAIN VISUALIZATION")
print("=" * 60)

for channel in EEG_CHANNELS:

    t1_means = []
    t2_means = []

    for band in FREQUENCY_BANDS:

        feature = f"{channel}_{band}"

        index = (
            frequency_feature_names.index(
                feature
            )
        )

        t1_means.append(
            np.mean(
                X_frequency_T1[
                    :,
                    index
                ]
            )
        )

        t2_means.append(
            np.mean(
                X_frequency_T2[
                    :,
                    index
                ]
            )
        )

    positions = np.arange(
        len(FREQUENCY_BANDS)
    )

    width = 0.35

    plt.figure(figsize=(10, 6))

    plt.bar(
        positions - width / 2,
        t1_means,
        width,
        label="T1",
    )

    plt.bar(
        positions + width / 2,
        t2_means,
        width,
        label="T2",
    )

    plt.xticks(
        positions,
        list(FREQUENCY_BANDS.keys()),
    )

    plt.xlabel("Frequency band")
    plt.ylabel("Mean power")

    plt.title(
        f"{channel}: "
        "T1 vs T2 Frequency-Domain Features"
    )

    plt.legend()
    plt.grid(
        axis="y",
        alpha=0.3,
    )

    plt.tight_layout()
    plt.show()


# ============================================================
# PART 1V: COMBINED FEATURES
# ============================================================

print("\n" + "=" * 60)
print("PART 1V: COMBINED EEG FEATURES")
print("=" * 60)

combined_feature_names = (
    feature_names
    +
    frequency_feature_names
)

X_combined = np.hstack(
    [
        X,
        X_frequency,
    ]
)

y_combined = y.copy()

X_combined_T1 = X_combined[
    y_combined == 0
]

X_combined_T2 = X_combined[
    y_combined == 1
]

print(
    "Combined feature matrix:",
    X_combined.shape,
)

print(
    "Combined feature count:",
    len(combined_feature_names),
)

print(
    "T1 trials:",
    np.sum(y_combined == 0),
)

print(
    "T2 trials:",
    np.sum(y_combined == 1),
)


# ============================================================
# PART 1W: COMBINED-FEATURE ML PREPARATION
# ============================================================

print("\n" + "=" * 60)
print("PART 1W: COMBINED-FEATURE PREPARATION")
print("=" * 60)

(
    X_train_combined,
    X_test_combined,
    y_train_combined,
    y_test_combined,
) = train_test_split(
    X_combined,
    y_combined,
    test_size=TEST_SIZE,
    random_state=RANDOM_STATE,
    stratify=y_combined,
)

combined_scaler = StandardScaler()

X_train_combined_scaled = (
    combined_scaler.fit_transform(
        X_train_combined
    )
)

X_test_combined_scaled = (
    combined_scaler.transform(
        X_test_combined
    )
)

print(
    "Training:",
    X_train_combined_scaled.shape,
)

print(
    "Testing:",
    X_test_combined_scaled.shape,
)


# ============================================================
# PART 1X: COMBINED-FEATURE SVM
# ============================================================

print("\n" + "=" * 60)
print("PART 1X: COMBINED-FEATURE SVM")
print("=" * 60)

svm_combined = SVC(
    kernel="linear",
    random_state=RANDOM_STATE,
)

svm_combined.fit(
    X_train_combined_scaled,
    y_train_combined,
)

y_pred_combined = (
    svm_combined.predict(
        X_test_combined_scaled
    )
)

combined_metrics = classification_metrics(
    y_test_combined,
    y_pred_combined,
)

combined_accuracy = (
    combined_metrics["accuracy"]
)

print_metric_summary(
    "Combined-feature SVM performance",
    combined_metrics,
)


accuracy_change = (
    combined_accuracy
    -
    accuracy
)

print(
    f"\nAccuracy change vs time-domain: "
    f"{accuracy_change * 100:+.2f} percentage points"
)


# ============================================================
# PART 1Y: COMBINED-FEATURE EVALUATION
# ============================================================

print("\n" + "=" * 60)
print("PART 1Y: COMBINED-FEATURE EVALUATION")
print("=" * 60)

combined_precision = (
    combined_metrics["precision"]
)

combined_recall = (
    combined_metrics["recall"]
)

combined_f1 = (
    combined_metrics["f1"]
)

combined_cm = (
    combined_metrics["confusion_matrix"]
)

print(
    classification_report(
        y_test_combined,
        y_pred_combined,
        target_names=["T1", "T2"],
        zero_division=0,
    )
)


# ============================================================
# PART 1Z: COMBINED-FEATURE CROSS-VALIDATION
# ============================================================

print("\n" + "=" * 60)
print("PART 1Z: COMBINED-FEATURE CROSS-VALIDATION")
print("=" * 60)

cv_combined = StratifiedKFold(
    n_splits=CV_FOLDS,
    shuffle=True,
    random_state=RANDOM_STATE,
)

svm_cv_combined = create_svm_pipeline()

cv_scores_combined = cross_val_score(
    svm_cv_combined,
    X_combined,
    y_combined,
    cv=cv_combined,
    scoring="accuracy",
)

cv_mean_combined = np.mean(
    cv_scores_combined
)

cv_std_combined = np.std(
    cv_scores_combined
)

print(
    f"Mean CV accuracy: "
    f"{cv_mean_combined * 100:.2f}%"
)

print(
    f"CV standard deviation: "
    f"{cv_std_combined * 100:.2f} "
    "percentage points"
)


# ============================================================
# PART 1AA: FEATURE REPRESENTATION COMPARISON
# ============================================================

print("\n" + "=" * 60)
print("PART 1AA: FEATURE REPRESENTATION COMPARISON")
print("=" * 60)

cv_comparison = StratifiedKFold(
    n_splits=CV_FOLDS,
    shuffle=True,
    random_state=RANDOM_STATE,
)

time_cv_scores = cross_val_score(
    create_svm_pipeline(),
    X,
    y,
    cv=cv_comparison,
    scoring="accuracy",
)

frequency_cv_scores = cross_val_score(
    create_svm_pipeline(),
    X_frequency,
    y_frequency,
    cv=cv_comparison,
    scoring="accuracy",
)

combined_cv_scores = cross_val_score(
    create_svm_pipeline(),
    X_combined,
    y_combined,
    cv=cv_comparison,
    scoring="accuracy",
)

time_mean = np.mean(
    time_cv_scores
)

frequency_mean = np.mean(
    frequency_cv_scores
)

combined_mean = np.mean(
    combined_cv_scores
)

time_std = np.std(
    time_cv_scores
)

frequency_std = np.std(
    frequency_cv_scores
)

combined_std = np.std(
    combined_cv_scores
)

print(
    f"Time-domain: "
    f"{time_mean * 100:.2f}% "
    f"+/- {time_std * 100:.2f}"
)

print(
    f"Frequency-domain: "
    f"{frequency_mean * 100:.2f}% "
    f"+/- {frequency_std * 100:.2f}"
)

print(
    f"Combined: "
    f"{combined_mean * 100:.2f}% "
    f"+/- {combined_std * 100:.2f}"
)

representation_means = {
    "Time-domain": time_mean,
    "Frequency-domain": frequency_mean,
    "Combined": combined_mean,
}

best_representation = max(
    representation_means,
    key=representation_means.get,
)

print(
    "\nBest-performing representation:",
    best_representation,
)


# ============================================================
# PART 1AB: INDIVIDUAL FEATURE ANALYSIS
# ============================================================

print("\n" + "=" * 60)
print("PART 1AB: INDIVIDUAL FEATURE ANALYSIS")
print("=" * 60)

feature_results = []

X_t1 = X_combined[
    y_combined == 0
]

X_t2 = X_combined[
    y_combined == 1
]

for index, feature_name in enumerate(
    combined_feature_names
):

    t1_mean = np.mean(
        X_t1[:, index]
    )

    t2_mean = np.mean(
        X_t2[:, index]
    )

    absolute_difference = abs(
        t1_mean - t2_mean
    )

    mean_magnitude = (
        abs(t1_mean)
        +
        abs(t2_mean)
    ) / 2

    if mean_magnitude != 0:

        percentage_difference = (
            absolute_difference
            /
            mean_magnitude
        ) * 100

    else:

        percentage_difference = 0.0

    feature_results.append(
        {
            "feature": feature_name,
            "t1_mean": t1_mean,
            "t2_mean": t2_mean,
            "absolute_difference": (
                absolute_difference
            ),
            "percentage_difference": (
                percentage_difference
            ),
        }
    )

feature_results_sorted = sorted(
    feature_results,
    key=lambda item:
        item["absolute_difference"],
    reverse=True,
)

print("\nTop 10 features:")

for rank, result in enumerate(
    feature_results_sorted[:10],
    start=1,
):

    print(
        f"{rank}. "
        f"{result['feature']} | "
        f"difference = "
        f"{result['absolute_difference']:.6f}"
    )

best_feature = (
    feature_results_sorted[0]
)

top_5_ab_features = [
    result["feature"]
    for result
    in feature_results_sorted[:5]
]


# ============================================================
# PART 1AC: TOP-FEATURE VISUALIZATION
# ============================================================

print("\n" + "=" * 60)
print("PART 1AC: TOP-FEATURE VISUALIZATION")
print("=" * 60)

top_feature_indices = [
    combined_feature_names.index(
        feature
    )
    for feature in top_5_ab_features
]

for feature, index in zip(
    top_5_ab_features,
    top_feature_indices,
):

    plt.figure(figsize=(9, 6))

    plt.scatter(
        np.arange(
            np.sum(t1_mask)
        ),
        X_combined[
            t1_mask,
            index
        ],
        label="T1",
        s=80,
    )

    plt.scatter(
        np.arange(
            np.sum(t2_mask)
        ),
        X_combined[
            t2_mask,
            index
        ],
        label="T2",
        s=80,
    )

    plt.xlabel("Trial index")
    plt.ylabel(feature)

    plt.title(
        f"Trial-Level Comparison: "
        f"{feature}"
    )

    plt.legend()
    plt.grid(True, alpha=0.3)
    plt.tight_layout()
    plt.show()


# ============================================================
# PART 1AD: LINEAR SVM FEATURE WEIGHTS
# ============================================================

print("\n" + "=" * 60)
print("PART 1AD: SVM FEATURE WEIGHTS")
print("=" * 60)

svm_feature_analysis = SVC(
    kernel="linear",
    random_state=RANDOM_STATE,
)

svm_feature_analysis.fit(
    X_train_combined_scaled,
    y_train_combined,
)

svm_coefficients = (
    svm_feature_analysis.coef_[0]
)

absolute_coefficients = np.abs(
    svm_coefficients
)

feature_weight_results = list(
    zip(
        combined_feature_names,
        svm_coefficients,
        absolute_coefficients,
    )
)

feature_weight_results_sorted = sorted(
    feature_weight_results,
    key=lambda item: item[2],
    reverse=True,
)

strongest_svm_feature = (
    feature_weight_results_sorted[0]
)

print(
    "Strongest SVM feature:",
    strongest_svm_feature[0],
)

print(
    "Coefficient:",
    f"{strongest_svm_feature[1]:.6f}",
)

print(
    "Absolute coefficient:",
    f"{strongest_svm_feature[2]:.6f}",
)

print("\nTop 10 SVM features:")

for rank, result in enumerate(
    feature_weight_results_sorted[:10],
    start=1,
):

    print(
        f"{rank}. "
        f"{result[0]} | "
        f"|coefficient| = "
        f"{result[2]:.6f}"
    )

print(
    "\nCoefficient validity:"
)

print(
    "NaN:",
    np.isnan(
        svm_coefficients
    ).sum(),
)

print(
    "Infinite:",
    np.isinf(
        svm_coefficients
    ).sum(),
)


# ============================================================
# PART 1AE: REPEATED CROSS-VALIDATION
# ============================================================

print("\n" + "=" * 60)
print("PART 1AE: REPEATED CROSS-VALIDATION")
print("=" * 60)

cv_stability = RepeatedStratifiedKFold(
    n_splits=REPEATED_CV_FOLDS,
    n_repeats=REPEATED_CV_REPEATS,
    random_state=RANDOM_STATE,
)

svm_stability_pipeline = (
    create_svm_pipeline()
)

cv_stability_scores = cross_val_score(
    svm_stability_pipeline,
    X_combined,
    y_combined,
    cv=cv_stability,
    scoring="accuracy",
)

mean_cv_accuracy = np.mean(
    cv_stability_scores
)

std_cv_accuracy = np.std(
    cv_stability_scores
)

min_cv_accuracy = np.min(
    cv_stability_scores
)

max_cv_accuracy = np.max(
    cv_stability_scores
)

print(
    "Validation scores:",
    len(cv_stability_scores),
)

print(
    f"Mean accuracy: "
    f"{mean_cv_accuracy * 100:.2f}%"
)

print(
    f"Standard deviation: "
    f"{std_cv_accuracy * 100:.2f} "
    "percentage points"
)

print(
    f"Minimum accuracy: "
    f"{min_cv_accuracy * 100:.2f}%"
)

print(
    f"Maximum accuracy: "
    f"{max_cv_accuracy * 100:.2f}%"
)

print(
    "NaN scores:",
    np.isnan(
        cv_stability_scores
    ).sum(),
)

print(
    "Infinite scores:",
    np.isinf(
        cv_stability_scores
    ).sum(),
)


# ------------------------------------------------------------
# SVM coefficient stability
# ------------------------------------------------------------

coefficient_matrix = []
fold_feature_ranks = []

for train_indices, validation_indices in (
    cv_stability.split(
        X_combined,
        y_combined,
    )
):

    fold_scaler = StandardScaler()

    X_fold_train_scaled = (
        fold_scaler.fit_transform(
            X_combined[
                train_indices
            ]
        )
    )

    fold_svm = SVC(
        kernel="linear",
        random_state=RANDOM_STATE,
    )

    fold_svm.fit(
        X_fold_train_scaled,
        y_combined[
            train_indices
        ],
    )

    fold_coefficients = (
        fold_svm.coef_[0]
    )

    coefficient_matrix.append(
        fold_coefficients
    )

    fold_feature_ranks.append(
        np.argsort(
            np.abs(
                fold_coefficients
            )
        )[::-1]
    )

coefficient_matrix = np.asarray(
    coefficient_matrix
)

mean_absolute_coefficients = np.mean(
    np.abs(
        coefficient_matrix
    ),
    axis=0,
)

std_absolute_coefficients = np.std(
    np.abs(
        coefficient_matrix
    ),
    axis=0,
)

feature_stability_results = [
    (
        feature_name,
        mean_absolute_coefficients[index],
        std_absolute_coefficients[index],
    )
    for index, feature_name
    in enumerate(
        combined_feature_names
    )
]

feature_stability_results_sorted = sorted(
    feature_stability_results,
    key=lambda item: item[1],
    reverse=True,
)

top_10_counts = np.zeros(
    len(combined_feature_names),
    dtype=int,
)

for fold_ranks in fold_feature_ranks:

    for feature_index in fold_ranks[:10]:

        top_10_counts[
            feature_index
        ] += 1

ranking_stability_results = [
    (
        feature_name,
        top_10_counts[index],
    )
    for index, feature_name
    in enumerate(
        combined_feature_names
    )
]

ranking_stability_results_sorted = sorted(
    ranking_stability_results,
    key=lambda item: item[1],
    reverse=True,
)

print(
    "\nTop 10 features by mean "
    "absolute SVM coefficient:"
)

for rank, result in enumerate(
    feature_stability_results_sorted[:10],
    start=1,
):

    print(
        f"{rank}. "
        f"{result[0]} | "
        f"Mean |coefficient| = "
        f"{result[1]:.6f} | "
        f"SD = {result[2]:.6f}"
    )

print(
    "\nFeature appearance frequency "
    "in SVM top 10:"
)

for rank, result in enumerate(
    ranking_stability_results_sorted[:10],
    start=1,
):

    print(
        f"{rank}. "
        f"{result[0]}: "
        f"{result[1]}/"
        f"{len(fold_feature_ranks)} "
        "validations"
    )


# ============================================================
# PART 1AF: PERMUTATION TEST
# ============================================================

print("\n" + "=" * 60)
print("PART 1AF: PERMUTATION TEST")
print("=" * 60)

cv_permutation = StratifiedKFold(
    n_splits=CV_FOLDS,
    shuffle=True,
    random_state=RANDOM_STATE,
)

svm_permutation_pipeline = (
    create_svm_pipeline()
)

(
    observed_score,
    permutation_scores,
    pvalue,
) = permutation_test_score(
    svm_permutation_pipeline,
    X_combined,
    y_combined,
    scoring="accuracy",
    cv=cv_permutation,
    n_permutations=N_PERMUTATIONS,
    random_state=RANDOM_STATE,
    n_jobs=-1,
)

permutation_mean = np.mean(
    permutation_scores
)

permutation_std = np.std(
    permutation_scores
)

permutation_min = np.min(
    permutation_scores
)

permutation_max = np.max(
    permutation_scores
)

print(
    f"Observed CV accuracy: "
    f"{observed_score * 100:.2f}%"
)

print(
    f"Permutation mean: "
    f"{permutation_mean * 100:.2f}%"
)

print(
    f"Permutation SD: "
    f"{permutation_std * 100:.2f} "
    "percentage points"
)

print(
    f"Permutation minimum: "
    f"{permutation_min * 100:.2f}%"
)

print(
    f"Permutation maximum: "
    f"{permutation_max * 100:.2f}%"
)

print(
    f"Permutation p-value: "
    f"{pvalue:.4f}"
)

print(
    "NaN permutation scores:",
    np.isnan(
        permutation_scores
    ).sum(),
)

print(
    "Infinite permutation scores:",
    np.isinf(
        permutation_scores
    ).sum(),
)


# ============================================================
# PART 1AG: FINAL V2.1 VALIDATION SUMMARY
# ============================================================

print("\n" + "=" * 60)
print("PART 1AG: FINAL V2.1 RESULTS SUMMARY")
print("=" * 60)

trial_count = X_combined.shape[0]
feature_count = X_combined.shape[1]
label_count = len(y_combined)

combined_nan_count = int(
    np.isnan(
        X_combined
    ).sum()
)

combined_inf_count = int(
    np.isinf(
        X_combined
    ).sum()
)

validity_pass = (
    combined_nan_count == 0
    and combined_inf_count == 0
    and label_count == trial_count
)

print("\nDataset summary:")

print(
    "Number of EEG trials:",
    trial_count,
)

print(
    "Number of combined features:",
    feature_count,
)

print(
    "Number of time-domain features:",
    X.shape[1],
)

print(
    "Number of frequency-domain features:",
    X_frequency.shape[1],
)

print(
    "T1 trials:",
    int(
        np.sum(
            y_combined == 0
        )
    ),
)

print(
    "T2 trials:",
    int(
        np.sum(
            y_combined == 1
        )
    ),
)


print("\nFeature representation summary:")

print(
    "Time-domain:",
    X.shape,
)

print(
    "Frequency-domain:",
    X_frequency.shape,
)

print(
    "Combined:",
    X_combined.shape,
)


print("\nInitial SVM classification:")

print(
    f"Time-domain test accuracy: "
    f"{accuracy * 100:.2f}%"
)

print(
    f"Combined-feature test accuracy: "
    f"{combined_accuracy * 100:.2f}%"
)


print(
    "\nFeature-representation cross-validation:"
)

print(
    f"Time-domain mean CV accuracy: "
    f"{time_mean * 100:.2f}%"
)

print(
    f"Frequency-domain mean CV accuracy: "
    f"{frequency_mean * 100:.2f}%"
)

print(
    f"Combined-feature mean CV accuracy: "
    f"{combined_mean * 100:.2f}%"
)


print(
    "\nRepeated cross-validation stability:"
)

print(
    f"Mean accuracy: "
    f"{mean_cv_accuracy * 100:.2f}%"
)

print(
    f"Standard deviation: "
    f"{std_cv_accuracy * 100:.2f} "
    "percentage points"
)

print(
    f"Minimum accuracy: "
    f"{min_cv_accuracy * 100:.2f}%"
)

print(
    f"Maximum accuracy: "
    f"{max_cv_accuracy * 100:.2f}%"
)


print("\nPermutation test:")

print(
    f"Observed CV accuracy: "
    f"{observed_score * 100:.2f}%"
)

print(
    f"Permutation mean accuracy: "
    f"{permutation_mean * 100:.2f}%"
)

print(
    f"Permutation standard deviation: "
    f"{permutation_std * 100:.2f} "
    "percentage points"
)

print(
    f"Permutation p-value: "
    f"{pvalue:.4f}"
)


print("\nExploratory feature findings:")

print(
    "Top T1-T2 mean-separation features:"
)

for rank, feature in enumerate(
    top_5_ab_features,
    start=1,
):

    print(
        f"{rank}. {feature}"
    )


print("\nSVM feature-weight findings:")

print(
    "Strongest single SVM coefficient:"
)

print(
    "Feature:",
    strongest_svm_feature[0],
)

print(
    "Coefficient:",
    f"{strongest_svm_feature[1]:.6f}",
)

print(
    "Absolute coefficient:",
    f"{strongest_svm_feature[2]:.6f}",
)


print("\nRepeated-CV feature stability:")

most_frequent_feature = (
    ranking_stability_results_sorted[0]
)

print(
    "Most frequently appearing feature:",
    most_frequent_feature[0],
)

print(
    "Appearance:",
    f"{most_frequent_feature[1]}/"
    f"{len(fold_feature_ranks)}",
)


print("\nStatistical interpretation:")

if pvalue < 0.05:

    print(
        "The observed classification performance "
        "was statistically distinguishable from "
        "the permutation null distribution at "
        "the 0.05 significance level."
    )

else:

    print(
        "The observed classification performance "
        "was not statistically distinguishable from "
        "the permutation null distribution at "
        "the 0.05 significance level."
    )

    print(
        "The current dataset does not provide strong "
        "statistical evidence that the classifier "
        "performs above the label-permutation baseline."
    )


print("\nV2.1 limitations:")

print(
    "1. Only 15 EEG trials are currently available."
)

print(
    "2. Classification estimates are sensitive "
    "to individual trial composition."
)

print(
    "3. Repeated cross-validation shows substantial "
    "performance variability."
)

print(
    "4. Feature separation does not establish "
    "generalization to unseen subjects or recordings."
)

print(
    "5. SVM coefficients are model-level weights, "
    "not definitive physiological importance."
)

print(
    "6. The present analysis is not clinical validation."
)

print(
    "7. Larger datasets and independent validation "
    "are required."
)


print("\nFinal V2.1 validity checks:")

print(
    "Combined feature NaN values:",
    combined_nan_count,
)

print(
    "Combined feature infinite values:",
    combined_inf_count,
)

print(
    "Number of labels:",
    label_count,
)

print(
    "Number of trials:",
    trial_count,
)

print(
    "Number of features:",
    feature_count,
)

print(
    "Validity status:",
    "PASS"
    if validity_pass
    else "CHECK REQUIRED",
)


print("\nV2.1 research status:")

print(
    "STATUS: EXPLORATORY EEG PROTOTYPE VALIDATION"
)

print(
    "The analysis pipeline is operational, "
    "but the current dataset is insufficient "
    "to establish generalizable classification "
    "performance."
)

print(
    "Recommended next stage: increase the number "
    "of EEG trials and preferably include independent "
    "subjects and recordings for validation."
)


print("\n" + "=" * 60)
print("PART 1AG COMPLETE")
print("=" * 60)