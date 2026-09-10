// =============================================================================
// sidebar.js
// Owns two things: the "Home" view (type an instruction, hit run) and the
// "Settings" view (a grid of AI model providers + an editor panel for
// whichever one is selected — mirrors a typical multi-provider BYOK screen).
// =============================================================================

// A default provider is "built in" (can't be deleted) but still fully
// editable — same as any custom one you add later. Every provider carries a
// "presetKey" so the model-name field can offer the right autocomplete list.
// Groq, Gemini, and local Ollama all speak the OpenAI chat-completions
// format, so they use type "openai" with their own host — no extra code
// paths needed, just a different base URL.
const DEFAULT_PROVIDERS = [
  { id: "openai", name: "OpenAI", type: "openai", presetKey: "openai", host: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini", enabled: false, builtin: true },
  { id: "anthropic", name: "Anthropic", type: "anthropic", presetKey: "anthropic", host: "https://api.anthropic.com/v1", apiKey: "", model: "claude-3-5-sonnet-20241022", enabled: false, builtin: true },
  { id: "groq", name: "Groq", type: "openai", presetKey: "groq", host: "https://api.groq.com/openai/v1", apiKey: "", model: "llama-3.3-70b-versatile", enabled: false, builtin: true },
  { id: "gemini", name: "Gemini", type: "openai", presetKey: "gemini", host: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: "", model: "gemini-2.5-flash", enabled: false, builtin: true },
  { id: "ollama", name: "Ollama (localhost)", type: "openai", presetKey: "ollama", host: "http://localhost:11434/v1", apiKey: "", model: "llama3.1", enabled: false, builtin: true },
];

// Quick-pick templates shown when you click "+ Add Model" — for adding a
// *second* account on one of these, or a fully custom OpenAI/Anthropic-
// compatible endpoint (an internal gateway, LM Studio, vLLM, etc).
const PROVIDER_PRESETS = [
  { key: "groq", name: "Groq", type: "openai", host: "https://api.groq.com/openai/v1" },
  { key: "gemini", name: "Gemini", type: "openai", host: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { key: "ollama", name: "Ollama (localhost)", type: "openai", host: "http://localhost:11434/v1" },
  { key: "openai", name: "OpenAI", type: "openai", host: "https://api.openai.com/v1" },
  { key: "anthropic", name: "Anthropic", type: "anthropic", host: "https://api.anthropic.com/v1" },
  { key: "custom", name: "Custom", type: "openai", host: "" },
];

// Active, non-deprecated chat models only — audio/image/video/embedding/
// guard models are left out because this extension only does text-in,
// JSON-action-out, so they wouldn't work here anyway.
const MODEL_SUGGESTIONS = {
  gemini: [
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-1.5-pro",
  ],
  groq: [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "mixtral-8x7b-32768",
    "gemma2-9b-it",
    "openai/gpt-oss-120b",
  ],
  openai: [
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4-turbo",
    "o1-mini",
    "gpt-3.5-turbo",
  ],
  anthropic: [
    "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-20241022",
    "claude-3-opus-20240229",
    "claude-3-haiku-20240307",
  ],
};

// Deterministic color per provider so the avatar grid looks varied, not
// monochrome — hashes the id into a fixed accent palette.
const PALETTE = ["#22c55e", "#3b82f6", "#a855f7", "#f97316", "#ec4899", "#14b8a6", "#7c5cff", "#eab308"];
function colorFor(id) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) % PALETTE.length;
  return PALETTE[hash];
}

function getProviderAvatarHtml(presetKeyOrId, name, extraClass = "") {
  const key = (presetKeyOrId || "").toLowerCase();
  const known = ["openai", "anthropic", "groq", "gemini", "ollama"];
  const matched = known.find((k) => key.includes(k));
  if (matched) {
    return `<div class="avatar avatar-${matched} ${extraClass}"><img src="svgs/${matched}.svg" class="avatar-img" alt="" /></div>`;
  }
  return `<div class="avatar avatar-custom ${extraClass}">${(name || "A").charAt(0).toUpperCase()}</div>`;
}

// In-memory copy of storage. Every mutation writes straight back through
// saveState() so the two always stay in sync.
let state = { providers: [], defaultProviderId: "" };
let selectedProviderId = null;
let searchTerm = "";

// -----------------------------------------------------------------------------
// Storage
// -----------------------------------------------------------------------------
function loadState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["providers", "defaultProviderId"], (data) => {
      state.providers = data.providers && data.providers.length ? data.providers : DEFAULT_PROVIDERS;
      state.defaultProviderId = data.defaultProviderId || "";
      loadChatHistory();
      resolve();
    });
  });
}

function saveState() {
  chrome.storage.local.set({ providers: state.providers, defaultProviderId: state.defaultProviderId });
}

let currentActiveTabId = null;

function updateActiveTabHeader(tab) {
  const titleEl = document.getElementById("header-tab-title");
  const favEl = document.getElementById("header-tab-fav");
  const chipEl = document.getElementById("header-tab-chip");

  if (!tab) {
    if (titleEl) titleEl.textContent = "No Tab";
    return;
  }

  let domain = "";
  try {
    const u = new URL(tab.url);
    domain = u.hostname.replace(/^www\./, "");
  } catch {
    domain = tab.title || "Tab";
  }

  const displayName = domain || tab.title || "Tab";
  if (titleEl) titleEl.textContent = displayName;
  if (chipEl) chipEl.title = `Active Tab: ${tab.title || displayName}\n${tab.url || ""}`;
  if (favEl) {
    if (tab.favIconUrl && !tab.favIconUrl.startsWith("chrome://")) {
      favEl.src = tab.favIconUrl;
    } else {
      favEl.src = "svgs/page.svg";
    }
  }
}

function getActiveTabInfo() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        currentActiveTabId = tabs[0].id;
        updateActiveTabHeader(tabs[0]);
        resolve(tabs[0]);
      } else {
        updateActiveTabHeader(null);
        resolve(null);
      }
    });
  });
}

function getActiveTabId() {
  return new Promise(async (resolve) => {
    const tab = await getActiveTabInfo();
    resolve(tab ? tab.id : null);
  });
}

async function saveChatHistory() {
  if (!chatMessages) return;
  const tabId = currentActiveTabId || (await getActiveTabId());
  if (!tabId) return;

  const key = `tab_chat_${tabId}`;
  chrome.storage.local.set({
    [key]: {
      savedChatHtml: chatMessages.innerHTML,
      chatHistory: chatHistory
    }
  });
}

async function loadChatHistory() {
  const tab = await getActiveTabInfo();
  if (!tab || !tab.id) return;

  const tabId = tab.id;
  const key = `tab_chat_${tabId}`;
  chrome.storage.local.get([key], (data) => {
    const tabData = data[key];
    if (tabData) {
      chatHistory = tabData.chatHistory || [];
      if (tabData.savedChatHtml && tabData.savedChatHtml.trim() !== "") {
        if (chatMessages) chatMessages.innerHTML = tabData.savedChatHtml;
        if (homeEmptyState) homeEmptyState.classList.add("hidden");
        if (chatMessagesWrap) chatMessagesWrap.classList.remove("hidden");
        if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
        return;
      }
    }

    // Reset view for clean tab with no previous history
    chatHistory = [];
    currentActiveAgentBubble = null;
    if (chatMessages) chatMessages.innerHTML = "";
    if (chatMessagesWrap) chatMessagesWrap.classList.add("hidden");
    if (homeEmptyState) homeEmptyState.classList.remove("hidden");
  });
}

// Keep history and active tab chip synced when user switches tabs in browser
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  currentActiveTabId = activeInfo.tabId;
  loadChatHistory();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.active) {
    currentActiveTabId = tabId;
    updateActiveTabHeader(tab);
    if (changeInfo.status === "complete") {
      loadChatHistory();
    }
  }
});

// -----------------------------------------------------------------------------
// View switching
// -----------------------------------------------------------------------------
const viewHome = document.getElementById("view-home");
const viewSettings = document.getElementById("view-settings");
const btnOpenSettings = document.getElementById("btn-open-settings");
const btnBackHome = document.getElementById("btn-back-home");

function showSettings() {
  viewHome.classList.add("hidden");
  viewSettings.classList.remove("hidden");
  btnOpenSettings.classList.add("hidden");
  btnBackHome.classList.remove("hidden");
  renderSettings();
}

function showHome() {
  viewSettings.classList.add("hidden");
  viewHome.classList.remove("hidden");
  btnBackHome.classList.add("hidden");
  btnOpenSettings.classList.remove("hidden");
  renderActiveModelPill();
}

btnOpenSettings.addEventListener("click", showSettings);
btnBackHome.addEventListener("click", showHome);

// -----------------------------------------------------------------------------
// Home view: which model will actually run right now
// -----------------------------------------------------------------------------
function getEffectiveProvider() {
  const enabled = state.providers.filter((p) => p.enabled);
  if (enabled.length === 0) return null;
  return enabled.find((p) => p.id === state.defaultProviderId) || enabled[0];
}

