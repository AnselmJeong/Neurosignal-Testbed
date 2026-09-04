"""
Neurosignal Testbed
==================

File:
    neurobridge_eeg_framework.py

Purpose:
    Neurosignal Testbed is an open-source neuroengineering research
    framework for simulated EEG signal processing, feature extraction,
    supervised machine learning, and neurological signal analysis.

Processing Pipeline:
    Simulated EEG
        ↓
    Noise Simulation
        ↓
    Butterworth Band-Pass Filtering
        ↓
    FFT Analysis
        ↓
    Welch Power Spectral Density
        ↓
    EEG Band-Power Features
        ↓
    Machine Learning Dataset
        ↓
    Six Classification Models
        ↓
    Model Evaluation
        ↓
    Performance Comparison

Scientific Scope:
    V2.0 uses simulated EEG signals and synthetic demonstration labels.
    It is an educational research framework and is not a clinically
    validated diagnostic system.

Author:
    Mishael Chukwuemeka Ugwuodoh

Institution:
    Utel University

Degree Program:
    Bachelor of Computer Engineering
"""



# =============================================================================
# Development Status
# =============================================================================
#
# Current implementation:
# • Simulated EEG signal generation
# • EEG signal preprocessing
# • FFT and PSD analysis
# • EEG band-power feature extraction
# • Supervised machine-learning classification
# • Model performance evaluation
#
# Planned development:
# • Arduino-based EEG acquisition
# • Real-time EEG streaming
# • Brain-computer interface (BCI) research
# • Deep learning
# • Embedded artificial intelligence
# • Neuro-robotics research
# • Intelligent neurological monitoring
#
# =============================================================================



# =============================================================================
# Import Libraries
# =============================================================================


import numpy as np
import matplotlib.pyplot as plt
import pandas as pd

from scipy import signal
from scipy.fft import fft, fftfreq

from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler

from sklearn.linear_model import LogisticRegression
from sklearn.tree import DecisionTreeClassifier
from sklearn.ensemble import RandomForestClassifier
from sklearn.svm import SVC
from sklearn.neighbors import KNeighborsClassifier
from sklearn.naive_bayes import GaussianNB

from sklearn.metrics import (
    accuracy_score,
    confusion_matrix,
    precision_score,
    recall_score,
    f1_score,
)


# =============================================================================
# Reproducibility
# =============================================================================

# Fix the random seed so simulated noise and stochastic models are reproducible.

RANDOM_SEED = 42

np.random.seed(RANDOM_SEED)


# =============================================================================
# Function: Calculate EEG Band Power
# =============================================================================

def calculate_band_power(
    frequencies,
    psd,
    band
):
    """
    Calculate spectral power within an EEG frequency band
    from a Welch PSD estimate.

    Parameters
    ----------
    frequencies : numpy.ndarray
        Frequencies corresponding to the PSD estimate.

    psd : numpy.ndarray
        Power Spectral Density values.

    band : tuple
        Lower and upper frequency limits in Hz.

    Returns
    -------
    float
        Integrated spectral power within the selected band.
    """

    # Use a half-open interval so adjacent EEG bands do not overlap.

    band_indices = (
        (frequencies >= band[0]) &
        (frequencies < band[1])
    )

    band_frequencies = frequencies[band_indices]
    band_psd = psd[band_indices]

    return np.trapezoid(
        band_psd,
        band_frequencies
    )


# =============================================================================
# Function: Process One EEG Recording
# =============================================================================

