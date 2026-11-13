"""Educational information-flow toolkit (directed connectivity, information dynamics).

Submodules (imported explicitly; this package import stays lightweight so the metric
registry can load ``flow.granger`` without pulling in TVB):

* ``granger`` – pairwise / conditional / time-reversed / spectral Granger causality (M27)
* ``transfer_entropy`` – Gaussian and KSG transfer entropy, surrogate tests (M28)
* ``effective`` – DCM-style linear state-space effective connectivity + model comparison
* ``activity_flow`` – activity flow mapping with leakage-safe TRAIN/TEST split
* ``pid`` – partial information decomposition (Gaussian MMI, discrete Williams-Beer)
* ``concepts`` – Korean concept explanations linked to every pipeline result
* ``pipeline`` – simulate JR motif graph → observe 32-ch EEG → analyse (``run_flow_pipeline``)
* ``evaluation`` – truth-aware, source-space-only scoring of the frozen results
"""

__all__ = [
    "activity_flow",
    "concepts",
    "effective",
    "evaluation",
    "granger",
    "pid",
    "pipeline",
    "transfer_entropy",
]
