# 🚀 AI Pilot — Autonomous AI Browser Assistant (Chrome Extension)

![Manifest V3](https://img.shields.io/badge/Manifest-V3-brightgreen.svg)
![JavaScript](https://img.shields.io/badge/JavaScript-ES6+-yellow.svg)
![License](https://img.shields.io/badge/License-MIT-blue.svg)

**AI Pilot** is a lightweight, high-performance Chrome Extension (Manifest V3) that provides a powerful autonomous web browser agent and AI sidepanel companion. It allows you to analyze pages, run scheduled automation tasks, control web applications (YouTube, Spotify, Gmail, Google Maps, Twitter, GitHub, etc.), and switch between AI models seamlessly with built-in automatic provider failover.

---

## ✨ Features

- 🤖 **Autonomous Web Automation Agent**:
  - Executes real multi-step tasks across websites (e.g., *"Play Linkin Park on Spotify and then search lofi study music on YouTube"*).
  - Inspects interactive DOM elements dynamically and executes accurate clicks and keypress dispatches.

- 💬 **Sidepanel Chat & Page Q&A**:
  - Context-aware page summarization and Q&A directly in Chrome's side panel.

- ⏰ **Scheduled & Recurring Tasks Engine**:
  - Set one-time delays or recurring intervals via Chrome Alarms API (`chrome.alarms`).
  - Supports inline natural language scheduling (e.g., *"Schedule in 5 mins: Search lofi music on YouTube"*).

- 🔄 **Automatic AI Provider Fallback**:
  - Automatically switches to your next enabled provider if your primary model (e.g., Gemini) hits a 503 capacity limit, rate limit, or network timeout.
  - Supports **OpenAI**, **Anthropic Claude**, **Google Gemini**, **Groq**, **DeepSeek**, **Ollama**, **LM Studio**, and custom OpenAI-compatible gateways.

- 🎙️ **Voice Input**:
  - Built-in Web Speech API integration with live transcript preview and hands-free auto-submission.

- 🔗 **Real App Connectors**:
  - Direct deep-links and navigation rules for 10+ popular web services.

- 🔔 **Push Notifications & Webhooks**:
  - Receive background desktop notifications and trigger custom HTTP Webhooks upon task completion.

---

## 🛠️ Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/ocenasolutions/Ai-pilot.git
   ```
2. Open **Google Chrome** and navigate to `chrome://extensions`.
3. Enable **Developer mode** using the toggle in the top-right corner.
4. Click **Load unpacked** and select the extension directory (`ai-pilot`).
5. Click the **AI Pilot** icon in your toolbar or open the Chrome Side Panel.

---

## ⚙️ Configuration

1. Open the AI Pilot sidepanel and click the **Settings** icon.
2. Toggle **ON** one or more AI providers (e.g., Gemini, OpenAI, Groq, or Ollama).
3. Enter your API Key for cloud providers or standard host URLs for local models (e.g., `http://localhost:11434/v1` for Ollama).
4. Set your **Default Provider**. If it ever becomes unavailable, AI Pilot will automatically fall back to your next enabled provider!

---

## 📂 Project Architecture

```
ai-pilot/
├── manifest.json         # Manifest V3 configuration & permissions
├── background.js         # Service worker, AI provider dispatch, task loop & alarms
├── content.js            # In-page DOM inspector & element action executor
├── sidebar.html          # Main extension UI (Sidepanel & Modals)
├── sidebar.js            # UI logic, chat state, voice recognition & schedule manager
├── rules.json            # Declarative net request rules
├── icons/                # Extension logos & favicons
└── svgs/                 # Vector icons for UI & providers
```

---

## 🔒 Privacy & Security

- **Local First**: All settings, API keys, chat sessions, and scheduled tasks are stored exclusively on your device via `chrome.storage.local`.
- **Zero Tracking**: No user analytics or telemetry collected.

---

## 📄 License

Distributed under the MIT License.