function renderActiveModelPill() {
  const label = document.getElementById("active-model-label");
  const provider = getEffectiveProvider();
  label.textContent = provider ? `${provider.name} · ${provider.model || "no model set"}` : "No model enabled — open Settings";
}

// -----------------------------------------------------------------------------
// SVG Path Morphing Engine (GSAP / Flubber style)
// -----------------------------------------------------------------------------
const MORPH_SHAPES = {
  // Diamond shape
  diamond: [
    [50, 10],
    [65, 25, 75, 35, 90, 50],
    [75, 65, 65, 75, 50, 90],
    [35, 75, 25, 65, 10, 50],
    [25, 35, 35, 25, 50, 10]
  ],
  // Lightning bolt shape
  lightning: [
    [55, 6],
    [40, 26, 30, 36, 22, 48],
    [35, 48, 42, 48, 50, 48],
    [45, 70, 42, 80, 38, 94],
    [58, 68, 68, 56, 78, 44],
    [65, 44, 58, 44, 52, 44],
    [53, 26, 54, 16, 55, 6]
  ],
  // Chat Bubble shape
  chat: [
    [24, 16],
    [45, 16, 60, 16, 76, 16],
    [84, 16, 84, 30, 84, 46],
    [84, 62, 74, 62, 60, 62],
    [48, 62, 38, 76, 20, 84],
    [24, 76, 24, 68, 24, 62],
    [16, 62, 16, 40, 16, 30],
    [16, 16, 20, 16, 24, 16]
  ],
  // 4-Point Sparkle / AI Star shape
  star: [
    [50, 8],
    [52, 30, 65, 42, 92, 50],
    [65, 58, 52, 70, 50, 92],
    [48, 70, 35, 58, 8, 50],
    [35, 42, 48, 30, 50, 8]
  ],
  // Smooth glowing Circle / Orb
  circle: [
    [50, 12],
    [71, 12, 88, 29, 88, 50],
    [88, 71, 71, 88, 50, 88],
    [29, 88, 12, 71, 12, 50],
    [12, 29, 29, 12, 50, 12]
  ]
};

// Resamples any curve definition to 8 standardized bezier segments
function normalizeCurves(rawPts, targetCount = 8) {
  const start = rawPts[0];
  const segments = rawPts.slice(1);
  const normalized = [start];

  for (let i = 0; i < targetCount; i++) {
    const srcIndex = Math.min(Math.floor((i / targetCount) * segments.length), segments.length - 1);
    const seg = segments[srcIndex];
    normalized.push([...seg]);
  }
  return normalized;
}

const NORMALIZED_SHAPES = {
  diamond: normalizeCurves(MORPH_SHAPES.diamond),
  lightning: normalizeCurves(MORPH_SHAPES.lightning),
  chat: normalizeCurves(MORPH_SHAPES.chat),
  star: normalizeCurves(MORPH_SHAPES.star),
  circle: normalizeCurves(MORPH_SHAPES.circle)
};

let currentMorphShapeName = "chat";
let currentMorphGeometry = NORMALIZED_SHAPES.chat;
let morphAnimId = null;

function curvesToSvgPath(curves) {
  let d = `M ${curves[0][0].toFixed(2)} ${curves[0][1].toFixed(2)}`;
  for (let i = 1; i < curves.length; i++) {
    const c = curves[i];
    d += ` C ${c[0].toFixed(2)} ${c[1].toFixed(2)}, ${c[2].toFixed(2)} ${c[3].toFixed(2)}, ${c[4].toFixed(2)} ${c[5].toFixed(2)}`;
  }
  return d + " Z";
}

function interpolateCurves(fromCurves, toCurves, t) {
  const result = [[
    fromCurves[0][0] + (toCurves[0][0] - fromCurves[0][0]) * t,
    fromCurves[0][1] + (toCurves[0][1] - fromCurves[0][1]) * t
  ]];

  for (let i = 1; i < fromCurves.length; i++) {
    const f = fromCurves[i];
    const target = toCurves[i];
    result.push([
      f[0] + (target[0] - f[0]) * t,
      f[1] + (target[1] - f[1]) * t,
      f[2] + (target[2] - f[2]) * t,
      f[3] + (target[3] - f[3]) * t,
      f[4] + (target[4] - f[4]) * t,
      f[5] + (target[5] - f[5]) * t
    ]);
  }
  return result;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function morphTo(targetShapeName, duration = 650) {
  if (!NORMALIZED_SHAPES[targetShapeName]) return;
  if (morphAnimId) cancelAnimationFrame(morphAnimId);

  const fromGeo = currentMorphGeometry;
  const toGeo = NORMALIZED_SHAPES[targetShapeName];
  currentMorphShapeName = targetShapeName;

  const startTime = performance.now();

  function step(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = easeInOutCubic(progress);

    currentMorphGeometry = interpolateCurves(fromGeo, toGeo, eased);
    const pathD = curvesToSvgPath(currentMorphGeometry);

    document.querySelectorAll(".morph-hero-path").forEach((pathEl) => {
      pathEl.setAttribute("d", pathD);
    });

    if (progress < 1) {
      morphAnimId = requestAnimationFrame(step);
    }
  }

  morphAnimId = requestAnimationFrame(step);
}

// Initialize initial morph shape
document.addEventListener("DOMContentLoaded", () => {
  morphTo("chat", 10);
});
setTimeout(() => {
  morphTo("chat", 10);
}, 60);

// -----------------------------------------------------------------------------
// Home view: Mode Toggling & Execution (Chat vs Agentic)
// -----------------------------------------------------------------------------
let currentMode = "chat"; // "chat" | "agentic"
let chatHistory = [];

const modeBtnChat = document.getElementById("mode-btn-chat");
const modeBtnAgentic = document.getElementById("mode-btn-agentic");
const homeEmptyState = document.getElementById("home-empty-state");
const emptyTitle = document.getElementById("empty-title");
const emptySubtitle = document.getElementById("empty-subtitle");
const quickChipsChat = document.getElementById("quick-chips-chat");
const quickChipsAgentic = document.getElementById("quick-chips-agentic");
const chatMessagesWrap = document.getElementById("chat-messages-wrap");
const chatMessages = document.getElementById("chat-messages");

const instructionInput = document.getElementById("instruction");
const runBtn = document.getElementById("run-btn");
const stopBtn = document.getElementById("stop-btn");
const statusBox = document.getElementById("status-box");

function setRunningState(isRunning) {
  if (isRunning) {
    runBtn.classList.add("hidden");
    if (stopBtn) stopBtn.classList.remove("hidden");
  } else {
    if (stopBtn) stopBtn.classList.add("hidden");
    runBtn.classList.remove("hidden");
    runBtn.disabled = false;
  }
}

if (stopBtn) {
  stopBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "STOP_TASK" });
    setRunningState(false);
    setStatus("Task stopped by user.", "error");
  });
}

function switchMode(mode) {
  currentMode = mode;
  if (mode === "chat") {
    modeBtnChat.classList.add("active");
    modeBtnAgentic.classList.remove("active");
    viewHome.classList.remove("mode-agentic-active");

    document.querySelectorAll(".morph-hero-path").forEach((p) => {
      p.setAttribute("fill", "url(#morph-gradient-chat)");
    });
    
    if (emptyTitle) emptyTitle.textContent = "Chat & Analyze Page";
    if (emptySubtitle) emptySubtitle.textContent = "Ask questions about this page, request summaries, or general AI assistance.";
    if (quickChipsChat) quickChipsChat.classList.remove("hidden");
    if (quickChipsAgentic) quickChipsAgentic.classList.add("hidden");
    
    if (chatHistory.length > 0) {
      if (homeEmptyState) homeEmptyState.classList.add("hidden");
      if (chatMessagesWrap) chatMessagesWrap.classList.remove("hidden");
    } else {
      if (homeEmptyState) homeEmptyState.classList.remove("hidden");
      if (chatMessagesWrap) chatMessagesWrap.classList.add("hidden");
    }

    instructionInput.placeholder = "Ask AI Pilot a question or request a page summary…";
    morphTo("chat", 600);
  } else {
    modeBtnAgentic.classList.add("active");
    modeBtnChat.classList.remove("active");
    viewHome.classList.add("mode-agentic-active");

    document.querySelectorAll(".morph-hero-path").forEach((p) => {
      p.setAttribute("fill", "url(#morph-gradient-agentic)");
    });

    if (emptyTitle) emptyTitle.textContent = "Autonomous Agent Control";
    if (emptySubtitle) emptySubtitle.textContent = "e.g. 'Click the search button' or 'Type my email into the login field'";
    if (quickChipsAgentic) quickChipsAgentic.classList.remove("hidden");
    if (quickChipsChat) quickChipsChat.classList.add("hidden");

    if (chatHistory.length > 0) {
      if (homeEmptyState) homeEmptyState.classList.add("hidden");
      if (chatMessagesWrap) chatMessagesWrap.classList.remove("hidden");
    } else {
      if (homeEmptyState) homeEmptyState.classList.remove("hidden");
      if (chatMessagesWrap) chatMessagesWrap.classList.add("hidden");
    }

    instructionInput.placeholder = "e.g. Click search button or fill login input…";
    morphTo("lightning", 600);
  }
}

