// =============================================================================
// background.js  (Manifest V3 service worker)
// Orchestrates one task: scrape the active tab -> ask the AI what to do ->
// send that single action back to the content script to execute.
//
// Providers are generic: every provider is either "openai" format (chat
// completions, used by OpenAI itself, Groq, DeepSeek, Ollama, LM Studio,
// most gateways) or "anthropic" format (Messages API). A provider is just
// { id, name, type, host, apiKey, model, enabled }.
// =============================================================================

// Open the side panel when the toolbar icon is clicked.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => console.error(err));

const AGENTIC_SYSTEM_PROMPT = `You are an autonomous web browser agent controlling a web browser for the user. You have FULL AUTHORITY to control and navigate the browser to accomplish any task requested by the user.

Given:
1. User Goal: the overall task to accomplish.
2. Current Webpage Title and URL.
3. Interactive Elements visible on the current webpage.
4. History of actions executed so far in this task.

NAVIGATION & BROWSER CONTROL RULES:
- You can navigate to ANY website or web application required to fulfill the user's goal.
- If the current webpage is NOT the site needed for the task, your VERY FIRST ACTION MUST BE TO NAVIGATE to the appropriate URL:
  * YouTube: "https://www.youtube.com" (for finding, searching, playing videos)
  * Spotify: "https://open.spotify.com" (for playing songs, podcasts, tracks)
  * Google: "https://www.google.com" (for searching general information)
  * Gmail: "https://mail.google.com" (for checking or sending emails)
  * Google Chat: "https://chat.google.com" (for checking messages or team chats)
  * Maps: "https://maps.google.com" (for directions or locations)
  * Amazon: "https://www.amazon.com" (for shopping or finding products)
  * Twitter / X: "https://x.com" (for social posts and updates)
  * Wikipedia: "https://www.wikipedia.org" (for articles and research)
  * GitHub: "https://github.com" (for code, repositories, issues)
  * Any other specific website or web application requested by the user goal.

MULTI-STEP & CHAINED GOAL RULES:
- If the user prompt asks for multi-part or chained commands (e.g. "play Linkin Park on spotify and when completed play lofi on youtube"):
  1. Accomplish the first sub-goal on the appropriate site (e.g. search and click play on Spotify).
  2. Once the first sub-goal is in progress or completed, navigate to the second site (e.g. YouTube) using a "navigate" action.
  3. Search for and execute the second sub-goal on that site.
  4. Only emit {"action": "done"} when ALL sub-goals requested by the user are complete.

Supported Action Objects:
1. Navigate to a web app or URL:
   {"action": "navigate", "url": "https://www.youtube.com", "step": "Navigating to YouTube"}
2. Click an element:
   {"action": "click", "selector": "[data-ai-id='5']", "step": "Clicking Search / Play button"}
3. Type text into an element:
   - For search fields (YouTube, Spotify, Google, Amazon, etc.): Type the target search query, song title, artist, or video name.
   - For email Subject fields: Generate a clear, professional subject title.
   - For Body/Message fields: Generate a complete, well-written, polite message.
   Example:
   {"action": "type", "selector": "[data-ai-id='12']", "text": "Starlight by Muse", "step": "Typing query into search input"}
4. Task is fully completed:
   {"action": "done", "message": "Successfully found and played requested item!", "step": "Task complete"}
5. Cannot perform task on current browser state:
   {"action": "none", "reason": "Short explanation why task cannot be done", "step": "Failed"}

Return ONLY a raw JSON object matching one of the exact shapes above (no markdown, no extra commentary).`;

let isTaskCancelled = false;

// -----------------------------------------------------------------------------
// Scheduled & Recurring Tasks Engine (Chrome Alarms API)
// -----------------------------------------------------------------------------
chrome.alarms.onAlarm.addListener(async (alarm) => {
  try {
    const data = await chrome.storage.local.get(["scheduledTasks"]);
    const tasks = data.scheduledTasks || [];
    const task = tasks.find((t) => t.id === alarm.name || `alarm_${t.id}` === alarm.name);
    if (!task || !task.active) return;

    broadcastLog(`⏰ [SCHEDULED TASK TRIGGERED] Goal: "${task.instruction}"`, "info");
    sendPushNotification("AI Pilot Scheduled Task", `Executing: "${task.instruction}"`);

    // Update execution history in storage
    task.lastRun = new Date().toISOString();
    task.runCount = (task.runCount || 0) + 1;
    await chrome.storage.local.set({ scheduledTasks: tasks });

    // Execute scheduled agentic task
    await runTask(task.instruction);
  } catch (err) {
    console.error("Scheduled task execution error:", err);
    broadcastLog(`Scheduled task execution error: ${err.message}`, "error");
  }
});

