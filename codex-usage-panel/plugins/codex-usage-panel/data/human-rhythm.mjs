// Population prior from published hourly work-activity profiles, combined with
// the plugin's local quota history at runtime. It contains no weekday/weekend split.
export const RHYTHM_MODEL_VERSION = "full-window-budget-rhythm-v5";

// BLS ATUS Table A-4, combined 2021-2025: percent working at each local hour
// on days respondents worked. Values run from 00:00 through 23:00.
export const HOUR_PROFILES = [
  {
    id: "computer-mathematical",
    source: "https://www.bls.gov/tus/tables/a4-2125.htm",
    values: [3.0, 2.4, 1.0, 0.9, 0.9, 1.2, 5.1, 17.6, 46.7, 78.0, 82.8, 78.6,
      57.3, 72.5, 82.7, 77.9, 67.9, 32.5, 11.3, 7.1, 8.8, 8.5, 5.9, 5.0]
  },
  {
    id: "professional-related",
    source: "https://www.bls.gov/tus/tables/a4-2125.htm",
    values: [2.8, 2.4, 1.8, 1.8, 2.8, 3.9, 8.1, 21.0, 50.9, 70.9, 74.9, 73.9,
      55.9, 67.5, 74.1, 69.2, 55.7, 30.9, 15.4, 10.3, 9.1, 8.2, 6.6, 4.4]
  }
];

// Engineering parameters: one active history window contributes the weight of
// one prior window; each independent rolling 5-hour window gets equal weight.
export const PRIOR_ACTIVITY_WINDOWS = 4;
export const ACTIVITY_BOOTSTRAP_SAMPLES = 256;
export const MIN_ACTIVITY_WINDOW_MOVEMENT = 5;
export const MAX_ACTIVITY_SAMPLE_GAP_MS = 2 * 60 * 60 * 1000;