modeBtnChat.addEventListener("click", () => switchMode("chat"));
modeBtnAgentic.addEventListener("click", () => switchMode("agentic"));

function setStatus(text, kind) {
  statusBox.textContent = text;
  statusBox.classList.toggle("show", !!text);
  statusBox.classList.remove("ok", "error");
  if (kind) statusBox.classList.add(kind);
}

function formatMarkdown(text) {
  if (!text) return "";
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Code blocks ```code```
  html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  // Inline code `code`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold **text**
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic *text*
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Line breaks
  html = html.split('\n').join('<br>');
  return html;
}

// =============================================================================
// REAL CONNECTOR ENGINE
// Detects intent from user prompt, navigates active tab to the right site,
// then hands off to the agentic loop to operate on that page.
// =============================================================================

const CONNECTOR_RULES = [
  // ── YouTube ──────────────────────────────────────────────────────────────
  {
    id: "youtube",
    label: "YouTube",
    icon: "svgs/search.svg",
    color: "#ff0000",
    patterns: [
      /(?:play|search|find|open|look up|watch).*(?:on|at|using)?\s*youtube/i,
      /youtube.*(?:video|channel|playlist|search|watch|play)/i,
      /(?:video|videos).*(?:youtube|yt)/i,
    ],
    getUrl: (prompt) => {
      // Extract search query
      const m = prompt.match(/(?:play|search|find|look up|watch)\s+['"]?([^'"]+?)['"]?\s+(?:on|at|in)?\s*youtube/i)
                 || prompt.match(/youtube.*(?:search|find|play)\s+['"]?([^'"]+)['"]?/i);
      const q = m ? m[1].trim() : "";
      return q ? `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}` : "https://www.youtube.com";
    }
  },
  // ── Spotify ───────────────────────────────────────────────────────────────
  {
    id: "spotify",
    label: "Spotify",
    icon: "svgs/agent.svg",
    color: "#1db954",
    patterns: [
      /(?:play|search|find|open|listen).*(?:on|at|in|using)?\s*spotify/i,
      /spotify.*(?:song|track|playlist|artist|album|music|play|search)/i,
    ],
    getUrl: (prompt) => {
      const m = prompt.match(/(?:play|search|find|listen to)\s+['"]?([^'"]+?)['"]?\s+(?:on|at|in)?\s*spotify/i)
                 || prompt.match(/spotify.*(?:search|play|find)\s+['"]?([^'"]+)['"]?/i);
      const q = m ? m[1].trim() : "";
      return q ? `https://open.spotify.com/search/${encodeURIComponent(q)}` : "https://open.spotify.com";
    }
  },
  // ── Gmail ─────────────────────────────────────────────────────────────────
  {
    id: "gmail",
    label: "Gmail",
    icon: "svgs/mail.svg",
    color: "#ea4335",
    patterns: [
      /(?:send|compose|write|open|check|read|reply|draft).*(?:email|mail|gmail|message)/i,
      /gmail/i,
      /(?:email|mail).*(?:to|compose|send|check|inbox)/i,
    ],
    getUrl: (prompt) => {
      const isCompose = /(?:send|compose|write|draft)/i.test(prompt);
      return isCompose ? "https://mail.google.com/mail/u/0/#compose" : "https://mail.google.com/mail/u/0/#inbox";
    }
  },
  // ── Google Chat ───────────────────────────────────────────────────────────
  {
    id: "google-chat",
    label: "Google Chat",
    icon: "svgs/chatbot.svg",
    color: "#00ac47",
    patterns: [
      /(?:open|check|send|go to|read).*(?:google chat|gchat)/i,
      /google chat.*(?:message|check|open|send)/i,
      /(?:chat|message).*(?:google|team|workspace)/i,
    ],
    getUrl: () => "https://chat.google.com"
  },
  // ── Google Maps ───────────────────────────────────────────────────────────
  {
    id: "google-maps",
    label: "Google Maps",
    icon: "svgs/compass.svg",
    color: "#4285f4",
    patterns: [
      /(?:find|search|navigate|directions|open|show).*(?:on|in)?\s*(?:google\s*)?maps?/i,
      /maps?.*(?:find|directions|navigate|search)/i,
    ],
    getUrl: (prompt) => {
      const m = prompt.match(/(?:find|search|navigate to|directions to)\s+['"]?([^'"]+?)['"]?\s+(?:on|in)?\s*(?:google\s*)?maps?/i)
                 || prompt.match(/maps?.*(?:find|navigate to|search for)\s+['"]?([^'"]+)['"]?/i);
      const q = m ? m[1].trim() : "";
      return q ? `https://www.google.com/maps/search/${encodeURIComponent(q)}` : "https://www.google.com/maps";
    }
  },
  // ── Google Search ─────────────────────────────────────────────────────────
  {
    id: "google-search",
    label: "Google Search",
    icon: "svgs/search.svg",
    color: "#4285f4",
    patterns: [
      /(?:search|google|look up|find)\s+(?:for)?\s*.+(?:on|in)?\s*google/i,
      /google\s+(?:search|for)/i,
    ],
    getUrl: (prompt) => {
      const m = prompt.match(/(?:search|google|look up)(?:\s+for)?\s+['"]?([^'"]+?)['"]?(?:\s+on\s+google)?$/i);
      const q = m ? m[1].trim() : prompt;
      return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
    }
  },
  // ── LinkedIn ──────────────────────────────────────────────────────────────
  {
    id: "linkedin",
    label: "LinkedIn",
    icon: "svgs/agent.svg",
    color: "#0a66c2",
    patterns: [
      /(?:open|check|search|find|go to).*linkedin/i,
      /linkedin.*(?:profile|job|post|message|search|connect)/i,
    ],
    getUrl: (prompt) => {
      const isSearch = /search|find/i.test(prompt);
      const m = prompt.match(/(?:search|find)\s+['"]?([^'"]+?)['"]?\s+(?:on|in)?\s*linkedin/i);
      if (m && m[1]) return `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(m[1].trim())}`;
      return "https://www.linkedin.com/feed";
    }
  },
  // ── Twitter / X ───────────────────────────────────────────────────────────
  {
    id: "twitter",
    label: "X / Twitter",
    icon: "svgs/agent.svg",
    color: "#1da1f2",
    patterns: [
      /(?:open|check|search|tweet|post|go to).*(?:twitter|x\.com)/i,
      /(?:twitter|x\.com).*(?:search|tweet|post|open|check)/i,
    ],
    getUrl: (prompt) => {
      const m = prompt.match(/(?:search|find)\s+['"]?([^'"]+?)['"]?\s+(?:on|in)?\s*(?:twitter|x)/i);
      if (m && m[1]) return `https://twitter.com/search?q=${encodeURIComponent(m[1].trim())}`;
      return "https://twitter.com/home";
    }
  },
  // ── GitHub ────────────────────────────────────────────────────────────────
  {
    id: "github",
    label: "GitHub",
    icon: "svgs/execute.svg",
    color: "#f0f6fc",
    patterns: [
      /(?:open|search|find|go to).*github/i,
      /github.*(?:repo|repository|issue|pull request|code|search)/i,
    ],
    getUrl: (prompt) => {
      const m = prompt.match(/(?:search|find)\s+['"]?([^'"]+?)['"]?\s+(?:on|in)?\s*github/i);
      if (m && m[1]) return `https://github.com/search?q=${encodeURIComponent(m[1].trim())}`;
      return "https://github.com";
    }
  },
  // ── Amazon ────────────────────────────────────────────────────────────────
  {
    id: "amazon",
    label: "Amazon",
    icon: "svgs/sparkle.svg",
    color: "#ff9900",
    patterns: [
      /(?:search|find|buy|order|shop|look up).*(?:on|at|from)?\s*amazon/i,
      /amazon.*(?:search|buy|product|order|shop)/i,
    ],
    getUrl: (prompt) => {
      const m = prompt.match(/(?:search|find|buy|order|shop for)\s+['"]?([^'"]+?)['"]?\s+(?:on|at|from)?\s*amazon/i);
      if (m && m[1]) return `https://www.amazon.com/s?k=${encodeURIComponent(m[1].trim())}`;
      return "https://www.amazon.com";
    }
  },
];

/**
 * Detect which connector matches the user's instruction.
 * Returns { rule, targetUrl } or null if no match.
 */
function detectConnector(instruction) {
  for (const rule of CONNECTOR_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(instruction)) {
        return { rule, targetUrl: rule.getUrl(instruction) };
      }
    }
  }
  return null;
}