async function addScheduledTask(instruction, delayMinutes = 1, intervalMinutes = 0) {
  const data = await chrome.storage.local.get(["scheduledTasks"]);
  const tasks = data.scheduledTasks || [];
  const taskId = "task_" + Date.now();
  const delay = Math.max(1, parseInt(delayMinutes, 10) || 1);
  const interval = parseInt(intervalMinutes, 10) || 0;

  const newTask = {
    id: taskId,
    instruction: instruction.trim(),
    delayMinutes: delay,
    intervalMinutes: interval,
    createdAt: new Date().toISOString(),
    lastRun: null,
    runCount: 0,
    active: true,
  };

  tasks.push(newTask);
  await chrome.storage.local.set({ scheduledTasks: tasks });

  const alarmInfo = { delayInMinutes: delay };
  if (interval > 0) alarmInfo.periodInMinutes = interval;

  chrome.alarms.create(taskId, alarmInfo);
  broadcastLog(`⏰ Scheduled task created: "${instruction}" (in ${delay}m${interval ? `, repeats every ${interval}m` : ""})`, "success");
  sendPushNotification("AI Pilot Schedule Set", `Task set: "${instruction}"`);
  return newTask;
}

async function deleteScheduledTask(taskId) {
  const data = await chrome.storage.local.get(["scheduledTasks"]);
  let tasks = data.scheduledTasks || [];
  tasks = tasks.filter((t) => t.id !== taskId);
  await chrome.storage.local.set({ scheduledTasks: tasks });
  await chrome.alarms.clear(taskId);
  broadcastLog(`⏰ Scheduled task removed (${taskId})`, "info");
  return { ok: true };
}

async function toggleScheduledTask(taskId, activeState) {
  const data = await chrome.storage.local.get(["scheduledTasks"]);
  const tasks = data.scheduledTasks || [];
  const task = tasks.find((t) => t.id === taskId);
  if (task) {
    task.active = Boolean(activeState);
    await chrome.storage.local.set({ scheduledTasks: tasks });
    if (task.active) {
      const alarmInfo = { delayInMinutes: task.delayMinutes || 1 };
      if (task.intervalMinutes > 0) alarmInfo.periodInMinutes = task.intervalMinutes;
      chrome.alarms.create(taskId, alarmInfo);
    } else {
      await chrome.alarms.clear(taskId);
    }
  }
  return { ok: true, task };
}

// -----------------------------------------------------------------------------
// Message router
// -----------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "STOP_TASK") {
    isTaskCancelled = true;
    broadcastLog("Task cancellation requested by user.", "error");
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "RUN_TASK") {
    runTask(message.instruction)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (message.type === "RUN_CHAT") {
    runChat(message.instruction, message.history)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (message.type === "TEST_PROVIDER") {
    testProvider(message.provider)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (message.type === "GET_SCHEDULED_TASKS") {
    chrome.storage.local.get(["scheduledTasks"], (data) => sendResponse({ ok: true, tasks: data.scheduledTasks || [] }));
    return true;
  }

  if (message.type === "ADD_SCHEDULED_TASK") {
    addScheduledTask(message.instruction, message.delayMinutes, message.intervalMinutes)
      .then((task) => sendResponse({ ok: true, task }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "DELETE_SCHEDULED_TASK") {
    deleteScheduledTask(message.taskId)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "TOGGLE_SCHEDULED_TASK") {
    toggleScheduledTask(message.taskId, message.activeState)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

// -----------------------------------------------------------------------------
// Chat Mode: Q&A / Page summarization and general AI conversation
// -----------------------------------------------------------------------------
async function runChat(instruction, history = []) {
  const tab = await getActiveTab();
  let pageData = { title: tab.title || "", url: tab.url || "", text: "" };

  try {
    await ensureContentScriptInjected(tab);
    const scraped = await sendToContentScript(tab.id, { type: "SCRAPE_TEXT" });
    if (scraped && scraped.text) {
      pageData = scraped;
    }
  } catch (err) {
    console.warn("Could not scrape page text for chat, proceeding with general AI chat:", err.message);
  }

  const systemPrompt = `You are AI Pilot, a helpful browser AI assistant.
You are assisting the user while viewing the following webpage:
Title: ${pageData.title || "Unknown Page"}
URL: ${pageData.url || "Unknown URL"}

Webpage Content:
"""
${pageData.text || "No page text content extracted."}
"""

Answer the user's questions clearly, accurately, and concisely. Use the webpage content when relevant to answer questions about the page, summarize content, or extract information. Use markdown formatting when appropriate.`;

  const { text: rawText, provider } = await callProviderWithFallback(systemPrompt, instruction, history, false);
  return { text: rawText, providerName: provider.name };
}

async function sendToContentScriptWithRetry(tabId, message, maxRetries = 2) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await sendToContentScript(tabId, message);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, 350));
    }
  }
}

function broadcastLog(text, level = "info", details = null) {
  try {
    chrome.runtime.sendMessage({
      type: "TASK_LOG",
      log: {
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
        text,
        level,
        details,
      },
    }).catch(() => {});
  } catch {}
}

function sendPushNotification(title, message) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: title || "AI Pilot",
      message: message || "Task completed!",
      priority: 2
    });
  } catch (e) {
    console.warn("Push notification error:", e);
  }
}

