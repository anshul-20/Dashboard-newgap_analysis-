# News Gap Analyzer Dashboard

A deeply interactive, lightweight UI dashboard constructed for visualizing AI-driven editorial gaps across different newsrooms and story clusters.

## 🛠️ Technology Stack
This application was intentionally built **without** modern JavaScript build frameworks (like React, Vue, or Node.js toolchains). This guarantees extreme portability, instantaneous boot times, and seamless deployment on raw backend GPU/API instances.

- **Structure**: Native HTML5
- **Styling**: Pure CSS (`styles.css` is flat, lightweight, completely void of background gradients, and strictly bound to pure `#000000` text readability).
- **Interactivity**: Vanilla ES6 Modules (`.js`).
- **Server**: Portable Python `http.server` execution via `serve.sh`.

## 📂 Architecture Overview

The interface relies on an intelligent three-tier navigation step-through model:

1. **`index.html` (Categories list - app.js)**: The landing page. Extracts and dynamically aggregates exactly how many news scopes ('categories' like *Bihar*, *Sports*) currently exist inside the API JSON payload.
2. **`topics.html` (Topics per Category - topics.js)**: After choosing a category, the URL routes to `topics.html?category=XYZ`. The UI dynamically scopes all clusters assigned to that category and surfaces them alongside real-time 'covered' and 'missed' pill counts.
3. **`topic.html` (Newsroom Binders - topic.js)**: Clicking a specific topic cluster loads its direct newsroom coverage comparisons. Hovering updates a side-by-side drawer to show raw extracted English payloads vs identified missing facts. Clicking a newsroom tightly "pins" it into the viewport for detailed stability.

**Support Files**:
- `shared.js`: Central engine. Contains parsing engines, defensive formatting logic, and most importantly, the `fetchDashboardData()` network request logic. It handles all robust error boundaries and dynamic property extractions.
- `config.js`: The central configuration binding mapping the backend instance to the frontend UI execution.

---

## 🔌 API & Endpoint Requirements

The dashboard requires exactly one JSON payload to power the entire architecture.

### Configuring the Endpoint
To inject your own API, simply rewrite the configuration in `config.js`:
```javascript
export const APP_CONFIG = {
  // Paste your live GET API endpoint here.
  apiUrl: "http://127.0.0.1:8000/some/path", 
  
  // Local fallback payload
  fallbackDataUrl: "./response.txt",
};
```
*Note: If your API hangs, the `shared.js` fetch logic enforces a strict 10,000ms `AbortSignal` timeout, smartly pushing the network back down to your `fallbackDataUrl` to prevent infinitely spinning UI loaders.*

### Expected Incoming JSON Data Schema
Whether your API serves an object array, or an object containing a `topics` root key, it expects the following generic inner mapping to correctly build out the UI:

```json
[
  {
    "topic_name": "Unique Topic Identity",
    "total_rss_stories": 3,
    "final_missing_facts": [
      "Crucial piece of fact universally missed across newsrooms."
    ],
    "rss_stories_with_matches": [
      {
        "status": "missed",
        "missing_facts": [
          "This fact was missed by this specific newsroom."
        ],
        "rss_story": {
          "category": "news",
          "newsroom": "News18hindi",
          "language": "hi",
          "title": "Hindi News Title",
          "combined_text_english": "English language translation of full document body."
        }
      }
    ]
  }
]
```

---

## 🚀 GPU Server Deployment Guide
The deployment strategy specifically accommodates Linux machines running external heavy workloads (e.g., GPU servers) while tunneling the application dashboard mapping back down to local viewing.

1. **Transfer Files**: Copy this entire folder (`news_gap_ui`) to your Linux server intact. 
2. **Make the Server Script Executable**: Ensure your runner has execution permissions.
   ```bash
   chmod +x serve.sh
   ```
3. **Boot the Dashboard via `screen`**: We use a `screen` session to permanently daemonize the process so it survives SSH dropouts.
   ```bash
   screen -S dashboard
   ./serve.sh
   ```
4. **Detach Safely**: Press `CTRL+A`, then hit `D` to safely detach your screen, letting the dashboard hum forever.
5. **Port Forward Access**: Open your local browser. Use whatever protocol matches your SSH tunneling mappings directed at Port **8765** (e.g. `http://localhost:8765`). 

Because `serve.sh` executes as `python3 -m http.server 8765 --bind 0.0.0.0`, the local host firewalls on your GPU won't block the routing bindings over your tunnel!