/**
 * Navigate the active tab to a URL and wait for it to load.
 * Returns a Promise that resolves with the tab after load.
 */
function navigateActiveTab(url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) {
        reject(new Error("No active tab found."));
        return;
      }
      const tabId = tabs[0].id;
      chrome.tabs.update(tabId, { url }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        // Poll until tab finishes loading
        function checkReady(info) {
          if (info.tabId === tabId && info.status === "complete") {
            chrome.tabs.onUpdated.removeListener(checkReady);
            chrome.tabs.get(tabId, (tab) => resolve(tab));
          }
        }
        chrome.tabs.onUpdated.addListener(checkReady);
        // Safety timeout — resolve after 8s regardless
        setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(checkReady);
          chrome.tabs.get(tabId, (tab) => resolve(tab));
        }, 8000);
      });
    });
  });
}

// Connector toast shown at top of chat before execution
function appendConnectorToast(rule, targetUrl) {
  const toast = document.createElement("div");
  toast.className = "chat-msg assistant";
  toast.style.cssText = `
    background: rgba(${rule.color === '#ff0000' ? '255,0,0' : rule.color === '#1db954' ? '29,185,84' : rule.color === '#ea4335' ? '234,67,53' : rule.color === '#00ac47' ? '0,172,71' : '56,189,248'},0.1);
    border: 1px solid rgba(${rule.color === '#ff0000' ? '255,0,0' : rule.color === '#1db954' ? '29,185,84' : rule.color === '#ea4335' ? '234,67,53' : rule.color === '#00ac47' ? '0,172,71' : '56,189,248'},0.3);
    padding: 9px 13px;
    display: flex; align-items: center; gap: 10px;
    font-size: 12px;
  `;
  toast.innerHTML = `
    <img src="${rule.icon}" style="width:16px;height:16px;filter:brightness(0) invert(1);flex-shrink:0;" alt="" />
    <div>
      <div style="font-weight:700;color:#fff;font-size:12px;">Opening ${escapeHTML(rule.label)}…</div>
      <div style="color:rgba(255,255,255,0.5);font-size:10.5px;word-break:break-all;margin-top:1px;">${escapeHTML(targetUrl.length > 70 ? targetUrl.slice(0, 70) + '…' : targetUrl)}</div>
    </div>
  `;
  chatMessages.appendChild(toast);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return toast;
}

function runInstruction() {
  const instruction = instructionInput.value.trim();
  if (!instruction) {
    if (currentMode === "agentic") setStatus("Enter an instruction first.", "error");
    return;
  }
  if (!getEffectiveProvider()) {
    if (currentMode === "agentic") {
      setStatus("No model is enabled. Open Settings and turn one on.", "error");
    } else {
      appendChatMessage("assistant", "No AI model is enabled. Please open Settings and turn one on.");
    }
    return;
  }

  // Detect inline schedule request (e.g. "Schedule: play lofi in 5 mins" or "Schedule every 15 mins: search Linkin Park")
  const lowerInst = instruction.toLowerCase();
  if (lowerInst.startsWith("schedule:") || lowerInst.includes("schedule task") || lowerInst.includes("schedule in ")) {
    let delay = 5;
    let repeat = 0;
    const matchDelay = lowerInst.match(/in\s+(\d+)\s*m/);
    if (matchDelay) delay = parseInt(matchDelay[1], 10);

    const matchEvery = lowerInst.match(/every\s+(\d+)\s*m/);
    if (matchEvery) repeat = parseInt(matchEvery[1], 10);

    let cleanPrompt = instruction
      .replace(/^schedule:\s*/i, "")
      .replace(/schedule\s+(task\s+)?(in|every)\s+\d+\s*mins?\:?/i, "")
      .trim();

    if (!cleanPrompt) cleanPrompt = instruction;

    if (homeEmptyState) homeEmptyState.classList.add("hidden");
    if (chatMessagesWrap) chatMessagesWrap.classList.remove("hidden");

    appendChatMessage("user", instruction);
    instructionInput.value = "";

    chrome.runtime.sendMessage({ type: "ADD_SCHEDULED_TASK", instruction: cleanPrompt, delayMinutes: delay, intervalMinutes: repeat }, (res) => {
      if (res && res.ok) {
        appendChatMessage("assistant", `⏰ Scheduled task created! Will execute "${escapeHTML(cleanPrompt)}" in ${delay} minute${delay > 1 ? 's' : ''}${repeat ? ` (repeating every ${repeat} mins)` : ''}.`);
      } else {
        appendChatMessage("assistant", `⚠️ Failed to schedule task: ${escapeHTML(res?.error || "Unknown error")}`);
      }
    });
    return;
  }

  if (currentMode === "chat") {
    runChatTask(instruction);
  } else {
    runAgenticTask(instruction);
  }
}

function runChatTask(instruction) {
  instructionInput.value = "";
  
  // Hide empty state and show chat container
  if (homeEmptyState) homeEmptyState.classList.add("hidden");
  if (chatMessagesWrap) chatMessagesWrap.classList.remove("hidden");

  // Add user bubble
  appendChatMessage("user", instruction);

  // Add loading assistant bubble
  const loadingEl = appendChatMessage("assistant", "Thinking…");
  setRunningState(true);

  chrome.runtime.sendMessage(
    { type: "RUN_CHAT", instruction, history: chatHistory.slice(-6) },
    (response) => {
      setRunningState(false);
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        loadingEl.innerHTML = `<span style="color:var(--danger)">Error: ${lastError.message || "Connection error."}</span>`;
        saveChatHistory();
        return;
      }
      if (!response || !response.ok) {
        loadingEl.innerHTML = `<span style="color:var(--danger)">Error: ${response?.error || "Something went wrong."}</span>`;
        saveChatHistory();
        return;
      }

      const replyText = response.result.text;
      loadingEl.innerHTML = formatMarkdown(replyText);
      
      // Save conversation history
      chatHistory.push({ role: "user", content: instruction });
      chatHistory.push({ role: "assistant", content: replyText });
      chatMessages.scrollTop = chatMessages.scrollHeight;
      saveChatHistory();
    }
  );
}

let currentActiveAgentBubble = null;

