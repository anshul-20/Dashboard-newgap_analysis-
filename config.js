export const APP_CONFIG = {
  // Paste your live GET API endpoint here.
  apiUrl: "https://newsgaptesting.amarujaladigital.com/api/topics",
  // apiUrl: "http://148.251.177.113:9845/api/topics",

  // When apiUrl is empty, the app falls back to the local sample payload.
  fallbackDataUrl: "./response.txt",

  // Automatic refresh interval. 30 minutes = 1800000 ms.
  refreshIntervalMs: 30 * 60 * 1000,

  // Set to true to show detailed error messages on the UI.
  // Set to false in production to hide technical details from end users.
  debug: false,
};
