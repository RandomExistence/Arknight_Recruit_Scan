/**
 * app.js
 *
 * Wires up the camera, a periodic capture -> preprocess -> OCR loop
 * (Tesseract.js), fuzzy-matches the OCR text against the known
 * recruitment-tag vocabulary (tags.js), and lets the user confirm a
 * selection to jump to arkpedia.net with those tags pre-selected.
 *
 * Everything here runs client-side; no image or text ever leaves the
 * browser.
 */
(function () {
  "use strict";

  // ---- Tunable OCR settings ------------------------------------------
  // These are the same values described in the Advanced Settings panel.
  // They start at these defaults and can be changed live from the UI;
  // changes persist to localStorage (per-browser, never sent anywhere).
  const DEFAULT_SETTINGS = {
    scanIntervalMs: 900, // how often a frame is captured + OCR'd
    captureWidth: 900, // frame is downscaled to this width before OCR
    brightnessThreshold: 170, // 0-255 cutoff used to binarize the frame
    ocrGenerosity: window.RecruitTags.DEFAULT_OCR_GENEROSITY, // see tags.js
  };

  const SETTINGS_STORAGE_KEY = "recruitScanSettings";

  function loadSettings() {
    let stored = {};
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (raw) stored = JSON.parse(raw) || {};
    } catch (err) {
      // localStorage unavailable (private browsing, etc.) - defaults only.
    }
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  function persistSettings() {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch (err) {
      // ignore - settings just won't survive a reload
    }
  }

  let settings = loadSettings();

  // ---- DOM references -----------------------------------------------
  const video = document.getElementById("video");
  const captureCanvas = document.getElementById("captureCanvas");
  const cameraOverlay = document.getElementById("cameraOverlay");
  const cameraStatus = document.getElementById("cameraStatus");

  const startBtn = document.getElementById("startBtn");
  const switchCameraBtn = document.getElementById("switchCameraBtn");
  const pauseBtn = document.getElementById("pauseBtn");
  const engineStatus = document.getElementById("engineStatus");

  const tagList = document.getElementById("tagList");
  const tagCount = document.getElementById("tagCount");
  const tagWarning = document.getElementById("tagWarning");
  const clearBtn = document.getElementById("clearBtn");
  const manualTagSelect = document.getElementById("manualTagSelect");
  const manualAddBtn = document.getElementById("manualAddBtn");
  const confirmBtn = document.getElementById("confirmBtn");

  const scanIntervalInput = document.getElementById("scanIntervalInput");
  const scanIntervalValue = document.getElementById("scanIntervalValue");
  const captureWidthInput = document.getElementById("captureWidthInput");
  const captureWidthValue = document.getElementById("captureWidthValue");
  const brightnessInput = document.getElementById("brightnessInput");
  const brightnessValue = document.getElementById("brightnessValue");
  const generosityInput = document.getElementById("generosityInput");
  const generosityValue = document.getElementById("generosityValue");
  const resetSettingsBtn = document.getElementById("resetSettingsBtn");

  // ---- State ----------------------------------------------------------
  let worker = null; // Tesseract.js worker
  let workerReady = false;

  let stream = null;
  let videoDevices = [];
  let currentDeviceId = null;

  let scanTimer = null;
  let scanning = false;
  let ocrBusy = false;

  /** tag -> boolean (included in the final selection or not) */
  const chipState = new Map();

  // ---- OCR engine setup -------------------------------------------------
  async function initOcrEngine() {
    try {
      worker = await Tesseract.createWorker("eng", 1, {
        logger: () => {}, // silence per-tile progress logs
      });
      await worker.setParameters({
        tessedit_char_whitelist:
          "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz -",
        tessedit_pageseg_mode: "11", // sparse text: scattered short phrases
      });
      workerReady = true;
      engineStatus.textContent = "OCR engine ready.";
    } catch (err) {
      console.error("Failed to initialize OCR engine", err);
      engineStatus.textContent =
        "Could not load the OCR engine (check your connection) — scanning is unavailable.";
    }
  }

  // ---- Camera handling --------------------------------------------------
  async function refreshDeviceList() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      videoDevices = devices.filter((d) => d.kind === "videoinput");
      switchCameraBtn.hidden = videoDevices.length < 2;
    } catch (err) {
      // enumerateDevices can fail on some browsers before permission; ignore.
    }
  }

  async function startCamera(deviceId) {
    stopCamera();

    const videoConstraints = deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      : {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        };

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false,
      });
    } catch (err) {
      console.error("Camera error", err);
      cameraStatus.textContent =
        err && err.name === "NotAllowedError"
          ? "Camera permission denied. Allow camera access and try again."
          : "Could not access a camera on this device.";
      cameraOverlay.classList.remove("hidden");
      return false;
    }

    video.srcObject = stream;
    await video.play();

    const track = stream.getVideoTracks()[0];
    currentDeviceId = track && track.getSettings ? track.getSettings().deviceId : deviceId;

    await refreshDeviceList();
    cameraOverlay.classList.add("hidden");
    pauseBtn.hidden = false;
    pauseBtn.textContent = "Pause Scan";
    startBtn.textContent = "Restart Camera";

    startScanning();
    return true;
  }

  function stopCamera() {
    stopScanning();
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
  }

  async function switchCamera() {
    if (videoDevices.length < 2) return;
    const currentIndex = videoDevices.findIndex((d) => d.deviceId === currentDeviceId);
    const nextIndex = (currentIndex + 1) % videoDevices.length;
    await startCamera(videoDevices[nextIndex].deviceId);
  }

  // ---- Capture + preprocess ----------------------------------------------
  function captureProcessedCanvas() {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    const scale = Math.min(1, settings.captureWidth / vw);
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));

    captureCanvas.width = w;
    captureCanvas.height = h;
    const ctx = captureCanvas.getContext("2d");
    ctx.drawImage(video, 0, 0, w, h);

    // Grayscale + hard threshold: the in-game tag buttons are bold white
    // text on a near-black background, so isolating bright pixels gives
    // Tesseract a clean, high-contrast image to work with.
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    const threshold = settings.brightnessThreshold;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const v = lum >= threshold ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(imgData, 0, 0);

    return captureCanvas;
  }

  // ---- Scan loop -----------------------------------------------------------
  async function scanOnce() {
    if (ocrBusy || !workerReady) return;
    const canvas = captureProcessedCanvas();
    if (!canvas) return;

    ocrBusy = true;
    try {
      const { data } = await worker.recognize(canvas);
      const text = (data && data.text) || "";
      const matches = window.RecruitTags.findMatches(text, {
        generosity: settings.ocrGenerosity,
      });
      for (const { tag } of matches) addDetectedTag(tag);
    } catch (err) {
      console.error("OCR recognize failed", err);
    } finally {
      ocrBusy = false;
    }
  }

  function startScanning() {
    if (scanning) return;
    scanning = true;
    scanTimer = setInterval(scanOnce, settings.scanIntervalMs);
  }

  function stopScanning() {
    scanning = false;
    if (scanTimer) {
      clearInterval(scanTimer);
      scanTimer = null;
    }
  }

  function toggleScanning() {
    if (scanning) {
      stopScanning();
      pauseBtn.textContent = "Resume Scan";
    } else {
      startScanning();
      pauseBtn.textContent = "Pause Scan";
    }
  }

  /** Re-applies the current scan interval to a running timer without
   * touching the paused/running state (unlike stopScanning+startScanning). */
  function restartScanTimer() {
    if (!scanning) return;
    if (scanTimer) clearInterval(scanTimer);
    scanTimer = setInterval(scanOnce, settings.scanIntervalMs);
  }

  // ---- Tag chip state --------------------------------------------------------
  function addDetectedTag(tag) {
    if (chipState.has(tag)) return; // sticky: don't override a manual toggle
    chipState.set(tag, true);
    renderTags();
  }

  function removeTag(tag) {
    chipState.delete(tag);
    renderTags();
  }

  function toggleTag(tag) {
    if (chipState.has(tag)) chipState.set(tag, !chipState.get(tag));
    renderTags();
  }

  function clearAllTags() {
    chipState.clear();
    renderTags();
  }

  function manualAddTag(tag) {
    if (!tag) return;
    chipState.set(tag, true);
    renderTags();
  }

  function renderTags() {
    tagList.innerHTML = "";

    for (const [tag, included] of chipState.entries()) {
      const li = document.createElement("li");
      li.className = "tag-chip" + (included ? "" : " off");

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = included;
      checkbox.setAttribute("aria-label", `Include ${tag}`);
      checkbox.addEventListener("change", () => toggleTag(tag));

      const label = document.createElement("span");
      label.textContent = tag;

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "remove-btn";
      removeBtn.setAttribute("aria-label", `Remove ${tag}`);
      removeBtn.textContent = "✕";
      removeBtn.addEventListener("click", () => removeTag(tag));

      li.append(checkbox, label, removeBtn);
      tagList.appendChild(li);
    }

    const includedCount = [...chipState.values()].filter(Boolean).length;
    tagCount.textContent = `(${chipState.size})`;
    tagWarning.hidden = includedCount <= 5;
    confirmBtn.disabled = includedCount === 0;
  }

  // ---- URL building + navigation -------------------------------------------
  function tagToParam(tag) {
    return encodeURIComponent(tag).replace(/%20/g, "+");
  }

  function buildArkpediaUrl() {
    const included = [...chipState.entries()]
      .filter(([, inc]) => inc)
      .map(([tag]) => tag);
    const hash = included.map((t) => `tag=${tagToParam(t)}`).join("&");
    return `https://www.arkpedia.net/recruitment#${hash}`;
  }

  // ---- Manual add dropdown ---------------------------------------------------
  function populateManualSelect() {
    manualTagSelect.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "— choose a tag —";
    manualTagSelect.appendChild(placeholder);

    for (const tag of window.RecruitTags.ALL_TAGS) {
      const opt = document.createElement("option");
      opt.value = tag;
      opt.textContent = tag;
      manualTagSelect.appendChild(opt);
    }
  }

  // ---- Advanced settings panel -----------------------------------------------
  function applySettingsToInputs() {
    scanIntervalInput.value = settings.scanIntervalMs;
    scanIntervalValue.textContent = settings.scanIntervalMs;

    captureWidthInput.value = settings.captureWidth;
    captureWidthValue.textContent = settings.captureWidth;

    brightnessInput.value = settings.brightnessThreshold;
    brightnessValue.textContent = settings.brightnessThreshold;

    generosityInput.value = settings.ocrGenerosity;
    generosityValue.textContent = Number(settings.ocrGenerosity).toFixed(2);
  }

  scanIntervalInput.addEventListener("input", () => {
    settings.scanIntervalMs = Number(scanIntervalInput.value);
    scanIntervalValue.textContent = settings.scanIntervalMs;
    persistSettings();
    restartScanTimer();
  });

  captureWidthInput.addEventListener("input", () => {
    settings.captureWidth = Number(captureWidthInput.value);
    captureWidthValue.textContent = settings.captureWidth;
    persistSettings();
  });

  brightnessInput.addEventListener("input", () => {
    settings.brightnessThreshold = Number(brightnessInput.value);
    brightnessValue.textContent = settings.brightnessThreshold;
    persistSettings();
  });

  generosityInput.addEventListener("input", () => {
    settings.ocrGenerosity = Number(generosityInput.value);
    generosityValue.textContent = settings.ocrGenerosity.toFixed(2);
    persistSettings();
  });

  resetSettingsBtn.addEventListener("click", () => {
    settings = { ...DEFAULT_SETTINGS };
    persistSettings();
    applySettingsToInputs();
    restartScanTimer();
  });

  // ---- Event wiring --------------------------------------------------------
  startBtn.addEventListener("click", () => startCamera());
  switchCameraBtn.addEventListener("click", switchCamera);
  pauseBtn.addEventListener("click", toggleScanning);
  clearBtn.addEventListener("click", clearAllTags);
  manualAddBtn.addEventListener("click", () => {
    manualAddTag(manualTagSelect.value);
    manualTagSelect.value = "";
  });
  confirmBtn.addEventListener("click", () => {
    window.location.href = buildArkpediaUrl();
  });

  window.addEventListener("beforeunload", stopCamera);

  // ---- Init ------------------------------------------------------------------
  populateManualSelect();
  applySettingsToInputs();
  renderTags();
  initOcrEngine();

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    cameraStatus.textContent = "This browser doesn't support camera access.";
    startBtn.disabled = true;
  }
})();