async function runAgenticTask(instruction) {
  instructionInput.value = "";
  instructionInput.style.height = "auto";

  // Hide empty state and show chat container
  if (homeEmptyState) homeEmptyState.classList.add("hidden");
  if (chatMessagesWrap) chatMessagesWrap.classList.remove("hidden");

  // Add user message bubble
  appendChatMessage("user", instruction);
  chatHistory.push({ role: "user", content: instruction });

  const provider = getEffectiveProvider();
  setRunningState(true);

  // ─── REAL CONNECTOR ENGINE ────────────────────────────────────────────────
  // Detect if the user prompt matches a known app/service and navigate there
  const connectorMatch = detectConnector(instruction);
  if (connectorMatch) {
    const { rule, targetUrl } = connectorMatch;
    appendConnectorToast(rule, targetUrl);
    try {
      await navigateActiveTab(targetUrl);
      // Small extra wait for JS-heavy SPAs to hydrate after load event
      await new Promise(r => setTimeout(r, 1500));
    } catch (navErr) {
      appendChatMessage("assistant", `⚠️ Could not navigate to ${rule.label}: ${navErr.message}`);
      setRunningState(false);
      return;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Create Agent Chat Bubble
  const agentMsgEl = document.createElement("div");
  agentMsgEl.className = "chat-msg assistant";
  agentMsgEl.innerHTML = `
    <div class="agent-card">
      <div class="agent-card-header">
        <div class="agent-card-title">
          <span class="agent-pill"><img src="svgs/agent.svg" class="agent-pill-img" alt="" /> Autonomous Agent</span>
          <span class="agent-model-tag">${escapeHTML(provider ? provider.name : "AI Pilot")}${connectorMatch ? ` · ${escapeHTML(connectorMatch.rule.label)}` : ""}</span>
        </div>
        <div class="agent-card-status running">
          <span class="agent-spinner"></span>
          <span class="agent-status-label">Executing...</span>
        </div>
      </div>
      <div class="agent-live-status">
        <span class="agent-spinner"></span>
        <span class="agent-live-text">Initializing task execution...</span>
      </div>
      <div class="agent-output-summary"></div>
      <details class="agent-steps-details">
        <summary class="agent-steps-summary">
          <span>Execution Details (Logs)</span>
          <span class="summary-count-badge">0 steps</span>
        </summary>
        <div class="agent-steps-list"></div>
      </details>
    </div>
  `;
  chatMessages.appendChild(agentMsgEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  currentActiveAgentBubble = agentMsgEl;

  chrome.runtime.sendMessage({ type: "RUN_TASK", instruction }, (response) => {
    setRunningState(false);
    const lastError = chrome.runtime.lastError;
    const statusWrap = agentMsgEl.querySelector(".agent-card-status");
    const liveStatusEl = agentMsgEl.querySelector(".agent-live-status");
    const cardEl = agentMsgEl.querySelector(".agent-card");
    const detailsEl = agentMsgEl.querySelector(".agent-steps-details");
    const summaryBox = agentMsgEl.querySelector(".agent-output-summary");

    if (detailsEl) detailsEl.removeAttribute("open");

    if (lastError) {
      if (statusWrap) {
        statusWrap.className = "agent-card-status error";
        statusWrap.innerHTML = `<span>Failed</span>`;
      }
      if (liveStatusEl) {
        liveStatusEl.className = "agent-live-status error";
        liveStatusEl.innerHTML = `<span>⚠️ Task failed</span>`;
      }
      const errBox = document.createElement("div");
      errBox.className = "agent-error-msg";
      errBox.textContent = lastError.message || "Connection error. Please refresh tab.";
      if (summaryBox) summaryBox.appendChild(errBox);
      else cardEl.appendChild(errBox);
      currentActiveAgentBubble = null;
      saveChatHistory();
      return;
    }

    if (!response || !response.ok) {
      if (statusWrap) {
        statusWrap.className = "agent-card-status error";
        statusWrap.innerHTML = `<span>Failed</span>`;
      }
      if (liveStatusEl) {
        liveStatusEl.className = "agent-live-status error";
        liveStatusEl.innerHTML = `<span>⚠️ Task failed</span>`;
      }
      const errBox = document.createElement("div");
      errBox.className = "agent-error-msg";
      errBox.textContent = response?.error || "Task execution encountered an error.";
      if (summaryBox) summaryBox.appendChild(errBox);
      else cardEl.appendChild(errBox);
      currentActiveAgentBubble = null;
      saveChatHistory();
      return;
    }

    const { action, providerName, reason, message } = response.result;
    if (statusWrap) {
      statusWrap.className = action === "none" ? "agent-card-status error" : "agent-card-status done";
      statusWrap.innerHTML = `<span>${action === "none" ? "Stopped" : "Completed"}</span>`;
    }
    if (liveStatusEl) {
      if (action === "none") {
        liveStatusEl.className = "agent-live-status error";
        liveStatusEl.innerHTML = `<span>⚠️ Task stopped</span>`;
      } else {
        liveStatusEl.className = "agent-live-status done";
        liveStatusEl.innerHTML = `<span>✅ Task finished successfully</span>`;
      }
    }

    const finalBox = document.createElement("div");
    if (action === "none") {
      finalBox.className = "agent-error-msg";
      finalBox.textContent = `${providerName}: ${reason || "Unable to proceed on current page."}`;
    } else {
      finalBox.className = "agent-final-msg";
      finalBox.innerHTML = `<img src="svgs/sparkle.svg" class="icon-inline" alt="" /> ${escapeHTML(message || "Goal accomplished successfully!")}`;
    }
    if (summaryBox) summaryBox.appendChild(finalBox);
    else cardEl.appendChild(finalBox);

    chatHistory.push({ role: "assistant", content: message || reason || "Task completed" });
    chatMessages.scrollTop = chatMessages.scrollHeight;
    currentActiveAgentBubble = null;
    saveChatHistory();
  });
}

function appendChatMessage(role, text) {
  const msgEl = document.createElement("div");
  msgEl.className = `chat-msg ${role}`;
  msgEl.innerHTML = role === "user" ? escapeHTML(text) : formatMarkdown(text);
  chatMessages.appendChild(msgEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return msgEl;
}

// Quick Chip Click Handlers
document.addEventListener("click", (e) => {
  const chip = e.target.closest(".quick-chip-btn");
  if (chip && chip.dataset.prompt) {
    instructionInput.value = chip.dataset.prompt;
    runInstruction();
  }
});

const activeModelPill = document.getElementById("active-model-pill");
if (activeModelPill) {
  activeModelPill.addEventListener("click", showSettings);
}

instructionInput.addEventListener("input", () => {
  instructionInput.style.height = "auto";
  instructionInput.style.height = Math.min(instructionInput.scrollHeight, 110) + "px";
});

runBtn.addEventListener("click", runInstruction);
instructionInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    runInstruction();
  }
});

// -----------------------------------------------------------------------------
// Live Activity Logs Console
// -----------------------------------------------------------------------------
const logsContainer = document.getElementById("logs-container");
const logsToggleBtn = document.getElementById("logs-toggle-btn");
const logsBody = document.getElementById("logs-body");
const logsList = document.getElementById("logs-list");
const logsCountBadge = document.getElementById("logs-count-badge");
const btnClearLogs = document.getElementById("btn-clear-logs");

let taskLogs = [];

function humanReadableStatus(log) {
  if (!log || !log.text) return "⚙️ Executing action...";
  const text = log.text.trim();
  const lower = text.toLowerCase();

  if (lower.includes("navigat")) return "🌐 Navigating to target page...";
  if (lower.includes("click")) return "🖱️ Clicking on-screen element...";
  if (lower.includes("type") || lower.includes("fill")) return "⌨️ Typing text into input field...";
  if (lower.includes("observing") || lower.includes("read")) return "👁️ Observing page content & layout...";
  if (lower.includes("search")) return "🔍 Searching website...";
  if (lower.includes("scroll")) return "📜 Scrolling page...";
  if (lower.includes("spotify")) return "🎵 Playing track on Spotify...";
  if (lower.includes("youtube")) return "🎬 Interacting with YouTube...";
  if (lower.includes("gmail") || lower.includes("email")) return "📧 Processing Gmail message...";
  if (lower.includes("map") || lower.includes("direction")) return "🗺️ Looking up location on Google Maps...";
  if (lower.includes("success") || lower.includes("completed")) return "✅ Action completed!";
  if (lower.includes("error") || lower.includes("fail")) return "⚠️ Encountered an issue...";

  let cleanText = text.replace(/^\[(Step\s*\d+|ACTION|INFO|WARN|ERROR)\]\s*/i, "").trim();
  if (cleanText.length > 55) {
    cleanText = cleanText.substring(0, 52) + "...";
  }
  return cleanText ? `▶ ${cleanText}` : "⚙️ Executing action...";
}

function toggleLogs(forceOpen = null) {
  if (!logsBody || !logsContainer) return;
  const shouldOpen = forceOpen !== null ? forceOpen : logsBody.classList.contains("hidden");
  if (shouldOpen) {
    logsBody.classList.remove("hidden");
    logsContainer.classList.add("open");
  } else {
    logsBody.classList.add("hidden");
    logsContainer.classList.remove("open");
  }
}

if (logsToggleBtn) {
  logsToggleBtn.addEventListener("click", (e) => {
    if (e.target.closest("#btn-clear-logs")) return;
    toggleLogs();
  });
}

if (btnClearLogs) {
  btnClearLogs.addEventListener("click", (e) => {
    e.stopPropagation();
    taskLogs = [];
    if (logsCountBadge) logsCountBadge.textContent = "0";
    if (logsList) logsList.innerHTML = `<div class="log-entry log-muted">No activity logs yet. Run an agentic task to see real-time steps.</div>`;
  });
}

function appendLog(log) {
  if (!logsList) return;
  if (taskLogs.length === 0) {
    logsList.innerHTML = "";
  }
  taskLogs.push(log);
  if (logsCountBadge) logsCountBadge.textContent = taskLogs.length;

  const entryEl = document.createElement("div");
  entryEl.className = "log-entry";
  entryEl.innerHTML = `
    <span class="log-time">${log.time || ""}</span>
    <span class="log-tag ${log.level || 'info'}">[${(log.level || 'INFO').toUpperCase()}]</span>
    <span class="log-text">${escapeHTML(log.text || '')}</span>
  `;
  logsList.appendChild(entryEl);
  logsBody.scrollTop = logsBody.scrollHeight;

  // Stream live step into the active Agent chat bubble
  if (currentActiveAgentBubble) {
    const liveStatusEl = currentActiveAgentBubble.querySelector(".agent-live-status");
    const liveTextEl = liveStatusEl ? liveStatusEl.querySelector(".agent-live-text") : null;
    if (liveTextEl && log.text) {
      liveTextEl.textContent = humanReadableStatus(log);
    }

    const stepsList = currentActiveAgentBubble.querySelector(".agent-steps-list");
    const countBadge = currentActiveAgentBubble.querySelector(".summary-count-badge");
    if (stepsList && (log.level === "action" || (log.level === "info" && log.text.startsWith("[Step")))) {
      const stepItem = document.createElement("div");
      stepItem.className = "agent-step-item";
      let iconSvg = "svgs/agent.svg";
      const lower = log.text.toLowerCase();
      if (lower.includes("type")) iconSvg = "svgs/execute.svg";
      else if (lower.includes("click")) iconSvg = "svgs/todo.svg";
      else if (lower.includes("navigat")) iconSvg = "svgs/compass.svg";
      else if (lower.includes("observing") || lower.includes("step")) iconSvg = "svgs/magnifying-glass.svg";

      stepItem.innerHTML = `<img src="${iconSvg}" class="agent-step-icon-svg" alt="" /><span class="agent-step-text">${escapeHTML(log.text)}</span>`;
      stepsList.appendChild(stepItem);
      if (countBadge) {
        countBadge.textContent = `${stepsList.children.length} step${stepsList.children.length === 1 ? '' : 's'}`;
      }
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  }

  // Auto-expand logs drawer if error
  if (log.level === "error") {
    toggleLogs(true);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "TASK_LOG" && message.log) {
    appendLog(message.log);
  }
});

// -----------------------------------------------------------------------------
// History Sessions Overlay & Drawer Manager
// -----------------------------------------------------------------------------
const historyModalOverlay = document.getElementById("history-modal-overlay");
const btnHistoryDrawer = document.getElementById("btn-history-drawer");
const btnCloseHistory = document.getElementById("btn-close-history");
const historySessionsList = document.getElementById("history-sessions-list");
const historySearchInput = document.getElementById("history-search-input");
const btnExportHistory = document.getElementById("btn-export-history");
const btnClearAllHistory = document.getElementById("btn-clear-all-history");
const webhookConnectorUrlInput = document.getElementById("webhook-connector-url");

let historySearchTerm = "";

function showHistoryModal() {
  if (!historyModalOverlay || !historySessionsList) return;
  historyModalOverlay.classList.remove("hidden");
  renderHistorySessions();
}

function hideHistoryModal() {
  if (historyModalOverlay) historyModalOverlay.classList.add("hidden");
}

if (btnHistoryDrawer) btnHistoryDrawer.addEventListener("click", showHistoryModal);
if (btnCloseHistory) btnCloseHistory.addEventListener("click", hideHistoryModal);
if (historyModalOverlay) {
  historyModalOverlay.addEventListener("click", (e) => {
    if (e.target === historyModalOverlay) hideHistoryModal();
  });
}

if (historySearchInput) {
  historySearchInput.addEventListener("input", (e) => {
    historySearchTerm = e.target.value.toLowerCase().trim();
    renderHistorySessions();
  });
}

if (btnExportHistory) {
  btnExportHistory.addEventListener("click", () => {
    chrome.storage.local.get(null, (data) => {
      const tabKeys = Object.keys(data).filter((k) => k.startsWith("tab_chat_"));
      const exportData = {};
      tabKeys.forEach((key) => {
        exportData[key] = data[key];
      });
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ai-pilot-chat-history-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  });
}

if (btnClearAllHistory) {
  btnClearAllHistory.addEventListener("click", () => {
    if (confirm("Are you sure you want to delete ALL saved chat sessions across all tabs?")) {
      chrome.storage.local.get(null, (data) => {
        const tabKeys = Object.keys(data).filter((k) => k.startsWith("tab_chat_"));
        chrome.storage.local.remove(tabKeys, () => {
          renderHistorySessions();
          loadChatHistory();
        });
      });
    }
  });
}

if (webhookConnectorUrlInput) {
  chrome.storage.local.get(["webhookConnectorUrl"], (data) => {
    if (data.webhookConnectorUrl) {
      webhookConnectorUrlInput.value = data.webhookConnectorUrl;
    }
  });
  webhookConnectorUrlInput.addEventListener("change", (e) => {
    chrome.storage.local.set({ webhookConnectorUrl: e.target.value.trim() });
  });
}

function renderHistorySessions() {
  if (!historySessionsList) return;

  chrome.storage.local.get(null, (data) => {
    historySessionsList.innerHTML = "";
    const tabKeys = Object.keys(data).filter((k) => k.startsWith("tab_chat_"));

    if (tabKeys.length === 0) {
      historySessionsList.innerHTML = `
        <div style="font-size:12px; color:var(--text-faint); text-align:center; padding:30px 10px;">
          No saved chat sessions yet.<br>Start a chat or agentic task in any tab!
        </div>`;
      return;
    }

    let matchesCount = 0;
    tabKeys.forEach((key) => {
      const session = data[key];
      const tabIdStr = key.replace("tab_chat_", "");

      let previewText = "Saved Chat Session";
      if (session.chatHistory && session.chatHistory.length > 0) {
        const lastMsg = session.chatHistory[session.chatHistory.length - 1];
        previewText = lastMsg.content || previewText;
      }

      const combinedSearchable = `tab ${tabIdStr} ${previewText}`.toLowerCase();
      if (historySearchTerm && !combinedSearchable.includes(historySearchTerm)) {
        return;
      }
      matchesCount++;

      const itemEl = document.createElement("div");
      itemEl.className = "history-item";
      itemEl.innerHTML = `
        <div class="history-item-title">Tab Session #${tabIdStr}</div>
        <div style="font-size:11.5px; color:var(--text-dim); margin-bottom:5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
          ${escapeHTML(previewText.slice(0, 80))}
        </div>
        <div class="history-item-meta">
          <span>${session.chatHistory ? session.chatHistory.length : 0} messages saved</span>
          <span style="color:#ef4444; font-weight:600;" data-del-key="${key}">Delete</span>
        </div>
      `;

      itemEl.addEventListener("click", (e) => {
        if (e.target.dataset.delKey) {
          e.stopPropagation();
          chrome.storage.local.remove(key, () => renderHistorySessions());
          return;
        }
        hideHistoryModal();
      });

      historySessionsList.appendChild(itemEl);
    });

    if (matchesCount === 0 && historySearchTerm) {
      historySessionsList.innerHTML = `
        <div style="font-size:12px; color:var(--text-faint); text-align:center; padding:20px 10px;">
          No history sessions matching "${escapeHTML(historySearchTerm)}"
        </div>`;
    }
  });
}

// Clear Chat / New Task button in header
const btnNewChat = document.getElementById("btn-new-chat");
if (btnNewChat) {
  btnNewChat.addEventListener("click", async () => {
    chatHistory = [];
    currentActiveAgentBubble = null;
    if (chatMessages) chatMessages.innerHTML = "";
    if (chatMessagesWrap) chatMessagesWrap.classList.add("hidden");
    if (homeEmptyState) homeEmptyState.classList.remove("hidden");
    instructionInput.value = "";
    instructionInput.style.height = "auto";

    const tabId = currentActiveTabId || (await getActiveTabId());
    if (tabId) {
      chrome.storage.local.remove(`tab_chat_${tabId}`);
    }
  });
}

// -----------------------------------------------------------------------------
// Settings view: default-model dropdown
// -----------------------------------------------------------------------------
function renderDefaultModelSelect() {
  const select = document.getElementById("default-model-select");
  const enabled = state.providers.filter((p) => p.enabled);

  select.innerHTML = "";
  const autoOpt = document.createElement("option");
  autoOpt.value = "";
  autoOpt.textContent = "Use first available";
  select.appendChild(autoOpt);

  enabled.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    select.appendChild(opt);
  });

  select.value = state.defaultProviderId || "";
}

document.getElementById("default-model-select").addEventListener("change", (e) => {
  state.defaultProviderId = e.target.value;
  saveState();
});

// -----------------------------------------------------------------------------
// Settings view: provider grid
// -----------------------------------------------------------------------------
function renderProviderGrid() {
  const grid = document.getElementById("provider-grid");
  grid.innerHTML = "";

  const filtered = state.providers.filter((p) =>
    p.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  filtered.forEach((p) => {
    const card = document.createElement("div");
    card.className = "provider-card" + (p.id === selectedProviderId ? " selected" : "");
    card.innerHTML = `
      <div class="head">
        ${getProviderAvatarHtml(p.presetKey || p.id, p.name)}
        <div>
          <div class="name">${escapeHTML(p.name)}</div>
          <div class="type">${p.type === "anthropic" ? "Anthropic format" : "OpenAI format"}</div>
        </div>
      </div>
      <div class="foot">
        <span class="model-name">${escapeHTML(p.model || "No model set")}</span>
        <label class="toggle">
          <input type="checkbox" data-toggle-id="${p.id}" ${p.enabled ? "checked" : ""} />
          <span class="slider"></span>
        </label>
      </div>
    `;
    card.addEventListener("click", (e) => {
      if (e.target.closest(".toggle")) return; // toggle handles itself
      selectedProviderId = p.id;
      renderProviderGrid();
      renderEditor();
    });
    grid.appendChild(card);
  });

  grid.querySelectorAll("[data-toggle-id]").forEach((checkbox) => {
    checkbox.addEventListener("change", (e) => {
      const id = e.target.getAttribute("data-toggle-id");
      const provider = state.providers.find((p) => p.id === id);
      provider.enabled = e.target.checked;
      saveState();
      renderDefaultModelSelect();
      if (id === selectedProviderId) renderEditor();
    });
  });
}

function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

document.getElementById("search-providers").addEventListener("input", (e) => {
  searchTerm = e.target.value;
  renderProviderGrid();
});

// -----------------------------------------------------------------------------
// Settings view: "+ Add Model" — pick a preset (or blank Custom), then it
// drops straight into the editor so you just paste a key and go.
// -----------------------------------------------------------------------------
const addModelBtn = document.getElementById("btn-add-model");
const addModelMenu = document.getElementById("add-model-menu");

function renderAddModelMenu() {
  addModelMenu.innerHTML = PROVIDER_PRESETS.map(
    (preset) => `
      <button class="preset-row" data-preset-key="${preset.key}">
        ${getProviderAvatarHtml(preset.key, preset.name, "avatar-sm")}
        <span>${escapeHTML(preset.name)}</span>
      </button>`
  ).join("");

  addModelMenu.querySelectorAll("[data-preset-key]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const preset = PROVIDER_PRESETS.find((p) => p.key === btn.getAttribute("data-preset-key"));
      addProviderFromPreset(preset);
      addModelMenu.classList.add("hidden");
    });
  });
}

