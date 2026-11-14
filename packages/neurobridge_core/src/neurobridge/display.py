"""Sample selection and rounding for the series returned to the browser."""

from __future__ import annotations

import math

import numpy as np
from numpy.typing import NDArray

# The trace viewer builds its own per-pixel min/max envelope, so a view should keep every sample
# whenever it reasonably can. Picking a fixed number of samples regardless of the sampling rate
# hides exactly what the lessons vary: the display rate no longer follows the recipe, sample
# spacing becomes irregular, and content above the reduced Nyquist frequency folds into view.
MAX_VIEW_SAMPLES = 20_000


def view_indices(length: int, maximum: int = MAX_VIEW_SAMPLES) -> NDArray[np.int64]:
    """Return every index, or a uniform integer stride once ``length`` exceeds ``maximum``."""

    stride = max(1, math.ceil(length / maximum))
    return np.arange(0, length, stride, dtype=np.int64)


def round_significant(values: NDArray[np.float64], digits: int = 6) -> NDArray[np.float64]:
    """Round to significant digits, so values far below 1 are not flattened to zero.

    Power spectra span many decades. Rounding them to a fixed number of decimals turns the
    stop band into exact zeros, which a log-scaled chart draws as a cliff to its floor.
    """

    array = np.asarray(values, dtype=float)
    rounded = np.zeros_like(array)
    usable = np.isfinite(array) & (array != 0)
    exponent = np.floor(np.log10(np.abs(array[usable])))
    scale = 10.0 ** (digits - 1 - exponent)
    rounded[usable] = np.round(array[usable] * scale) / scale
    rounded[~np.isfinite(array)] = array[~np.isfinite(array)]
    return rounded