def process_eeg_recording(
    show_plot: bool = False
) -> np.ndarray:
    """
    Simulate and process one EEG recording.

    Returns
    -------
    numpy.ndarray
        Ten-element EEG feature vector containing absolute
        and relative band-power features.
    """

    # -------------------------------------------------------------------------
    # EEG Signal Simulation
    # -------------------------------------------------------------------------

    sampling_rate = 250
    duration = 5

    num_samples = int(
        sampling_rate * duration
    )

    time = np.arange(
        num_samples
    ) / sampling_rate

    # Generate a synthetic 10-Hz alpha-band EEG-like waveform.

    alpha_frequency = 10
    signal_amplitude = 50  # µV

    eeg_signal = signal_amplitude * np.sin(
        2 * np.pi * alpha_frequency * time
    )

    # -------------------------------------------------------------------------
    # Noise Simulation
    # -------------------------------------------------------------------------

    noise_standard_deviation = 20  # µV

    noise = noise_standard_deviation * np.random.randn(
        len(time)
    )

    noisy_eeg_signal = eeg_signal + noise

    # -------------------------------------------------------------------------
    # Butterworth Band-Pass Filtering
    # -------------------------------------------------------------------------

    low_cutoff = 0.5
    high_cutoff = 40.0
    filter_order = 4

    sos = signal.butter(
        filter_order,
        [
            low_cutoff,
            high_cutoff
        ],
        btype="bandpass",
        fs=sampling_rate,
        output="sos"
    )

    # Zero-phase filtering is appropriate for this offline analysis pipeline.

    filtered_eeg_signal = signal.sosfiltfilt(
        sos,
        noisy_eeg_signal
    )

    # -------------------------------------------------------------------------
    # EEG Signal Visualization
    # -------------------------------------------------------------------------

    if show_plot:

        fig, ax = plt.subplots(
            figsize=(12, 6)
        )

        ax.plot(
            time,
            noisy_eeg_signal,
            label="Simulated Noisy EEG",
            alpha=0.6
        )

        ax.plot(
            time,
            filtered_eeg_signal,
            label="Filtered Simulated EEG",
            linewidth=2
        )

        ax.set_title(
            "Simulated Noisy and Filtered EEG Signals"
        )

        ax.set_xlabel(
            "Time (seconds)"
        )

        ax.set_ylabel(
            "Amplitude (µV)"
        )

        ax.legend()

        fig.tight_layout()

        plt.show()
        plt.close(fig)

    # -------------------------------------------------------------------------
    # Frequency-Domain Analysis
    # -------------------------------------------------------------------------

    number_of_samples = len(
        filtered_eeg_signal
    )

    fft_values = fft(
        filtered_eeg_signal
    )

    frequencies = fftfreq(
        number_of_samples,
        1 / sampling_rate
    )

    fft_magnitude = np.abs(
        fft_values
    )

    # FFT provides frequency-domain analysis; Welch PSD is used below
    # for quantitative band-power feature extraction.

    _ = frequencies
    _ = fft_magnitude

    # -------------------------------------------------------------------------
    # Welch Power Spectral Density
    # -------------------------------------------------------------------------

    frequencies_psd, psd = signal.welch(
        filtered_eeg_signal,
        fs=sampling_rate
    )

    # -------------------------------------------------------------------------
    # EEG Frequency Bands
    # -------------------------------------------------------------------------

    delta_band = (
        0.5,
        4.0
    )

    theta_band = (
        4.0,
        8.0
    )

    alpha_band = (
        8.0,
        13.0
    )

    beta_band = (
        13.0,
        30.0
    )

    gamma_band = (
        30.0,
        40.0
    )

    # -------------------------------------------------------------------------
    # Absolute EEG Band Power
    # -------------------------------------------------------------------------

    delta_power = calculate_band_power(
        frequencies_psd,
        psd,
        delta_band
    )

    theta_power = calculate_band_power(
        frequencies_psd,
        psd,
        theta_band
    )

    alpha_power = calculate_band_power(
        frequencies_psd,
        psd,
        alpha_band
    )

    beta_power = calculate_band_power(
        frequencies_psd,
        psd,
        beta_band
    )

    gamma_power = calculate_band_power(
        frequencies_psd,
        psd,
        gamma_band
    )

    # -------------------------------------------------------------------------
    # Relative EEG Band Power
    # -------------------------------------------------------------------------

    total_power = (
        delta_power +
        theta_power +
        alpha_power +
        beta_power +
        gamma_power
    )

    # Prevent division by zero in the unlikely case of zero total power.

    if total_power == 0:
        total_power = np.finfo(float).eps

    relative_delta = delta_power / total_power
    relative_theta = theta_power / total_power
    relative_alpha = alpha_power / total_power
    relative_beta = beta_power / total_power
    relative_gamma = gamma_power / total_power

    # -------------------------------------------------------------------------
    # Feature Vector
    # -------------------------------------------------------------------------

    feature_vector = np.array([
        delta_power,
        theta_power,
        alpha_power,
        beta_power,
        gamma_power,
        relative_delta,
        relative_theta,
        relative_alpha,
        relative_beta,
        relative_gamma
    ])

    return feature_vector