function addProviderFromPreset(preset) {
  const id = preset.key + "-" + Date.now();
  const suggestions = MODEL_SUGGESTIONS[preset.key];
  state.providers.push({
    id,
    name: preset.name,
    type: preset.type,
    presetKey: preset.key,
    host: preset.host,
    apiKey: "",
    model: suggestions ? suggestions[0] : "",
    enabled: false,
    builtin: false,
  });
  saveState();
  selectedProviderId = id;
  renderProviderGrid();
  renderEditor();
}

addModelBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  renderAddModelMenu();
  addModelMenu.classList.toggle("hidden");
});

document.addEventListener("click", (e) => {
  if (!addModelMenu.contains(e.target) && e.target !== addModelBtn) {
    addModelMenu.classList.add("hidden");
  }
});

// -----------------------------------------------------------------------------
// Settings view: editor panel for the selected provider
// -----------------------------------------------------------------------------
function renderEditor() {
  const wrap = document.getElementById("editor-wrap");
  const provider = state.providers.find((p) => p.id === selectedProviderId);

  if (!provider) {
    wrap.innerHTML = `<div class="no-selection">Select a model above to configure it.</div>`;
    return;
  }

  wrap.innerHTML = `
    <div id="editor">
      <div class="editor-head">
        <div class="id-block">
          ${getProviderAvatarHtml(provider.presetKey || provider.id, provider.name)}
          <div>
            <div class="name">${escapeHTML(provider.name)}</div>
            <div class="sub">${provider.type === "anthropic" ? "Anthropic format" : "OpenAI format"}</div>
          </div>
        </div>
        <div class="right">
          <span style="font-size:11px;color:var(--text-dim)">Enable</span>
          <label class="toggle">
            <input type="checkbox" id="edit-enabled" ${provider.enabled ? "checked" : ""} />
            <span class="slider"></span>
          </label>
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label>Display Name</label>
          <input type="text" id="edit-name" value="${escapeHTML(provider.name)}" />
        </div>
        <div class="field">
          <label>Provider Type</label>
          <select id="edit-type">
            <option value="openai" ${provider.type === "openai" ? "selected" : ""}>OpenAI</option>
            <option value="anthropic" ${provider.type === "anthropic" ? "selected" : ""}>Anthropic</option>
          </select>
        </div>
      </div>

      <div class="field">
        <label>AI Host</label>
        <input type="text" id="edit-host" placeholder="https://api.example.com/v1" value="${escapeHTML(provider.host)}" />
      </div>

      <div class="field">
        <label>API Key</label>
        <div class="key-field">
          <input type="password" id="edit-key" placeholder="Optional for local models" value="${escapeHTML(provider.apiKey)}" />
          <button class="eye" id="toggle-key-visibility" type="button" title="Toggle visibility">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
          </button>
        </div>
      </div>

      <div class="field">
        <label>AI Model</label>
        <input type="text" id="edit-model" list="model-suggestions" placeholder="e.g. gpt-4o-mini, llama3.1, claude-sonnet-4-6" value="${escapeHTML(provider.model)}" />
        <datalist id="model-suggestions">
          ${(MODEL_SUGGESTIONS[provider.presetKey] || []).map((m) => `<option value="${escapeHTML(m)}"></option>`).join("")}
        </datalist>
      </div>

      <div class="editor-actions">
        <span class="test-status" id="test-status"></span>
        <div class="right">
          ${provider.builtin ? "" : `<button class="btn danger-outline" id="btn-delete">Delete</button>`}
          <button class="btn" id="btn-test">Test Connection</button>
          <button class="btn primary" id="btn-save">Save Settings</button>
        </div>
      </div>
    </div>
  `;

  wireEditorEvents(provider);
}