async function triggerCustomWebhook(taskResult) {
  try {
    const data = await chrome.storage.local.get(["webhookConnectorUrl"]);
    const url = (data.webhookConnectorUrl || "").trim();
    if (!url) return;

    broadcastLog(`Triggering Custom Webhook Connector...`, "info");
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "task.completed",
        timestamp: new Date().toISOString(),
        result: taskResult
      })
    });
    broadcastLog(`Custom Webhook payload sent successfully.`, "success");
  } catch (err) {
    console.warn("Webhook dispatch error:", err.message);
  }
}

// -----------------------------------------------------------------------------
// Autonomous Multi-Step Task Pipeline
// -----------------------------------------------------------------------------
async function runTask(instruction) {
  isTaskCancelled = false;
  const maxSteps = 10;
  const history = [];

  broadcastLog(`Goal: "${instruction}"`, "info");

  for (let stepIndex = 1; stepIndex <= maxSteps; stepIndex++) {
    if (isTaskCancelled) {
      broadcastLog("Task stopped by user.", "error");
      sendPushNotification("AI Pilot Task Stopped", "Task execution was cancelled by user.");
      return { action: "none", reason: "Task stopped by user.", providerName: "AI Pilot", history };
    }
    const currentTab = await getActiveTab();
    
    let elements = [];
    let pageTitle = currentTab.title || "";
    let pageUrl = currentTab.url || "";

    broadcastLog(`[Step ${stepIndex}] Observing tab: "${pageTitle.slice(0, 30)}..."`, "info");

    try {
      await ensureContentScriptInjected(currentTab);
      const scraped = await sendToContentScriptWithRetry(currentTab.id, { type: "SCRAPE" }, 2);
      if (scraped) {
        elements = scraped.elements || [];
        pageTitle = scraped.title || pageTitle;
        pageUrl = scraped.url || pageUrl;
        broadcastLog(`Found ${elements.length} interactive elements on current page`, "info");
      }
    } catch (err) {
      broadcastLog(`DOM inspection note: ${err.message}`, "info");
    }

    const userPrompt = JSON.stringify({
      userGoal: instruction,
      currentPageTitle: pageTitle,
      currentPageUrl: pageUrl,
      actionHistory: history,
      interactiveElements: elements,
    });

    broadcastLog(`Querying active AI model for next action...`, "ai");
    let action, activeProvider;
    try {
      const res = await callProviderWithFallback(AGENTIC_SYSTEM_PROMPT, userPrompt, [], true);
      action = res.result;
      activeProvider = res.provider;
    } catch (apiErr) {
      broadcastLog(`API Call Failed: ${apiErr.message}`, "error");
      sendPushNotification("AI Pilot Error", apiErr.message || "Task failed.");
      throw apiErr;
    }

    broadcastLog(`[${activeProvider.name}] Next Action: ${action.action}${action.step ? ` (${action.step})` : ""}${action.text ? ` -> "${action.text}"` : ""}`, "action", action);

    history.push({ step: action.step || action.action, action });

    if (action.action === "done") {
      const msg = action.message || "Goal accomplished successfully!";
      broadcastLog(`Task Completed: ${msg}`, "success");
      sendPushNotification("AI Pilot Task Complete", msg);
      triggerCustomWebhook({ action: "done", message: msg, instruction });
      return { action: "done", message: msg, providerName: activeProvider.name, history };
    }

    if (action.action === "none") {
      const reason = action.reason || "Unable to proceed further.";
      broadcastLog(`Task Stopped: ${reason}`, "error");
      sendPushNotification("AI Pilot Task Notice", reason);
      return { action: "none", reason: reason, providerName: activeProvider.name, history };
    }

    if (action.action === "navigate") {
      let targetUrl = (action.url || "").trim();
      if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
        targetUrl = "https://" + targetUrl;
      }
      broadcastLog(`Navigating to ${targetUrl}...`, "action");
      await chrome.tabs.update(currentTab.id, { url: targetUrl });
      await waitForTabComplete(currentTab.id);
      broadcastLog(`Page loaded. Waiting for hydration...`, "info");
      await new Promise((r) => setTimeout(r, 2500));
      continue;
    }

    if (action.action === "click" || action.action === "type") {
      broadcastLog(`Executing ${action.action} on ${action.selector}...`, "action");
      await ensureContentScriptInjected(currentTab);
      const execResult = await sendToContentScriptWithRetry(currentTab.id, { type: "EXECUTE", action }, 2);
      if (!execResult || !execResult.ok) {
        const errMsg = execResult?.error || `Failed to execute ${action.action} on ${action.selector}`;
        broadcastLog(errMsg, "error");
        throw new Error(errMsg);
      }
      broadcastLog(`Executed ${action.action} successfully.`, "success");
      continue;
    }
  }

  broadcastLog(`Reached maximum step limit (${maxSteps}).`, "info");
  return { action: "done", message: "Reached max step limit.", providerName: "AI Pilot", history };
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 10000);
  });
}