# =============================================================================
# Function: Evaluate Machine-Learning Model
# =============================================================================

def evaluate_model(
    model,
    X_train,
    y_train,
    X_test,
    y_test
):
    """
    Train a classifier, generate test predictions,
    and calculate classification metrics.

    Returns
    -------
    dict
        Predictions and classification metrics.
    """

    model.fit(
        X_train,
        y_train
    )

    predictions = model.predict(
        X_test
    )

    return {
        "predictions": predictions,

        "accuracy": accuracy_score(
            y_test,
            predictions
        ),

        "confusion_matrix": confusion_matrix(
            y_test,
            predictions
        ),

        "precision": precision_score(
            y_test,
            predictions,
            zero_division=0
        ),

        "recall": recall_score(
            y_test,
            predictions,
            zero_division=0
        ),

        "f1_score": f1_score(
            y_test,
            predictions,
            zero_division=0
        )
    }


# =============================================================================
# Main Program
# =============================================================================

if __name__ == "__main__":

    # -------------------------------------------------------------------------
    # Step 1: Generate EEG Feature Dataset
    # -------------------------------------------------------------------------

    number_of_recordings = 100

    dataset = []

    for _ in range(number_of_recordings):

        feature_vector = process_eeg_recording(
            show_plot=False
        )

        dataset.append(
            feature_vector
        )

    dataset = np.array(
        dataset
    )

    print(
        "Dataset Shape:",
        dataset.shape
    )

    # -------------------------------------------------------------------------
    # Step 2: Inspect Dataset
    # -------------------------------------------------------------------------

    print("\nFirst Five EEG Feature Vectors")
    print("-" * 40)

    print(
        dataset[:5]
    )

    # Verify that each relative-power feature set sums to approximately 1.

    relative_power_sums = np.sum(
        dataset[:, 5:],
        axis=1
    )

    print("\nMaximum Relative-Power Sum Error")
    print("-" * 40)

    print(
        np.max(
            np.abs(
                relative_power_sums - 1.0
            )
        )
    )

    # -------------------------------------------------------------------------
    # Step 3: Export EEG Feature Dataset
    # -------------------------------------------------------------------------

    feature_names = [
        "Delta_Power",
        "Theta_Power",
        "Alpha_Power",
        "Beta_Power",
        "Gamma_Power",
        "Relative_Delta",
        "Relative_Theta",
        "Relative_Alpha",
        "Relative_Beta",
        "Relative_Gamma"
    ]

    feature_dataset = pd.DataFrame(
        dataset,
        columns=feature_names
    )

    feature_dataset.to_csv(
        "eeg_feature_dataset.csv",
        index=False
    )

    print(
        "\nEEG feature dataset successfully saved as:"
    )

    print(
        "eeg_feature_dataset.csv"
    )

    # -------------------------------------------------------------------------
    # Step 4: Prepare Machine-Learning Dataset
    # -------------------------------------------------------------------------

    X = dataset

    # Synthetic labels are used only to demonstrate the supervised-learning
    # workflow; they do not represent clinical neurological diagnoses.

    records_per_class = number_of_recordings // 2

    y = np.array(
        [0] * records_per_class +
        [1] * records_per_class
    )

    if len(y) != number_of_recordings:
        raise ValueError(
            "Number of labels must match the number "
            "of generated EEG recordings."
        )

    print("\nFeature Matrix Shape")
    print("-" * 40)

    print(
        X.shape
    )

    print("\nLabel Vector Shape")
    print("-" * 40)

    print(
        y.shape
    )

    # -------------------------------------------------------------------------
    # Step 5: Train/Test Split
    # -------------------------------------------------------------------------

    X_train, X_test, y_train, y_test = train_test_split(
        X,
        y,
        test_size=0.20,
        random_state=RANDOM_SEED,
        stratify=y
    )

    print("\nTraining Feature Matrix Shape")
    print("-" * 40)

    print(
        X_train.shape
    )

    print("\nTesting Feature Matrix Shape")
    print("-" * 40)

    print(
        X_test.shape
    )

    # -------------------------------------------------------------------------
    # Step 6: Standardize EEG Features
    # -------------------------------------------------------------------------

    scaler = StandardScaler()

    # Fit only on training data to prevent test-data leakage.

    X_train = scaler.fit_transform(
        X_train
    )

    X_test = scaler.transform(
        X_test
    )

    print("\nFeature Scaling Completed Successfully.")
    print("-" * 40)

    print(
        "Scaled Training Shape:",
        X_train.shape
    )

    print(
        "Scaled Testing Shape:",
        X_test.shape
    )

    # -------------------------------------------------------------------------
    # Step 7: Define Classification Models
    # -------------------------------------------------------------------------

    models = {

        "Logistic Regression":
            LogisticRegression(
                random_state=RANDOM_SEED
            ),

        "Decision Tree":
            DecisionTreeClassifier(
                random_state=RANDOM_SEED
            ),

        "Random Forest":
            RandomForestClassifier(
                n_estimators=100,
                random_state=RANDOM_SEED
            ),

        "Support Vector Machine":
            SVC(
                kernel="linear",
                random_state=RANDOM_SEED
            ),

        "K-Nearest Neighbors":
            KNeighborsClassifier(
                n_neighbors=5
            ),

        "Gaussian Naïve Bayes":
            GaussianNB()
    }

    # -------------------------------------------------------------------------
    # Step 8: Train and Evaluate Models
    # -------------------------------------------------------------------------

    results = {}

    for model_name, model in models.items():

        results[model_name] = evaluate_model(
            model,
            X_train,
            y_train,
            X_test,
            y_test
        )

    # -------------------------------------------------------------------------
    # Step 9: Display Individual Model Results
    # -------------------------------------------------------------------------

    for model_name, model_results in results.items():

        print(
            f"\n{model_name}"
        )

        print("-" * 40)

        print(
            f"Accuracy : "
            f"{model_results['accuracy']:.2%}"
        )

        print(
            f"Precision: "
            f"{model_results['precision']:.2%}"
        )

        print(
            f"Recall   : "
            f"{model_results['recall']:.2%}"
        )

        print(
            f"F1 Score : "
            f"{model_results['f1_score']:.2%}"
        )

        print(
            "Confusion Matrix:"
        )

        print(
            model_results["confusion_matrix"]
        )

    # -------------------------------------------------------------------------
    # Step 10: Model Performance Comparison
    # -------------------------------------------------------------------------

    model_comparison = pd.DataFrame(
        [
            {
                "Model": model_name,
                "Accuracy": results[model_name]["accuracy"],
                "Precision": results[model_name]["precision"],
                "Recall": results[model_name]["recall"],
                "F1 Score": results[model_name]["f1_score"]
            }

            for model_name in models
        ]
    )

    print("\nModel Performance Comparison")
    print("-" * 80)

    print(
        model_comparison.to_string(
            index=False,
            formatters={
                "Accuracy": "{:.2%}".format,
                "Precision": "{:.2%}".format,
                "Recall": "{:.2%}".format,
                "F1 Score": "{:.2%}".format
            }
        )
    )

    # -------------------------------------------------------------------------
    # Step 11: Export Model Comparison
    # -------------------------------------------------------------------------

    model_comparison.to_csv(
        "model_comparison.csv",
        index=False
    )

    print(
        "\nModel performance comparison successfully saved as:"
    )

    print(
        "model_comparison.csv"
    )