function wireEditorEvents(provider) {
  document.getElementById("edit-enabled").addEventListener("change", (e) => {
    provider.enabled = e.target.checked;
    saveState();
    renderProviderGrid();
    renderDefaultModelSelect();
  });

  document.getElementById("toggle-key-visibility").addEventListener("click", () => {
    const keyInput = document.getElementById("edit-key");
    keyInput.type = keyInput.type === "password" ? "text" : "password";
  });

  document.getElementById("btn-save").addEventListener("click", () => {
    provider.name = document.getElementById("edit-name").value.trim() || "Untitled Model";
    provider.type = document.getElementById("edit-type").value;
    provider.host = document.getElementById("edit-host").value.trim();
    provider.apiKey = document.getElementById("edit-key").value.trim();
    provider.model = document.getElementById("edit-model").value.trim();
    saveState();
    renderProviderGrid();
    renderDefaultModelSelect();
    renderEditor();
    flashTestStatus("Saved.", "ok");
  });

  document.getElementById("btn-test").addEventListener("click", () => {
    const testProvider = {
      ...provider,
      host: document.getElementById("edit-host").value.trim(),
      apiKey: document.getElementById("edit-key").value.trim(),
      model: document.getElementById("edit-model").value.trim(),
      type: document.getElementById("edit-type").value,
    };
    flashTestStatus("Testing…", "");
    chrome.runtime.sendMessage({ type: "TEST_PROVIDER", provider: testProvider }, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        flashTestStatus(lastError.message || "Test connection failed.", "error");
        return;
      }
      if (response && response.ok) flashTestStatus("Connection OK.", "ok");
      else flashTestStatus(response?.error || "Connection failed.", "error");
    });
  });

  const deleteBtn = document.getElementById("btn-delete");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", () => {
      state.providers = state.providers.filter((p) => p.id !== provider.id);
      if (state.defaultProviderId === provider.id) state.defaultProviderId = "";
      selectedProviderId = null;
      saveState();
      renderProviderGrid();
      renderDefaultModelSelect();
      renderEditor();
    });
  }
}

function flashTestStatus(text, kind) {
  const el = document.getElementById("test-status");
  if (!el) return;
  el.textContent = text;
  el.classList.remove("ok", "error");
  if (kind) el.classList.add(kind);
}

// -----------------------------------------------------------------------------
// Connectors Grid (Settings panel) — dynamic from CONNECTOR_RULES
// -----------------------------------------------------------------------------
const CONNECTOR_DESCRIPTIONS = {
  "youtube":       { desc: "Finds videos, live streams & playback", sample: "Play lofi music on YouTube" },
  "spotify":       { desc: "Track playback & playlist search",      sample: "Play jazz on Spotify" },
  "gmail":         { desc: "Automates emails, subjects & sending",   sample: "Send email to john@gmail.com" },
  "google-chat":   { desc: "Direct team messaging & chat rooms",     sample: "Open Google Chat and check messages" },
  "google-maps":   { desc: "Navigation, directions & location search",sample: "Find coffee shops on Google Maps" },
  "google-search": { desc: "Web search with smart queries",          sample: "Search for AI news on Google" },
  "linkedin":      { desc: "Profiles, jobs, posts & connections",    sample: "Find software engineers on LinkedIn" },
  "twitter":       { desc: "Tweets, timeline & search",             sample: "Search AI trends on Twitter" },
  "github":        { desc: "Repos, issues & code search",           sample: "Find React repos on GitHub" },
  "amazon":        { desc: "Product search, shopping & orders",      sample: "Search for wireless headphones on Amazon" },
};

function renderConnectorsGrid() {
  const grid = document.getElementById("connectors-grid-settings");
  if (!grid) return;
  grid.innerHTML = "";

  CONNECTOR_RULES.forEach((rule) => {
    const meta = CONNECTOR_DESCRIPTIONS[rule.id] || { desc: "Automated connector", sample: "" };
    const card = document.createElement("div");
    card.className = "connector-card";
    card.innerHTML = `
      <div class="connector-head">
        <img src="${rule.icon}" class="connector-icon" alt="" style="filter:brightness(0) invert(0.75);" />
        <div>
          <div class="connector-name">${escapeHTML(rule.label)}</div>
          <div class="connector-desc">${escapeHTML(meta.desc)}</div>
          ${meta.sample ? `<div style="font-size:9.5px;color:var(--text-faint);margin-top:2px;font-style:italic;">"${escapeHTML(meta.sample)}"</div>` : ""}
        </div>
      </div>
      <button class="connector-launch-btn" data-connector-url="${escapeHTML(rule.getUrl(""))}" title="Open ${escapeHTML(rule.label)} in active tab">Open ↗</button>
    `;
    card.querySelector(".connector-launch-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      const url = e.target.getAttribute("data-connector-url");
      navigateActiveTab(url).catch(() => {});
    });
    grid.appendChild(card);
  });
}

