// =============================================================================
// content.js
// Runs inside every page. Two jobs only:
//   1. SCRAPE   -> collect a clean list of interactive elements for the AI.
//   2. EXECUTE  -> run a single "click" or "type" action returned by the AI.
// =============================================================================

// Attribute we stamp onto elements so the AI can reference them with a
// selector that is guaranteed unique, instead of guessing a CSS path.
const TAG_ATTR = "data-ai-id";

// CSS selectors for elements worth exposing to the AI.
const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "textarea",
  "select",
  "[role='button']",
  "[role='tab']",
  "[role='option']",
  "[role='menuitem']",
  "[role='link']",
  "[role='row']",
  "[role='treeitem']",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

/**
 * Builds a short, human-readable label for an element so the AI can
 * understand what it does without seeing raw HTML.
 */
function describeElement(el) {
  const text = (el.innerText || el.value || el.placeholder || el.getAttribute("aria-label") || el.getAttribute("title") || "")
    .trim()
    .slice(0, 80);
  return {
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute("type") || null,
    role: el.getAttribute("role") || null,
    ariaLabel: el.getAttribute("aria-label") || null,
    placeholder: el.getAttribute("placeholder") || null,
    name: el.getAttribute("name") || null,
    text,
  };
}

/**
 * Scans the visible DOM, stamps each interactive element with a unique
 * data-ai-id, and returns a lightweight JSON list describing them.
 */
function scrapeInteractiveElements() {
  const elements = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR));
  const results = [];
  let visibleId = 0;

  elements.forEach((el) => {
    // Skip elements that are hidden or effectively invisible.
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const isVisible =
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none";

    if (!isVisible) return;

    el.setAttribute(TAG_ATTR, visibleId);

    results.push({
      selector: `[${TAG_ATTR}="${visibleId}"]`,
      id: visibleId,
      ...describeElement(el),
    });
    visibleId++;
  });

  return {
    title: document.title || "",
    url: window.location.href,
    elements: results,
  };
}

/**
 * Executes a single action decided by the AI: { action, selector, text, step }
 */
function executeAction(action) {
  let el = document.querySelector(action.selector);

  // Fallback for SPAs (Google Chat, Gmail, Spotify) if dynamic re-render removed the stamped attribute
  if (!el && action.step) {
    const stepWords = (action.step || "").toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const visibleEls = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR)).filter((e) => {
      const rect = e.getBoundingClientRect();
      const style = window.getComputedStyle(e);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    });

    el = visibleEls.find((e) => {
      const desc = describeElement(e);
      const combined = `${desc.text} ${desc.ariaLabel} ${desc.placeholder} ${desc.name}`.toLowerCase();
      return stepWords.some((word) => combined.includes(word));
    }) || visibleEls[0];
  }

  if (!el) {
    return { ok: false, error: `Element not found for selector: ${action.selector}` };
  }

  if (action.action === "click") {
    try {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    } catch {}
    el.click();
    return { ok: true };
  }

  if (action.action === "type") {
    focusAndType(el, action.text ?? "");
    return { ok: true };
  }

  return { ok: false, error: `Unknown action type: ${action.action}` };
}

/**
 * Focuses an input/textarea/contenteditable element, sets its value, and
 * dispatches the standard events frameworks (React, Vue, etc.) listen for.
 */
function focusAndType(el, text) {
  el.focus(); 

  if (el.isContentEditable) {
    try {
      document.execCommand("insertText", false, text);
    } catch {}
    if (!el.innerText || el.innerText.trim() === "") {
      el.innerText = text;
    }
  } else {
    // Use the native setter for the element's actual prototype so frameworks (React, Vue, etc.)
    // detect the change without throwing "Illegal invocation" when el is a textarea or select.
    let nativeSetter = null;
    let targetProto = Object.getPrototypeOf(el);
    while (targetProto && !nativeSetter) {
      const desc = Object.getOwnPropertyDescriptor(targetProto, "value");
      if (desc && desc.set) {
        nativeSetter = desc.set;
      } else {
        targetProto = Object.getPrototypeOf(targetProto);
      }
    }

    if (nativeSetter) {
      try {
        nativeSetter.call(el, text);
      } catch {
        el.value = text;
      }
    } else {
      el.value = text;
    }
  }

  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));

  // Dispatch Enter key events so search boxes and forms submit automatically
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, code: "Enter", which: 13, bubbles: true, cancelable: true }));
  el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", keyCode: 13, code: "Enter", which: 13, bubbles: true, cancelable: true }));
}

/**
 * Extracts clean webpage title, URL, and main body text for Q&A and summarization.
 */
function scrapePageText() {
  const title = document.title || "";
  const url = window.location.href;
  let text = "";

  if (document.body) {
    text = document.body.innerText || "";
  }

  // Clean excessive whitespace and truncate to reasonable context window length
  text = text.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim().slice(0, 12000);

  return { title, url, text };
}
// -----------------------------------------------------------------------------
// Message router: background.js talks to this script through chrome.runtime.
// -----------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PING") {
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "SCRAPE_TEXT") {
    sendResponse(scrapePageText());
    return true;
  }

  if (message.type === "SCRAPE") {
    sendResponse(scrapeInteractiveElements());
    return true;
  }

  if (message.type === "EXECUTE") {
    sendResponse(executeAction(message.action));
    return true;
  }
});