// -----------------------------------------------------------------------------
// Chrome API helpers
// -----------------------------------------------------------------------------
function getActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) resolve(tabs[0]);
      else reject(new Error("No active tab found."));
    });
  });
}

function isRestrictedUrl(url) {
  if (!url) return false;
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("view-source:") ||
    url.includes("chromewebstore.google.com") ||
    url.includes("chrome.google.com/webstore")
  );
}

async function ensureContentScriptInjected(tab) {
  if (isRestrictedUrl(tab.url)) {
    throw new Error("AI Pilot cannot run on browser internal pages (chrome://) or Web Store. Please open a regular website.");
  }
  try {
    await sendToContentScript(tab.id, { type: "PING" });
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
      await new Promise((r) => setTimeout(r, 100));
    } catch (err) {
      if (err.message && (err.message.includes("Cannot access") || err.message.includes("chrome://"))) {
        throw new Error("AI Pilot cannot run on browser internal pages (chrome://) or Web Store. Please open a regular website.");
      }
      throw new Error(`Could not connect to page: ${err.message || "Please refresh the active tab."}`);
    }
  }
}

function sendToContentScript(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response || {});
    });
  });
}

function getStoredState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["providers", "defaultProviderId"], (data) =>
      resolve({ providers: data.providers || [], defaultProviderId: data.defaultProviderId || "" })
    );
  });
}

// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// Automatic Provider Fallback Engine
// Automatically switches to the next enabled provider if the primary provider
// (e.g., Gemini) stops responding, throws an API error, or hits rate limits.
// -----------------------------------------------------------------------------
async function callProviderWithFallback(systemPrompt, userContent, history = [], parseJson = false) {
  const { providers, defaultProviderId } = await getStoredState();
  const enabled = providers.filter((p) => p.enabled);

  if (enabled.length === 0) {
    throw new Error("No AI model is enabled. Open Settings and turn one on.");
  }

  // Primary provider first, followed by all other enabled providers
  const primary = enabled.find((p) => p.id === defaultProviderId) || enabled[0];
  const fallbackList = [primary, ...enabled.filter((p) => p.id !== primary.id)];

  const errors = [];
  for (let i = 0; i < fallbackList.length; i++) {
    const provider = fallbackList[i];
    try {
      if (i > 0) {
        broadcastLog(`🔄 [Fallback Activated] ${fallbackList[i - 1].name} failed → Switching to ${provider.name} (${provider.model || "default"})`, "warn");
      }

      const rawText = await callProvider(provider, systemPrompt, userContent, history);
      if (!rawText || !rawText.trim()) {
        throw new Error(`Received empty response from ${provider.name}`);
      }

      if (parseJson) {
        const parsed = parseActionJSON(rawText);
        return { result: parsed, text: rawText, provider };
      }

      return { result: rawText, text: rawText, provider };
    } catch (err) {
      console.warn(`[Fallback Warning] Provider "${provider.name}" failed:`, err.message);
      errors.push(`${provider.name}: ${err.message}`);
      if (i < fallbackList.length - 1) {
        broadcastLog(`⚠️ [${provider.name}] Error: ${err.message}. Retrying with next enabled provider (${fallbackList[i + 1].name})...`, "warn");
      }
    }
  }

  throw new Error(`All enabled AI providers failed:\n${errors.join("\n")}`);
}

