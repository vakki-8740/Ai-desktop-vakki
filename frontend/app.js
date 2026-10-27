/* VakkiAI Web frontend — vanilla JS, no CDN, no build step.
   API key kabhi browser me nahi aati; sirf backend se /api/chat call hota hai.
   Notes context tablet me rehta hai; tayyar note Android intent/share se device note app me jata hai. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const els = {
    statusDot: $("statusDot"),
    statusText: $("statusText"),
    chat: $("chat"),
    command: $("command"),
    charCount: $("charCount"),
    sendBtn: $("sendBtn"),
    voiceStartBtn: $("voiceStartBtn"),
    voiceStopBtn: $("voiceStopBtn"),
    cancelBtn: $("cancelBtn"),
    clearBtn: $("clearBtn"),
    language: $("language"),
    voiceSupport: $("voiceSupport"),
    notesPanel: $("notesPanel"),
    notesText: $("notesText"),
    noteFilename: $("noteFilename"),
    saveNoteBtn: $("saveNoteBtn"),
    downloadNoteBtn: $("downloadNoteBtn"),
    openNotesAppBtn: $("openNotesAppBtn"),
    shareNoteBtn: $("shareNoteBtn"),
    copyNoteBtn: $("copyNoteBtn"),
    notesTargetHint: $("notesTargetHint"),
    savedNotes: $("savedNotes"),
    notesContext: $("notesContext"),
    notesFile: $("notesFile"),
    importNotesBtn: $("importNotesBtn"),
    clearContextBtn: $("clearContextBtn"),
    useNotesContext: $("useNotesContext"),
    deepIdeaMode: $("deepIdeaMode"),
    apiBaseInput: $("apiBaseInput"),
    saveApiBtn: $("saveApiBtn"),
    resetApiBtn: $("resetApiBtn"),
    apiStatus: $("apiStatus"),
    configWarning: $("configWarning"),
    offlineBadge: $("offlineBadge"),
    footerMode: $("footerMode"),
  };

  const KEYS = {
    history: "vakkiai.history.v1",
    apiBase: "vakkiai.apiBase.v1",
    notePrefix: "vakkiai.note.v1.",
    notesContext: "vakkiai.notesContext.v1",
    useNotesContext: "vakkiai.useNotesContext.v1",
    deepIdeaMode: "vakkiai.deepIdeaMode.v1",
  };
  const DEFAULT_FILENAME = "vakkiai-note.md";
  const params = new URLSearchParams(window.location.search);

  let apiBase = "";
  let maxCommandChars = 4000;
  let maxNotesContextChars = 12000;
  let history = [];
  let abortController = null;
  let recognition = null;
  let currentNotes = "";
  let notesContext = "";

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (_error) { return null; }
  }
  function storageSet(key, value) {
    try { window.localStorage.setItem(key, value); return true; } catch (_error) { return false; }
  }
  function storageRemove(key) {
    try { window.localStorage.removeItem(key); } catch (_error) { /* ignore */ }
  }
  function storageKeys() {
    try { return Object.keys(window.localStorage); } catch (_error) { return []; }
  }

  function normalizeBase(value) {
    const raw = (value || "").trim();
    if (!raw) return "";
    let candidate = raw;
    if (!/^https?:\/\//i.test(candidate)) candidate = "https://" + candidate;
    try {
      const url = new URL(candidate);
      if (url.protocol !== "http:" && url.protocol !== "https:") return "";
      return url.origin;
    } catch (_error) {
      return "";
    }
  }

  function apiUrl(path) {
    return apiBase ? apiBase + path : path;
  }

  function setStatus(message, kind = "ok") {
    els.statusText.textContent = message;
    els.statusDot.className = "status-dot " + (kind || "ok");
  }

  function setBusy(isBusy) {
    els.sendBtn.disabled = isBusy;
    els.cancelBtn.disabled = !isBusy;
    els.voiceStartBtn.disabled = isBusy || !speechSupported();
    els.clearBtn.disabled = isBusy;
  }

  function updateCharCount() {
    const length = els.command.value.length;
    els.charCount.textContent = length + " / " + maxCommandChars;
    els.charCount.style.color = length > maxCommandChars ? "var(--error)" : "";
  }

  function renderMessage(role, text) {
    const wrap = document.createElement("div");
    wrap.className = "msg " + role;
    const label = document.createElement("span");
    label.className = "role";
    label.textContent = role === "user" ? "You" : role === "assistant" ? "VakkiAI" : role === "error" ? "Error" : "System";
    const body = document.createElement("span");
    body.textContent = String(text || "");
    wrap.appendChild(label);
    wrap.appendChild(body);
    els.chat.appendChild(wrap);
    els.chat.scrollTop = els.chat.scrollHeight;
  }

  function saveHistory() {
    history = history.slice(-8);
    storageSet(KEYS.history, JSON.stringify(history));
  }

  function appendChat(role, text, persist = false) {
    renderMessage(role, text);
    if (persist && (role === "user" || role === "assistant")) {
      history.push({ role, content: String(text || "") });
      saveHistory();
    }
  }

  function loadHistory() {
    try {
      const parsed = JSON.parse(storageGet(KEYS.history) || "[]");
      if (!Array.isArray(parsed)) return;
      history = parsed
        .filter((item) => item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
        .slice(-8)
        .map((item) => ({ role: item.role, content: item.content.slice(0, 4000) }));
      history.forEach((item) => renderMessage(item.role, item.content));
    } catch (_error) {
      history = [];
    }
  }

  function safeFilename(value) {
    if (typeof value !== "string") return DEFAULT_FILENAME;
    const name = value.trim();
    if (
      name.length > 0 &&
      name.length <= 100 &&
      /^[A-Za-z0-9._-]+$/.test(name) &&
      /\.(md|txt)$/i.test(name) &&
      !name.startsWith(".") &&
      !name.includes("..") &&
      !name.endsWith(".")
    ) {
      return name;
    }
    return DEFAULT_FILENAME;
  }

  function readableFetchError(error) {
    if (error && error.name === "AbortError") return "Request cancel kar di gayi.";
    if (error instanceof TypeError) {
      return "Backend se connect nahi ho paya. Internet ya Backend URL setting check karo.";
    }
    return (error && error.message) ? error.message : "Unknown network error.";
  }

  async function loadConfig() {
    setStatus("Connecting…", "working");
    try {
      const response = await fetch(apiUrl("/api/config"), { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || ("HTTP " + response.status));
      maxCommandChars = Number(data.max_command_chars) || 4000;
      maxNotesContextChars = Number(data.max_notes_context_chars) || maxNotesContextChars;
      els.command.maxLength = maxCommandChars;
      els.notesContext.maxLength = maxNotesContextChars;
      updateCharCount();
      if (data.default_language) els.language.value = data.default_language;
      els.configWarning.hidden = Boolean(data.has_api_key);
      els.footerMode.textContent = apiBase ? "Split mode" : "Live mode";
      if (!data.has_api_key) {
        setStatus("API key missing", "error");
      } else {
        setStatus("Ready • live", "ok");
      }
    } catch (error) {
      els.configWarning.hidden = true;
      els.footerMode.textContent = apiBase ? "Split mode" : "Live mode";
      setStatus("Backend unreachable", "error");
      appendChat("error", readableFetchError(error));
    }
  }

  async function sendCommand() {
    if (abortController) return;
    const command = els.command.value.trim();
    if (!command) {
      setStatus("Pehle command likho", "error");
      els.command.focus();
      return;
    }
    if (command.length > maxCommandChars) {
      setStatus("Command bahut lambi hai", "error");
      return;
    }

    saveNotesContext();
    const deep = els.deepIdeaMode.checked;
    const contextText = els.useNotesContext.checked
      ? notesContext.slice(0, maxNotesContextChars)
      : "";

    appendChat("user", command, true);
    els.command.value = "";
    updateCharCount();
    setBusy(true);
    setStatus(deep ? "AI gehra soch raha hai… thoda time lagega" : "AI soch raha hai…", "working");
    abortController = new AbortController();

    try {
      const response = await fetch(apiUrl("/api/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command,
          history: history.slice(-8),
          language: els.language.value,
          notes_context: contextText,
          deep,
        }),
        signal: abortController.signal,
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || ("HTTP " + response.status));

      const message = typeof data.message === "string" && data.message.trim()
        ? data.message
        : "AI response empty tha.";
      appendChat("assistant", message, true);

      if (typeof data.notes === "string" && data.notes.trim()) {
        currentNotes = data.notes;
        const filename = safeFilename(data.suggested_filename);
        els.notesText.textContent = currentNotes;
        els.noteFilename.value = filename;
        els.notesPanel.hidden = false;
        if (data.action === "open_notes_app") {
          els.notesTargetHint.textContent = "Note ready. Ab 'Open in Xiaomi Notes' dabao — Hinglish idea wahan pre-filled jayega.";
          setStatus("Note ready • Xiaomi Notes me bhejo", "ok");
        } else if (data.action === "download_note") {
          els.notesTargetHint.textContent = "Note ready. Download ya device note app me bhej sakte ho.";
          setStatus("Note ready • Save/Download", "ok");
        } else {
          els.notesTargetHint.textContent = "Response ke saath notes bhi ready hain.";
          setStatus("Response + notes ready", "ok");
        }
        try { els.notesPanel.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (_error) { /* optional */ }
      } else {
        currentNotes = "";
        els.notesPanel.hidden = true;
        setStatus("Response ready", "ok");
      }
    } catch (error) {
      if (error && error.name === "AbortError") {
        appendChat("system", "Request cancel kar di gayi.");
        setStatus("Cancelled", "ok");
      } else {
        const message = readableFetchError(error);
        appendChat("error", message);
        setStatus("AI request failed", "error");
      }
    } finally {
      abortController = null;
      setBusy(false);
    }
  }

  function cancelRequest() {
    if (abortController) abortController.abort();
  }

  function clearConversation() {
    if (!window.confirm("Conversation clear karein? Saved notes aur notes context delete nahi honge.")) return;
    els.chat.replaceChildren();
    history = [];
    storageRemove(KEYS.history);
    currentNotes = "";
    els.notesPanel.hidden = true;
    els.command.value = "";
    updateCharCount();
    appendChat("system", "Conversation clear kar di gayi. Notes context safe hai. Naya command likho.");
    setStatus("Ready", "ok");
  }

  const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
  function speechSupported() {
    return Boolean(SpeechRecognitionClass);
  }

  function updateVoiceSupport() {
    if (!speechSupported()) {
      els.voiceSupport.textContent = "Voice unsupported • text use karo";
      els.voiceStartBtn.disabled = true;
      return;
    }
    if (!window.isSecureContext) {
      els.voiceSupport.textContent = "Voice needs HTTPS • text use karo";
      return;
    }
    els.voiceSupport.textContent = "Voice ready • Chrome/Edge recommended";
  }

  function voiceErrorMessage(code) {
    const messages = {
      "not-allowed": "Microphone permission nahi mili. Chrome address bar ke lock icon se Mic Allow karo.",
      "service-not-allowed": "Speech service allowed nahi hai. HTTPS aur browser settings check karo.",
      "network": "Speech recognition ke liye internet chahiye; connection check karo.",
      "no-speech": "Awaaz samajh nahi aayi; thodi der baad dobara bolo.",
      "audio-capture": "Microphone available nahi hai; tablet mic check karo.",
      "aborted": "Voice input band kar diya gaya.",
    };
    return messages[code] || ("Voice error: " + (code || "unknown"));
  }

  function appendToCommand(text) {
    const existing = els.command.value.trim();
    const combined = existing ? existing + "\n" + text : text;
    els.command.value = combined.slice(0, maxCommandChars);
    updateCharCount();
    els.command.focus();
  }

  function startVoice() {
    if (!speechSupported() || recognition || abortController) return;
    recognition = new SpeechRecognitionClass();
    recognition.lang = els.language.value || "hi-IN";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      els.voiceStartBtn.disabled = true;
      els.voiceStopBtn.disabled = false;
      setStatus("Mic chal raha hai… bolo", "working");
    };
    recognition.onresult = (event) => {
      let text = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        if (event.results[i].isFinal) text += event.results[i][0].transcript;
      }
      if (text.trim()) appendToCommand(text.trim());
    };
    recognition.onerror = (event) => {
      const message = voiceErrorMessage(event.error);
      appendChat("error", message);
      setStatus("Voice failed", "error");
    };
    recognition.onend = () => {
      recognition = null;
      els.voiceStartBtn.disabled = Boolean(abortController);
      els.voiceStopBtn.disabled = true;
      if (els.statusText.textContent.indexOf("Mic chal") === 0) setStatus("Voice band", "ok");
    };

    try {
      recognition.start();
    } catch (error) {
      recognition = null;
      appendChat("error", "Voice start nahi ho paya: " + (error.message || "unknown"));
      setStatus("Voice failed", "error");
    }
  }

  function stopVoice() {
    if (recognition) {
      try { recognition.stop(); } catch (_error) { /* ignore */ }
    }
  }

  function saveCurrentNote() {
    if (!currentNotes.trim()) {
      setStatus("Save karne ke liye notes nahi hain", "error");
      return;
    }
    const filename = safeFilename(els.noteFilename.value);
    els.noteFilename.value = filename;
    const item = {
      filename,
      text: currentNotes,
      updatedAt: new Date().toISOString(),
    };
    if (!storageSet(KEYS.notePrefix + filename, JSON.stringify(item))) {
      appendChat("error", "Tablet storage available nahi hai; Download use karo.");
      return;
    }
    renderSavedNotes();
    appendChat("system", "Note tablet me save ho gayi: " + filename);
    setStatus("Note saved locally", "ok");
  }

  function downloadText(filename, text) {
    const safe = safeFilename(filename);
    const blob = new Blob([text.trim() + "\n"], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = safe;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadCurrentNote() {
    if (!currentNotes.trim()) {
      setStatus("Download karne ke liye notes nahi hain", "error");
      return;
    }
    downloadText(els.noteFilename.value, currentNotes);
    setStatus("Note download shuru", "ok");
  }

  function renderSavedNotes() {
    els.savedNotes.replaceChildren();
    const items = [];
    for (const key of storageKeys()) {
      if (!key.startsWith(KEYS.notePrefix)) continue;
      try {
        const item = JSON.parse(storageGet(key) || "null");
        if (item && typeof item.filename === "string" && typeof item.text === "string") {
          items.push({ key, ...item });
        }
      } catch (_error) { /* ignore corrupt entry */ }
    }
    items.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "Abhi koi saved note nahi hai.";
      els.savedNotes.appendChild(empty);
      return;
    }
    for (const item of items.slice(0, 20)) {
      const row = document.createElement("div");
      row.className = "saved-note";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = item.filename;
      const actions = document.createElement("span");
      actions.className = "actions";
      const download = document.createElement("button");
      download.type = "button";
      download.textContent = "Download";
      download.addEventListener("click", () => downloadText(item.filename, item.text));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger";
      remove.textContent = "Delete";
      remove.addEventListener("click", () => {
        if (!window.confirm("Ye note tablet se delete karein?")) return;
        storageRemove(item.key);
        renderSavedNotes();
      });
      actions.appendChild(download);
      actions.appendChild(remove);
      row.appendChild(name);
      row.appendChild(actions);
      els.savedNotes.appendChild(row);
    }
  }

  /* ---------- Notes context + device note app helpers ---------- */

  function cleanNotesText(value) {
    return String(value || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
      .trim();
  }

  function loadNotesContext() {
    notesContext = cleanNotesText(storageGet(KEYS.notesContext) || "").slice(0, maxNotesContextChars);
    els.notesContext.value = notesContext;
  }

  function saveNotesContext() {
    notesContext = cleanNotesText(els.notesContext.value).slice(0, maxNotesContextChars);
    els.notesContext.value = notesContext;
    storageSet(KEYS.notesContext, notesContext);
  }

  function loadToggles() {
    els.useNotesContext.checked = storageGet(KEYS.useNotesContext) !== "0";
    els.deepIdeaMode.checked = storageGet(KEYS.deepIdeaMode) !== "0";
  }

  function appendNotesContext(text, label) {
    const clean = cleanNotesText(text);
    if (!clean) return false;
    const entry = "\n\n--- " + String(label || "Note") + " ---\n" + clean;
    notesContext = (notesContext + entry).slice(-maxNotesContextChars);
    els.notesContext.value = notesContext;
    storageSet(KEYS.notesContext, notesContext);
    return true;
  }

  async function importNotesFiles() {
    const files = Array.from(els.notesFile.files || []);
    if (!files.length) {
      setStatus("Pehle .txt ya .md file choose karo", "error");
      return;
    }
    let added = 0;
    for (const file of files) {
      if (file.size > 512 * 1024) {
        appendChat("error", file.name + " bahut badi hai; 512 KB se chhoti file choose karo.");
        continue;
      }
      try {
        const text = await file.text();
        if (appendNotesContext(text, file.name)) added += 1;
      } catch (_error) {
        appendChat("error", file.name + " padh nahi paya.");
      }
    }
    els.notesFile.value = "";
    if (added) {
      appendChat("system", added + " note(s) context me add ho gaye. Ab AI inko use karega.");
      setStatus("Notes context ready", "ok");
    }
  }

  function clearNotesContext() {
    if (!notesContext && !els.notesContext.value) {
      setStatus("Notes context already empty hai", "ok");
      return;
    }
    if (!window.confirm("Notes context clear karein? Aapke Xiaomi Notes app ka asli data safe rahega.")) return;
    notesContext = "";
    els.notesContext.value = "";
    storageRemove(KEYS.notesContext);
    appendChat("system", "Notes context clear kar diya. Device notes app ka data safe hai.");
    setStatus("Context cleared", "ok");
  }

  function handleShareTarget() {
    const title = params.get("shared_title") || "";
    const text = params.get("shared_text") || "";
    const url = params.get("shared_url") || "";
    if (!title && !text && !url) return;
    const combined = [title, text, url].filter(Boolean).join("\n\n");
    if (appendNotesContext(combined, "Shared from note app")) {
      appendChat("system", "Note app se shared text context me add ho gaya.");
      setStatus("Shared note added", "ok");
    }
    try {
      window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
    } catch (_error) { /* optional */ }
  }

  function notesSubject() {
    const date = new Date().toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
    return "VakkiAI Idea - " + date;
  }

  function buildShareText() {
    const body = (currentNotes || "").trim();
    return notesSubject() + "\n\n" + body + "\n\n---\nVakkiAI se generated (Hinglish).";
  }

  function encodeExtra(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) =>
      "%" + char.charCodeAt(0).toString(16).toUpperCase()
    );
  }

  function openInXiaomiNotes() {
    if (!currentNotes.trim()) {
      setStatus("Notes app me bhejne ke liye notes nahi hain", "error");
      return;
    }
    const appName = window.VAKKIAI_NOTES_APP_NAME || "Xiaomi Notes";
    const pkg = window.VAKKIAI_NOTES_APP_PACKAGE || "com.miui.notes";
    const fallback = window.location.origin + window.location.pathname;
    const intentUrl =
      "intent://#Intent;" +
      "action=android.intent.action.SEND;" +
      "type=text/plain;" +
      "category=android.intent.category.DEFAULT;" +
      "package=" + pkg + ";" +
      "S.android.intent.extra.TEXT=" + encodeExtra(buildShareText()) + ";" +
      "S.android.intent.extra.SUBJECT=" + encodeExtra(notesSubject()) + ";" +
      "S.browser_fallback_url=" + encodeExtra(fallback) + ";" +
      "end";
    setStatus(appName + " khul raha hai…", "working");
    window.location.href = intentUrl;
  }

  async function shareNoteToAnyApp() {
    if (!currentNotes.trim()) {
      setStatus("Share karne ke liye notes nahi hain", "error");
      return;
    }
    if (!navigator.share) {
      appendChat("system", "Web Share supported nahi hai; download ya copy use karo.");
      downloadCurrentNote();
      return;
    }
    try {
      await navigator.share({ title: notesSubject(), text: buildShareText() });
      setStatus("Share complete", "ok");
    } catch (error) {
      if (error && error.name === "AbortError") {
        setStatus("Share cancel", "ok");
        return;
      }
      appendChat("error", "Share nahi ho paya: " + ((error && error.message) || "unknown"));
      setStatus("Share failed", "error");
    }
  }

  async function copyNote() {
    if (!currentNotes.trim()) {
      setStatus("Copy karne ke liye notes nahi hain", "error");
      return;
    }
    try {
      await navigator.clipboard.writeText(buildShareText());
      setStatus("Note copy ho gaya", "ok");
    } catch (_error) {
      appendChat("system", "Clipboard available nahi hai; download shuru kar rahe hain.");
      downloadCurrentNote();
    }
  }

  /* ---------- Existing settings + init ---------- */

  function updateApiUi() {
    els.apiBaseInput.value = apiBase;
    els.apiStatus.textContent = apiBase
      ? "Using backend: " + apiBase
      : "Using same domain (recommended for one Render service).";
  }

  function saveApiBase() {
    const normalized = normalizeBase(els.apiBaseInput.value);
    if (!normalized && els.apiBaseInput.value.trim()) {
      els.apiStatus.textContent = "URL valid nahi hai. Example: https://your-service.onrender.com";
      setStatus("Backend URL invalid", "error");
      return;
    }
    apiBase = normalized;
    if (apiBase) storageSet(KEYS.apiBase, apiBase);
    else storageRemove(KEYS.apiBase);
    updateApiUi();
    loadConfig();
  }

  function resetApiBase() {
    apiBase = normalizeBase(window.VAKKIAI_API_BASE || "");
    if (apiBase) storageSet(KEYS.apiBase, apiBase);
    else storageRemove(KEYS.apiBase);
    updateApiUi();
    loadConfig();
  }

  function updateOnlineStatus() {
    els.offlineBadge.hidden = navigator.onLine;
    if (!navigator.onLine) setStatus("Offline", "error");
  }

  function registerServiceWorker() {
    if ("serviceWorker" in navigator && window.location.protocol === "https:") {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js").catch(() => { /* optional */ });
      });
    }
  }

  function init() {
    apiBase = normalizeBase(
      params.get("api") || storageGet(KEYS.apiBase) || window.VAKKIAI_API_BASE || ""
    );
    const configuredLanguage = window.VAKKIAI_DEFAULT_LANGUAGE;
    if (configuredLanguage) els.language.value = configuredLanguage;
    updateApiUi();
    loadHistory();
    loadNotesContext();
    loadToggles();
    handleShareTarget();
    if (els.chat.children.length === 0) {
      appendChat("system", "VakkiAI Web live mode me ready. Hinglish me command likho ya Start voice dabao.");
    }
    renderSavedNotes();
    updateVoiceSupport();
    updateOnlineStatus();
    updateCharCount();
    registerServiceWorker();

    els.command.addEventListener("input", updateCharCount);
    els.sendBtn.addEventListener("click", sendCommand);
    els.cancelBtn.addEventListener("click", cancelRequest);
    els.clearBtn.addEventListener("click", clearConversation);
    els.voiceStartBtn.addEventListener("click", startVoice);
    els.voiceStopBtn.addEventListener("click", stopVoice);
    els.saveNoteBtn.addEventListener("click", saveCurrentNote);
    els.downloadNoteBtn.addEventListener("click", downloadCurrentNote);
    els.openNotesAppBtn.addEventListener("click", openInXiaomiNotes);
    els.shareNoteBtn.addEventListener("click", shareNoteToAnyApp);
    els.copyNoteBtn.addEventListener("click", copyNote);
    els.saveApiBtn.addEventListener("click", saveApiBase);
    els.resetApiBtn.addEventListener("click", resetApiBase);
    els.notesContext.addEventListener("input", saveNotesContext);
    els.importNotesBtn.addEventListener("click", importNotesFiles);
    els.notesFile.addEventListener("change", importNotesFiles);
    els.clearContextBtn.addEventListener("click", clearNotesContext);
    els.useNotesContext.addEventListener("change", () => {
      storageSet(KEYS.useNotesContext, els.useNotesContext.checked ? "1" : "0");
    });
    els.deepIdeaMode.addEventListener("change", () => {
      storageSet(KEYS.deepIdeaMode, els.deepIdeaMode.checked ? "1" : "0");
    });
    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);
    els.command.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        sendCommand();
      }
    });

    loadConfig();
  }

  init();
})();