// -----------------------------------------------------------------------------
// Settings view: full render
// -----------------------------------------------------------------------------
function renderSettings() {
  renderDefaultModelSelect();
  renderProviderGrid();
  renderEditor();
  renderConnectorsGrid();
}

// -----------------------------------------------------------------------------
// Voice Input — Web Speech API (SpeechRecognition)
// -----------------------------------------------------------------------------
(function initVoiceInput() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const voiceBtn = document.getElementById("btn-voice-input");
  const interimEl = document.getElementById("voice-interim");

  if (!voiceBtn) return;

  // If browser doesn't support Speech API, hide the button gracefully
  if (!SpeechRecognition) {
    voiceBtn.title = "Voice input not supported in this browser";
    voiceBtn.style.opacity = "0.35";
    voiceBtn.style.cursor = "not-allowed";
    voiceBtn.addEventListener("click", (e) => {
      e.preventDefault();
      setStatus("Voice input requires Chrome / Chromium.", "error");
    });
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.interimResults = true;   // Show live transcription as you speak
  recognition.maxAlternatives = 1;
  recognition.continuous = false;      // Auto-stop after speech ends

  let isListening = false;

  // ── Helpers ────────────────────────────────────────────────────────────────
  function startListening() {
    if (isListening) return;
    isListening = true;
    voiceBtn.classList.add("listening");
    voiceBtn.title = "Listening… (click to cancel)";
    if (interimEl) { interimEl.textContent = "🎙 Listening…"; interimEl.classList.add("visible"); }
    try {
      recognition.start();
    } catch (err) {
      // Already started — ignore
    }
  }

  function stopListening() {
    if (!isListening) return;
    isListening = false;
    voiceBtn.classList.remove("listening");
    voiceBtn.title = "Voice Input (click to speak)";
    if (interimEl) { interimEl.textContent = ""; interimEl.classList.remove("visible"); }
    try { recognition.stop(); } catch (_) {}
  }

  // ── Recognition Events ─────────────────────────────────────────────────────
  recognition.onresult = (event) => {
    let interim = "";
    let finalTranscript = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript += t;
      } else {
        interim += t;
      }
    }

    // Show interim live in the floating hint
    if (interimEl) {
      interimEl.textContent = interim || finalTranscript || "🎙 Listening…";
    }

    // Paste final transcript into the textarea
    if (finalTranscript) {
      instructionInput.value = finalTranscript.trim();
      instructionInput.style.height = "auto";
      instructionInput.style.height = Math.min(instructionInput.scrollHeight, 110) + "px";
    }
  };

  recognition.onend = () => {
    const transcript = instructionInput.value.trim();
    stopListening();
    // Auto-submit if we got something
    if (transcript) {
      // Small delay so user can see what was captured
      setTimeout(() => {
        runInstruction();
      }, 300);
    }
  };

  recognition.onerror = (event) => {
    stopListening();
    const friendly = {
      "not-allowed":      "Microphone access denied. Enable it in Chrome settings.",
      "no-speech":        "No speech detected. Try again.",
      "audio-capture":    "No microphone found.",
      "network":          "Network error during recognition.",
      "aborted":          "", // user cancelled — no message needed
    };
    const msg = friendly[event.error] || `Voice error: ${event.error}`;
    if (msg) setStatus(msg, "error");
  };

  // ── Button wiring ──────────────────────────────────────────────────────────
  voiceBtn.addEventListener("click", () => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  });

// -----------------------------------------------------------------------------
// Scheduled & Recurring Tasks Overlay & Drawer Manager
// -----------------------------------------------------------------------------
const scheduleModalOverlay = document.getElementById("schedule-modal-overlay");
const btnScheduleDrawer = document.getElementById("btn-schedule-drawer");
const btnCloseSchedule = document.getElementById("btn-close-schedule");
const scheduledTasksList = document.getElementById("scheduled-tasks-list");
const schedulePromptInput = document.getElementById("schedule-prompt-input");
const scheduleDelayInput = document.getElementById("schedule-delay-input");
const scheduleRepeatInput = document.getElementById("schedule-repeat-input");
const btnCreateSchedule = document.getElementById("btn-create-schedule");

function showScheduleModal() {
  if (!scheduleModalOverlay) return;
  scheduleModalOverlay.classList.remove("hidden");
  renderScheduledTasks();
}

function hideScheduleModal() {
  if (scheduleModalOverlay) scheduleModalOverlay.classList.add("hidden");
}

if (btnScheduleDrawer) btnScheduleDrawer.addEventListener("click", showScheduleModal);
if (btnCloseSchedule) btnCloseSchedule.addEventListener("click", hideScheduleModal);

if (btnCreateSchedule) {
  btnCreateSchedule.addEventListener("click", () => {
    const prompt = (schedulePromptInput.value || "").trim();
    const delay = parseInt(scheduleDelayInput.value, 10) || 1;
    const repeat = parseInt(scheduleRepeatInput.value, 10) || 0;

    if (!prompt) {
      alert("Please enter a task prompt to schedule.");
      return;
    }

    chrome.runtime.sendMessage(
      { type: "ADD_SCHEDULED_TASK", instruction: prompt, delayMinutes: delay, intervalMinutes: repeat },
      (response) => {
        if (response && response.ok) {
          schedulePromptInput.value = "";
          renderScheduledTasks();
        } else {
          alert(`Failed to create schedule: ${response?.error || "Unknown error"}`);
        }
      }
    );
  });
}

function renderScheduledTasks() {
  if (!scheduledTasksList) return;
  scheduledTasksList.innerHTML = `<div class="history-item-meta" style="padding:10px;">Loading scheduled tasks...</div>`;

  chrome.runtime.sendMessage({ type: "GET_SCHEDULED_TASKS" }, (response) => {
    if (!response || !response.ok || !response.tasks || response.tasks.length === 0) {
      scheduledTasksList.innerHTML = `
        <div style="text-align:center; padding: 24px 10px; color: var(--text-faint); font-size:12px;">
          <p>No active scheduled tasks yet.</p>
          <p style="font-size:11px; margin-top:4px; color:var(--accent);">Try typing "Schedule in 5 mins: Play lofi music on YouTube"</p>
        </div>
      `;
      return;
    }

    scheduledTasksList.innerHTML = "";
    response.tasks.forEach((task) => {
      const taskEl = document.createElement("div");
      taskEl.className = "connector-card";
      taskEl.style.marginBottom = "8px";
      taskEl.innerHTML = `
        <div style="flex:1; overflow:hidden; padding-right:8px;">
          <div style="font-size:12px; font-weight:600; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
            ⏰ ${escapeHTML(task.instruction)}
          </div>
          <div style="font-size:10.5px; color:var(--text-faint); margin-top:2px;">
            In ${task.delayMinutes} min${task.delayMinutes > 1 ? "s" : ""}${task.intervalMinutes > 0 ? ` · Repeats every ${task.intervalMinutes}m` : ""} · Executed ${task.runCount || 0} time${task.runCount === 1 ? "" : "s"}
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
          <button class="history-action-btn ${task.active ? '' : 'danger'}" data-action="toggle" data-id="${task.id}">
            ${task.active ? "Active" : "Paused"}
          </button>
          <button class="history-action-btn danger" data-action="delete" data-id="${task.id}">&times;</button>
        </div>
      `;

      taskEl.querySelector('[data-action="toggle"]').addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "TOGGLE_SCHEDULED_TASK", taskId: task.id, activeState: !task.active }, () => renderScheduledTasks());
      });

      taskEl.querySelector('[data-action="delete"]').addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "DELETE_SCHEDULED_TASK", taskId: task.id }, () => renderScheduledTasks());
      });

      scheduledTasksList.appendChild(taskEl);
    });
  });
}
  // Stop listening if user starts typing manually
  instructionInput.addEventListener("keydown", () => {
    if (isListening) stopListening();
  });
})();

// Optional TTS — speaks AI chat response back to user (only if voice was used)
// Exposed as speakText() so it can be called from runChatTask if desired.
function speakText(text) {
  if (!window.speechSynthesis || !text) return;
  // Cancel any ongoing speech first
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text.slice(0, 400)); // cap to 400 chars
  utterance.lang = "en-US";
  utterance.rate = 1.05;
  utterance.pitch = 1.0;
  utterance.volume = 1.0;
  // Pick a natural-sounding voice if available
  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find(v => v.name.toLowerCase().includes("natural") || v.name.toLowerCase().includes("neural") || v.lang === "en-US");
  if (preferred) utterance.voice = preferred;
  window.speechSynthesis.speak(utterance);
}

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------
loadState().then(() => {
  renderActiveModelPill();
});