// -----------------------------------------------------------------------------
// Picks the provider to use: the saved default if it's enabled, otherwise
// the first enabled provider in the list ("Use first available").
// -----------------------------------------------------------------------------
async function getActiveProvider() {
  const { providers, defaultProviderId } = await getStoredState();
  const enabled = providers.filter((p) => p.enabled);

  if (enabled.length === 0) {
    throw new Error("No AI model is enabled. Open Settings and turn one on.");
  }

  return enabled.find((p) => p.id === defaultProviderId) || enabled[0];
}

// -----------------------------------------------------------------------------
// AI dispatch — routes to the correct request format based on provider.type
// -----------------------------------------------------------------------------
async function askAI(provider, instruction, elements) {
  const userContent = JSON.stringify({ instruction, elements });
  const rawText = await callProvider(provider, SYSTEM_PROMPT, userContent);
  return parseActionJSON(rawText);
}

function parseActionJSON(rawText) {
  if (!rawText) throw new Error("AI returned empty response.");
  const cleaned = rawText.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = rawText.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (err) {
        throw new Error(`Invalid JSON format from AI: ${err.message}`);
      }
    }
    throw new Error(`AI did not return valid JSON: ${rawText.slice(0, 150)}`);
  }
}

function callProvider(provider, systemPrompt, userContent, history = []) {
  if (provider.type === "anthropic") {
    return callAnthropicFormat(provider, systemPrompt, userContent, history);
  }
  return callOpenAIFormat(provider, systemPrompt, userContent, history);
}

function normalizeHost(host) {
  return (host || "").trim().replace(/\/+$/, "");
}

// -- OpenAI-compatible format (OpenAI, Groq, DeepSeek, Ollama, gateways...) --
async function callOpenAIFormat(provider, systemPrompt, userContent, history = []) {
  const host = normalizeHost(provider.host);
  if (!host) throw new Error(`Missing AI Host for "${provider.name}".`);

  const headers = { "Content-Type": "application/json" };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

  const messages = [{ role: "system", content: systemPrompt }];
  if (Array.isArray(history)) {
    history.forEach((h) => {
      if (h.role && h.content) messages.push({ role: h.role, content: h.content });
    });
  }
  messages.push({ role: "user", content: userContent });

  const res = await fetch(`${host}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: provider.model || "default",
      messages,
    }),
  });

  let data;
  try {
    data = await res.json();
  } catch {
    const rawBody = await res.text().catch(() => "");
    throw new Error(`[${provider.name}] HTTP ${res.status}: ${rawBody || res.statusText}`);
  }

  if (!res.ok) {
    const detail = data?.error?.message || data?.error?.details || (typeof data?.error === "string" ? data.error : null) || data?.message || JSON.stringify(data?.error || data);
    throw new Error(`[${provider.name}] HTTP ${res.status}: ${detail || "Request failed"}`);
  }

  if (!data?.choices || !data.choices[0]?.message) {
    throw new Error(`[${provider.name}] Invalid response format: missing choices.`);
  }

  return data.choices[0].message.content;
}

// -- Anthropic Messages format ------------------------------------------------
async function callAnthropicFormat(provider, systemPrompt, userContent, history = []) {
  const host = normalizeHost(provider.host) || "https://api.anthropic.com/v1";
  if (!provider.apiKey) throw new Error(`Missing API key for "${provider.name}".`);

  const messages = [];
  if (Array.isArray(history)) {
    history.forEach((h) => {
      if (h.role && h.content) messages.push({ role: h.role, content: h.content });
    });
  }
  messages.push({ role: "user", content: userContent });

  const res = await fetch(`${host}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": provider.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: provider.model || "claude-sonnet-4-6",
      max_tokens: 1000,
      system: systemPrompt,
      messages,
    }),
  });

  let data;
  try {
    data = await res.json();
  } catch {
    const rawBody = await res.text().catch(() => "");
    throw new Error(`[${provider.name}] HTTP ${res.status}: ${rawBody || res.statusText}`);
  }

  if (!res.ok) {
    const detail = data?.error?.message || (typeof data?.error === "string" ? data.error : null) || data?.message || JSON.stringify(data);
    throw new Error(`[${provider.name}] HTTP ${res.status}: ${detail || "Request failed"}`);
  }

  return data.content[0].text;
}

// -----------------------------------------------------------------------------
// "Test Connection" button — sends a trivial request, just checks it succeeds.
// -----------------------------------------------------------------------------
async function testProvider(provider) {
  await callProvider(provider, "Reply with the single word: ok", "ping");
}
