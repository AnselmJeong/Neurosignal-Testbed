# QEEG simulation lesson redesign

## Scope
Replace the default imported-data/ICA QEEG screen with a reproducible simulation lesson. Keep the existing real-data API and derivative UI accessible as an advanced path. No clinical reference database or diagnostic inference.

## Learning sequence
1. Generate 19/32-channel EEG from six radial dipoles, 1/f background and sensor noise (fixed seed, 128 Hz, 32 s).
2. Explain source signals → MNE four-layer spherical forward model → standard 10–20 template electrodes → average or linked-mastoid reference. Separate head-model physics from 2-D scalp interpolation.
3. Start with a frequency atlas resembling familiar QEEG reports: 1 Hz bins, absolute/relative power, per-map spatial scales and an optional shared comparison scale, visible electrodes and units; band atlas and selected-channel PSD.
4. Teach actual definitions and channel values: band power, theta/beta, alpha peak, median frequency, SEF95, normalized spectral entropy, frontal alpha asymmetry, magnitude-squared coherence and time-domain Hilbert PLV.
5. Independently simulate a seeded reference cohort through the identical geometry/reference/PSD pipeline. Compare log absolute power, logit relative power and log theta/beta with sample-SD z scores and empirical percentiles. Show distribution and numeric worked example. Cohort stays fixed when subject amplitudes/seed change; no age/clinical representativeness claimed.
6. Export the complete recipe, geometry, spectra, metrics, cohort values and provenance as JSON.

## Validation
Scientific oracle checks for determinism, power partition, reference invariance properties, controlled amplitude effects, bounded connectivity and independently reconstructed normative statistics. API invalid-input and response checks; frontend navigation/stale-result checks; TypeScript/build and browser inspection of atlas, geometry and norms.

## Completed validation · 2026-09-05
- Python suite: 76 passed (one existing FastAPI/Starlette test-client deprecation warning).
- Web suite: 33 passed; TypeScript and Vite production build passed.
- Scientific checks: reproducibility; power partition and Parseval sinusoid oracle; amplitude-squared scaling; independent cohort preservation under subject changes; reconstruction of z scores from individual cohort values; real reference/forward geometry changes; SciPy coherence agreement; symmetry/range of connectivity; 32-channel linked-mastoid API and invalid-request rejection.
- Browser: inspected live atlas, geometry, norms, metric table, PLV selector and EEG trace viewer. Changed 19→32 electrodes and average→linked mastoids, verified stale-result banner and successful regeneration. Fixed shared CSS overrides causing excess canvas whitespace and trace-viewer/inspector overlap. Browser error log empty.
- Existing real-data derivative implementation retained in ImportedQeegWorkbench; existing API unchanged. No commits or deployment performed.

## Color-scale refinement
The first shared-scale atlas compressed low-power bins into blue because the narrow 10 Hz alpha peak set the upper bound. Default to per-map min/max ranges with a numerical legend on every tile; retain shared scaling for between-frequency magnitude comparisons. Explain that per-map scaling amplifies small differences and equal colors across tiles do not imply equal power. Normative z maps retain their fixed ±3 scale. Browser toggle verification confirmed all numerical mean values remain unchanged; production build passed.

## EEG viewport sizing · 2026-09-05
Removed QEEG's fixed 580 px height. The EEG tab now reserves space for its heading/tabs/provenance and flexes the viewer to the remainder of the dynamic viewport, with independent scrolling for controls. Connectivity embedded viewers use viewport-relative height instead of 360 px; shared ICA/source/real-data canvas tracks can shrink into the available window. Live QEEG browser measurements at window heights 720/900/1200 px were 422.86/602.86/902.86 px, with the viewer bottom consistently 55 px above the window bottom for padding and provenance. A minimum readable size permits scrolling on very short windows.

## Remote access · 2026-09-05
Added a separate password-protected production frontend/API on loopback port 8765 and an outbound Cloudflare HTTPS quick tunnel. Local development services unchanged. Auth covers all assets and API routes; cross-origin writes rejected; credentials owner-only and Git-ignored. Two authentication/security tests passed. Verified the actual public URL: unauthenticated API 401; authenticated HTML, JS asset, health and 19-channel/20-peer QEEG simulation all 200. Public URL and process state remain in the ignored .remote-access directory.

## Router forwarding diagnosis · 2026-09-05
Confirmed Vite still listened on 127.0.0.1:5174, so router-forwarded connections were refused. DDNS resolved to the current WAN IP and macOS application firewall was disabled. Changed Vite to 0.0.0.0 with the exact DDNS hostname allowed; added pre-proxy password authentication for non-loopback HTTP requests using existing owner-only credentials. Added Node typings for the server-only auth code. Verified LAN and DDNS-path authenticated frontend/health responses 200, unauthenticated source/API requests 401, local loopback access 200, and a DDNS-path QEEG run 200 with 19 channels. This checks the DDNS/NAT path from the host network, not an independent cellular connection. TypeScript/build and all 33 web tests passed. Direct 5174 remains HTTP; the existing tunnel provides HTTPS separately.
