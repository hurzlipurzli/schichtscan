(function () {
  'use strict';

  const APP_VERSION = '1.3.0';
  const SETTINGS_KEY = 'schichtscan.settings.v2';
  const state = {
    files: [],
    fileUrls: [],
    events: [],
    rawResults: [],
    parserWarnings: [],
    ignoredDaysOff: 0,
    mergeStats: { inputCount: 0, mergedCount: 0, fuzzyMergedCount: 0, normalizedCount: 0 },
    processing: false,
    activeFileIndex: -1,
    worker: null,
    editingEventId: '',
    selectionRevision: 0
  };

  const elements = {};
  let toastTimer = null;

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    cacheElements();
    bindEvents();
    loadSettings();
    registerServiceWorker();

    if (window.location.protocol === 'file:') {
      showFatalError('Die OCR kann nicht zuverlässig direkt aus einer lokalen Datei gestartet werden. Du brauchst aber keinen gekauften Server: Eine kostenlose statische HTTPS-Seite genügt; nach der Installation arbeitet SchichtScan offline.');
    } else if (!window.Tesseract || !window.ShiftParser || !window.IcsBuilder) {
      showFatalError('Die Anwendung konnte nicht vollständig geladen werden. Bitte die Seite neu laden und prüfen, ob alle Dateien auf dem Webserver vorhanden sind.');
    }
  }

  function cacheElements() {
    const ids = [
      'screenshot-input', 'upload-zone', 'file-list', 'recognize-button',
      'progress-card', 'progress-title', 'progress-percent', 'progress-track', 'progress-bar', 'progress-detail',
      'result-card', 'result-count', 'result-summary', 'warning-box', 'event-list', 'add-event-button',
      'settings-card', 'calendar-name', 'location', 'reminder-minutes', 'include-source-note', 'prefer-detail-times', 'shift-code-map',
      'export-card', 'share-ics-button', 'download-ics-button',
      'raw-card', 'raw-results', 'offline-status', 'fatal-error', 'toast',
      'event-editor', 'event-editor-backdrop', 'event-editor-close', 'event-editor-heading',
      'editor-shift-token', 'editor-shift-code', 'editor-shift-hint', 'editor-event-title',
      'editor-event-date', 'editor-event-start', 'editor-event-end', 'editor-event-include',
      'editor-event-source', 'editor-save', 'editor-cancel', 'editor-delete'
    ];
    ids.forEach((id) => { elements[toCamelCase(id)] = document.getElementById(id); });
  }

  function toCamelCase(value) {
    return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  }

  function bindEvents() {
    elements.screenshotInput.addEventListener('change', (event) => setFiles(Array.from(event.target.files || [])));
    elements.recognizeButton.addEventListener('click', recognizeSchedule);
    elements.addEventButton.addEventListener('click', addManualEvent);
    elements.shareIcsButton.addEventListener('click', shareIcs);
    elements.downloadIcsButton.addEventListener('click', downloadIcs);
    elements.eventEditorBackdrop.addEventListener('click', closeEventEditor);
    elements.eventEditorClose.addEventListener('click', closeEventEditor);
    elements.editorCancel.addEventListener('click', closeEventEditor);
    elements.editorSave.addEventListener('click', saveEditedEvent);
    elements.editorDelete.addEventListener('click', deleteEditedEvent);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !elements.eventEditor.classList.contains('hidden')) closeEventEditor();
    });

    ['calendarName', 'location', 'reminderMinutes', 'includeSourceNote', 'preferDetailTimes', 'shiftCodeMap'].forEach((key) => {
      elements[key].addEventListener('change', saveSettings);
      elements[key].addEventListener('input', saveSettings);
    });

    elements.uploadZone.addEventListener('dragover', (event) => {
      event.preventDefault();
      elements.uploadZone.classList.add('dragging');
    });
    elements.uploadZone.addEventListener('dragleave', () => elements.uploadZone.classList.remove('dragging'));
    elements.uploadZone.addEventListener('drop', (event) => {
      event.preventDefault();
      elements.uploadZone.classList.remove('dragging');
      const files = Array.from(event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files : [])
        .filter((file) => file.type.startsWith('image/'));
      if (files.length) setFiles(files);
    });
  }

  function setFiles(files) {
    releaseFileUrls();
    state.files = files.filter((file) => file && file.type.startsWith('image/'));
    state.fileUrls = state.files.map((file) => URL.createObjectURL(file));
    elements.screenshotInput.value = '';
    renderFileList();
    elements.recognizeButton.disabled = !state.files.length || state.processing;
  }

  function releaseFileUrls() {
    state.fileUrls.forEach((url) => URL.revokeObjectURL(url));
    state.fileUrls = [];
  }

  function renderFileList() {
    elements.fileList.replaceChildren();
    state.files.forEach((file, index) => {
      const item = document.createElement('div');
      item.className = 'file-item';

      const image = document.createElement('img');
      image.src = state.fileUrls[index];
      image.alt = '';

      const text = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = file.name || `Screenshot ${index + 1}`;
      const metadata = document.createElement('small');
      metadata.textContent = formatBytes(file.size);
      text.append(name, metadata);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `${name.textContent} entfernen`);
      remove.addEventListener('click', () => {
        const nextFiles = state.files.filter((_, fileIndex) => fileIndex !== index);
        setFiles(nextFiles);
      });

      item.append(image, text, remove);
      elements.fileList.append(item);
    });
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return 'Bilddatei';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function recognizeSchedule() {
    if (!state.files.length || state.processing) return;
    if (!window.Tesseract || !window.ShiftParser) {
      showFatalError('Die OCR-Bibliothek ist nicht verfügbar. Bitte die Seite neu laden.');
      return;
    }

    state.processing = true;
    state.rawResults = [];
    state.parserWarnings = [];
    state.ignoredDaysOff = 0;
    state.mergeStats = { inputCount: 0, mergedCount: 0, fuzzyMergedCount: 0, normalizedCount: 0 };
    state.activeFileIndex = -1;
    elements.recognizeButton.disabled = true;
    elements.screenshotInput.disabled = true;
    elements.progressCard.classList.remove('hidden');
    elements.resultCard.classList.add('hidden');
    elements.settingsCard.classList.add('hidden');
    elements.exportCard.classList.add('hidden');
    elements.rawCard.classList.add('hidden');
    elements.fatalError.classList.add('hidden');
    updateProgress(0.01, 'OCR wird vorbereitet …', 'Das deutsche Sprachmodell und der OCR-Kern werden lokal geladen.');

    const allEvents = [];
    const shiftCodes = window.ShiftParser.parseShiftCodeMapping(elements.shiftCodeMap.value);

    try {
      state.worker = await createOcrWorker();
      await state.worker.setParameters({
        tessedit_pageseg_mode: (window.Tesseract.PSM && window.Tesseract.PSM.SPARSE_TEXT) || 11,
        preserve_interword_spaces: '1',
        user_defined_dpi: '300'
      });

      for (let index = 0; index < state.files.length; index += 1) {
        state.activeFileIndex = index;
        const file = state.files[index];
        updateProgress(index / state.files.length, `Screenshot ${index + 1} von ${state.files.length}`, 'Bild wird für die Texterkennung vorbereitet.');
        const canvas = await imageFileToCanvas(file);
        const result = await state.worker.recognize(canvas);
        const text = result && result.data ? result.data.text || '' : '';
        const confidence = result && result.data && Number.isFinite(result.data.confidence) ? result.data.confidence : null;
        const parsed = window.ShiftParser.parseScheduleText(text, {
          shiftCodes,
          sourceIndex: index,
          preferDetailTimes: elements.preferDetailTimes.checked
        });
        const windowsParsed = (looksLikeWindowsGridScreenshot(canvas) || !parsed.events.length)
          ? await extractWindowsGridEvents(canvas, state.worker, shiftCodes, index)
          : { events: [], warnings: [] };
        allEvents.push(...parsed.events, ...windowsParsed.events);
        state.parserWarnings.push(...parsed.warnings, ...(windowsParsed.warnings || []));
        state.ignoredDaysOff += Number(parsed.ignoredDaysOff) || 0;
        state.rawResults.push({
          filename: file.name || `Screenshot ${index + 1}`,
          text,
          confidence,
          datesFound: parsed.datesFound,
          eventsFound: parsed.events.length + windowsParsed.events.length,
          ignoredDaysOff: Number(parsed.ignoredDaysOff) || 0
        });
        canvas.width = 1;
        canvas.height = 1;
      }

      const merged = window.ShiftParser.mergeAndDedupeDetailed(allEvents);
      state.events = merged.events.map((event) => ({
        ...event,
        include: event.include !== false,
        includeTouched: false,
        includeRevision: 0
      }));
      state.mergeStats = merged.stats;
      renderResults();
      updateProgress(1, 'Erkennung abgeschlossen', `${state.events.length} Termin${state.events.length === 1 ? '' : 'e'} erkannt.`);
      showToast(state.events.length ? `${state.events.length} Termine erkannt – bitte kurz prüfen.` : 'Keine Dienste erkannt. OCR-Rohtext öffnen und Screenshot prüfen.');
    } catch (error) {
      console.error(error);
      showFatalError(`Die Erkennung ist fehlgeschlagen: ${friendlyError(error)}`);
      updateProgress(0, 'Erkennung fehlgeschlagen', 'Bitte Seite neu laden oder einen kleineren Screenshot verwenden.');
    } finally {
      if (state.worker) {
        try { await state.worker.terminate(); } catch (_) { /* ignore */ }
      }
      state.worker = null;
      state.processing = false;
      state.activeFileIndex = -1;
      elements.recognizeButton.disabled = !state.files.length;
      elements.screenshotInput.disabled = false;
    }
  }

  async function createOcrWorker() {
    const baseUrl = new URL('.', window.location.href);
    return window.Tesseract.createWorker('deu', window.Tesseract.OEM.LSTM_ONLY, {
      workerPath: new URL('worker.min.js', baseUrl).href,
      langPath: new URL('.', baseUrl).href,
      corePath: new URL('tesseract-core-lstm.wasm.js', baseUrl).href,
      workerBlobURL: false,
      gzip: true,
      logger: handleOcrLog,
      errorHandler: (error) => console.error('Tesseract worker:', error)
    });
  }

  function handleOcrLog(message) {
    if (!message) return;
    const progress = Number.isFinite(message.progress) ? message.progress : 0;
    const status = translateOcrStatus(message.status);
    if (state.activeFileIndex < 0 || !state.files.length) {
      updateProgress(Math.min(0.12, progress * 0.12), 'OCR wird vorbereitet …', status);
      return;
    }
    const overall = (state.activeFileIndex + Math.max(0, Math.min(1, progress))) / state.files.length;
    updateProgress(overall, `Screenshot ${state.activeFileIndex + 1} von ${state.files.length}`, status);
  }

  function translateOcrStatus(status) {
    const translations = {
      'loading tesseract core': 'OCR-Kern wird geladen …',
      'loaded tesseract core': 'OCR-Kern geladen.',
      'initializing tesseract': 'OCR wird initialisiert …',
      'initialized tesseract': 'OCR ist bereit.',
      'loading language traineddata': 'Deutsches Sprachmodell wird geladen …',
      'loaded language traineddata': 'Sprachmodell geladen.',
      'initializing api': 'Texterkennung wird eingerichtet …',
      'recognizing text': 'Datum und Uhrzeiten werden gelesen …'
    };
    return translations[status] || (status ? `${status} …` : 'Verarbeitung läuft …');
  }

  function updateProgress(value, title, detail) {
    const clamped = Math.max(0, Math.min(1, Number(value) || 0));
    const percent = Math.round(clamped * 100);
    elements.progressBar.style.width = `${percent}%`;
    elements.progressPercent.textContent = `${percent} %`;
    elements.progressTrack.setAttribute('aria-valuenow', String(percent));
    if (title) elements.progressTitle.textContent = title;
    if (detail) elements.progressDetail.textContent = detail;
  }

  function imageFileToCanvas(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        try {
          const maxWidth = 1600;
          const maxHeight = 5200;
          const scale = Math.min(1, maxWidth / image.naturalWidth, maxHeight / image.naturalHeight);
          const width = Math.max(1, Math.round(image.naturalWidth * scale));
          const height = Math.max(1, Math.round(image.naturalHeight * scale));
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, width, height);
          context.drawImage(image, 0, 0, width, height);
          URL.revokeObjectURL(url);
          resolve(canvas);
        } catch (error) {
          URL.revokeObjectURL(url);
          reject(error);
        }
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Bild konnte nicht geöffnet werden.'));
      };
      image.src = url;
    });
  }


  function cropCanvasRegion(sourceCanvas, x, y, width, height, options) {
    const settings = { scale: 1, grayscale: false, threshold: null, ...options };
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * settings.scale));
    canvas.height = Math.max(1, Math.round(height * settings.scale));
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(sourceCanvas, x, y, width, height, 0, 0, canvas.width, canvas.height);
    if (settings.grayscale || Number.isFinite(settings.threshold)) {
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const threshold = Number.isFinite(settings.threshold) ? Number(settings.threshold) : null;
      for (let index = 0; index < imageData.data.length; index += 4) {
        const gray = Math.round(imageData.data[index] * 0.299 + imageData.data[index + 1] * 0.587 + imageData.data[index + 2] * 0.114);
        const value = threshold === null ? gray : (gray >= threshold ? 255 : 0);
        imageData.data[index] = value;
        imageData.data[index + 1] = value;
        imageData.data[index + 2] = value;
      }
      context.putImageData(imageData, 0, 0);
    }
    return canvas;
  }

  async function recognizeCanvasRegion(worker, canvas, psm) {
    if (!worker) throw new Error('OCR-Worker nicht verfügbar.');
    if (Number.isFinite(psm)) {
      await worker.setParameters({ tessedit_pageseg_mode: psm });
    }
    return worker.recognize(canvas);
  }

  function looksLikeWindowsGridScreenshot(canvas) {
    if (!canvas) return false;
    return canvas.width >= 500 && canvas.height <= 220 && canvas.width / Math.max(1, canvas.height) >= 3.6;
  }

  function extractMonthYearFromText(text) {
    const value = String(text || '').toLowerCase();
    const months = {
      januar: 1, jan: 1,
      februar: 2, feb: 2,
      märz: 3, maerz: 3, marz: 3, mär: 3,
      april: 4, apr: 4,
      mai: 5,
      juni: 6, jun: 6,
      juli: 7, jul: 7,
      august: 8, aug: 8,
      september: 9, sept: 9, sep: 9,
      oktober: 10, okt: 10,
      november: 11, nov: 11,
      dezember: 12, dez: 12
    };
    let month = 0;
    for (const [name, number] of Object.entries(months)) {
      if (value.includes(name)) {
        month = number;
        break;
      }
    }
    const yearMatch = value.match(/20\d{2}/);
    if (!month || !yearMatch) return null;
    return { month, year: Number(yearMatch[0]) };
  }

  function wordText(word) {
    return String(word && (word.text || word.raw_text || word.symbol || '') || '').trim();
  }

  function wordBox(word) {
    const box = word && (word.bbox || word.boundingBox || word.box);
    if (box && Number.isFinite(box.x0) && Number.isFinite(box.y0) && Number.isFinite(box.x1) && Number.isFinite(box.y1)) {
      return { left: box.x0, top: box.y0, right: box.x1, bottom: box.y1 };
    }
    if (box && Number.isFinite(box.x) && Number.isFinite(box.y) && Number.isFinite(box.w) && Number.isFinite(box.h)) {
      return { left: box.x, top: box.y, right: box.x + box.w, bottom: box.y + box.h };
    }
    if (Number.isFinite(word.left) && Number.isFinite(word.top) && Number.isFinite(word.width) && Number.isFinite(word.height)) {
      return { left: word.left, top: word.top, right: word.left + word.width, bottom: word.top + word.height };
    }
    return null;
  }

  function uniqueDayWords(words, scaledHeaderHeight, headerScale) {
    const items = [];
    (words || []).forEach((word) => {
      const text = wordText(word);
      if (!/^\d{1,2}$/.test(text)) return;
      const value = Number(text);
      if (value < 1 || value > 31) return;
      const box = wordBox(word);
      if (!box) return;
      const midY = (box.top + box.bottom) / 2;
      if (midY < scaledHeaderHeight * 0.52) return;
      const centerX = ((box.left + box.right) / 2) / headerScale;
      const width = Math.max(1, (box.right - box.left) / headerScale);
      items.push({ day: value, centerX, width, top: box.top / headerScale });
    });
    items.sort((left, right) => left.centerX - right.centerX);
    const deduped = [];
    items.forEach((item) => {
      const previous = deduped[deduped.length - 1];
      if (previous && Math.abs(previous.centerX - item.centerX) < Math.max(previous.width, item.width, 10)) {
        if (item.top > previous.top) deduped[deduped.length - 1] = item;
        return;
      }
      deduped.push(item);
    });
    return deduped;
  }

  function darkContentRatio(canvas) {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
    let dark = 0;
    for (let index = 0; index < data.length; index += 4) {
      const gray = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
      if (gray < 205) dark += 1;
    }
    return dark / Math.max(1, width * height);
  }

  function normalizeGridToken(token) {
    let value = String(token || '').toUpperCase().replace(/[^A-Z0-9+]/g, '');
    const corrections = {
      R4: 'R+', RY: 'R+', RP: 'R+', RT: 'R+', R7: 'R+',
      FB: 'F6', F8: 'F6',
      ZI: 'Z1', ZL: 'Z1',
      SI: 'S2'
    };
    return corrections[value] || value;
  }

  function extractRelevantCodesFromOcrText(text) {
    const allowed = new Set(['F6', 'F4', 'Z1', 'S2', 'N2', 'R+']);
    const ignored = new Set(['R1', 'R2', 'RU', 'U', 'FR', 'LE', 'F1', 'F2', 'F3', 'F5', 'F7', 'F9', 'N1']);
    const rawTokens = String(text || '')
      .toUpperCase()
      .replace(/[^A-Z0-9+\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    const result = [];
    rawTokens.forEach((rawToken) => {
      const token = normalizeGridToken(rawToken);
      if (!token || ignored.has(token) || !allowed.has(token)) return;
      if (!result.includes(token)) result.push(token);
    });
    return result;
  }

  function formatIsoDate(year, month, day) {
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  function timeRangeForCode(code, shiftCodes) {
    const normalizedCode = window.ShiftParser && window.ShiftParser.shiftMetaForCode
      ? window.ShiftParser.shiftMetaForCode(code).code
      : code;
    const entries = Object.entries(shiftCodes || {});
    for (const [range, mappedCode] of entries) {
      const cleanedMapped = window.ShiftParser && window.ShiftParser.shiftMetaForCode
        ? window.ShiftParser.shiftMetaForCode(mappedCode).code
        : mappedCode;
      if (cleanedMapped !== normalizedCode) continue;
      const match = String(range).match(/^(\d{2}:\d{2})-(\d{2}:\d{2})$/);
      if (match) return { start: match[1], end: match[2] };
    }
    return null;
  }

  function addDaysToIsoDate(isoDate, days) {
    if (window.ShiftParser && window.ShiftParser.addDays) return window.ShiftParser.addDays(isoDate, days);
    const [year, month, day] = String(isoDate || '').split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + days));
    return formatIsoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }

  function eventFromGridCode(code, date, shiftCodes, sourceIndex, sourceLine) {
    const timeRange = timeRangeForCode(code, shiftCodes);
    if (!timeRange) return null;
    const meta = window.ShiftParser && window.ShiftParser.shiftMetaForCode
      ? window.ShiftParser.shiftMetaForCode(code)
      : { code, title: code || 'Dienst', color: '#64748b', textColor: '#fff', borderColor: '#475569', icsColor: 'gray' };
    const overnight = timeRange.end <= timeRange.start;
    return {
      id: '',
      date,
      endDate: overnight ? addDaysToIsoDate(date, 1) : date,
      start: timeRange.start,
      end: timeRange.end,
      templateStart: timeRange.start,
      templateEnd: timeRange.end,
      originalTemplateStart: '',
      originalTemplateEnd: '',
      timeNormalized: false,
      normalizationDeltaMinutes: 0,
      code: meta.code || code,
      title: meta.title || code || 'Dienst',
      titleEdited: false,
      color: meta.color,
      textColor: meta.textColor,
      borderColor: meta.borderColor,
      icsColor: meta.icsColor,
      note: '',
      segments: [],
      usedDetailTimes: false,
      sourceLine: sourceLine || '',
      sourceIndex,
      sourceIndices: [sourceIndex],
      weekdayMismatch: false,
      needsReview: false,
      extractionMode: 'windows-grid',
      include: true
    };
  }

  async function extractWindowsGridEvents(canvas, worker, shiftCodes, sourceIndex) {
    if (!looksLikeWindowsGridScreenshot(canvas)) return { events: [], warnings: [] };
    const warnings = [];
    const headerHeight = Math.max(42, Math.min(canvas.height - 18, Math.round(canvas.height * 0.58)));
    const headerScale = 3;
    const headerCanvas = cropCanvasRegion(canvas, 0, 0, canvas.width, headerHeight, { scale: headerScale, grayscale: true, threshold: 190 });
    const headerResult = await recognizeCanvasRegion(worker, headerCanvas, (window.Tesseract.PSM && window.Tesseract.PSM.SINGLE_BLOCK) || 6);
    const monthYear = extractMonthYearFromText(headerResult && headerResult.data ? headerResult.data.text || '' : '');
    const dayWords = uniqueDayWords(headerResult && headerResult.data ? headerResult.data.words || [] : [], headerCanvas.height, headerScale);
    if (!monthYear || dayWords.length < 5) {
      return { events: [], warnings };
    }

    const xValues = dayWords.map((item) => item.centerX);
    const spacings = xValues.slice(1).map((value, index) => value - xValues[index]).filter((value) => value > 4);
    const medianSpacing = spacings.length
      ? spacings.slice().sort((left, right) => left - right)[Math.floor(spacings.length / 2)]
      : Math.max(18, canvas.width / Math.max(dayWords.length, 1));

    const bounds = dayWords.map((item, index) => {
      const previous = dayWords[index - 1];
      const next = dayWords[index + 1];
      const left = index === 0 ? Math.max(0, item.centerX - medianSpacing / 2) : (previous.centerX + item.centerX) / 2;
      const right = index === dayWords.length - 1 ? Math.min(canvas.width, item.centerX + medianSpacing / 2) : (item.centerX + next.centerX) / 2;
      return { day: item.day, left: Math.max(0, Math.floor(left)), right: Math.min(canvas.width, Math.ceil(right)) };
    });

    const tileTop = Math.max(0, Math.round(canvas.height * 0.52));
    const tileHeight = canvas.height - tileTop;
    const events = [];
    for (const cell of bounds) {
      if (cell.right - cell.left < 10) continue;
      const cellCanvas = cropCanvasRegion(canvas, cell.left, tileTop, cell.right - cell.left, tileHeight, { scale: 6, grayscale: true, threshold: 180 });
      if (darkContentRatio(cellCanvas) < 0.03) continue;
      let recognizedText = '';
      try {
        const cellResult = await recognizeCanvasRegion(worker, cellCanvas, (window.Tesseract.PSM && window.Tesseract.PSM.SPARSE_TEXT) || 11);
        recognizedText = cellResult && cellResult.data ? cellResult.data.text || '' : '';
      } catch (_) {
        recognizedText = '';
      }
      let codes = extractRelevantCodesFromOcrText(recognizedText);
      if (!codes.length) {
        const halfHeight = Math.floor(cellCanvas.height / 2);
        const upperCanvas = cropCanvasRegion(cellCanvas, 0, 0, cellCanvas.width, halfHeight, { scale: 1, grayscale: true, threshold: 180 });
        const lowerCanvas = cropCanvasRegion(cellCanvas, 0, halfHeight, cellCanvas.width, cellCanvas.height - halfHeight, { scale: 1, grayscale: true, threshold: 180 });
        const [upperResult, lowerResult] = await Promise.all([
          recognizeCanvasRegion(worker, upperCanvas, (window.Tesseract.PSM && window.Tesseract.PSM.SINGLE_BLOCK) || 6).catch(() => null),
          recognizeCanvasRegion(worker, lowerCanvas, (window.Tesseract.PSM && window.Tesseract.PSM.SINGLE_BLOCK) || 6).catch(() => null)
        ]);
        codes = extractRelevantCodesFromOcrText(`${upperResult && upperResult.data ? upperResult.data.text || '' : ''} ${lowerResult && lowerResult.data ? lowerResult.data.text || '' : ''}`);
      }
      if (!codes.length) continue;
      const date = formatIsoDate(monthYear.year, monthYear.month, cell.day);
      codes.forEach((code) => {
        const event = eventFromGridCode(code, date, shiftCodes, sourceIndex, `Windows-Kachel ${cell.day}: ${code}`);
        if (event) events.push(event);
      });
    }

    return { events, warnings };
  }

  function renderResults() {
    elements.resultCard.classList.remove('hidden');
    elements.settingsCard.classList.remove('hidden');
    elements.exportCard.classList.remove('hidden');
    elements.rawCard.classList.remove('hidden');
    renderEvents();
    renderRawResults();
  }

  function renderEvents() {
    elements.eventList.replaceChildren();
    state.events.forEach((event) => elements.eventList.append(createEventCard(event)));
    updateResultSummary();
  }

  function setEventIncluded(event, included) {
    state.selectionRevision += 1;
    event.include = Boolean(included);
    event.includeTouched = true;
    event.includeRevision = state.selectionRevision;
  }

  function createEventCard(event) {
    const card = document.createElement('article');
    card.className = 'event-card';
    card.dataset.id = event.id;
    if (event.include === false) card.classList.add('excluded');
    if (event.needsReview) card.classList.add('review');

    const includeLabel = document.createElement('label');
    includeLabel.className = 'include-toggle';
    const include = document.createElement('input');
    include.type = 'checkbox';
    include.checked = event.include !== false;
    include.setAttribute('aria-label', `${event.title || event.code || 'Dienst'} in den Export aufnehmen`);
    const applyIncludeChoice = () => {
      setEventIncluded(event, include.checked);
      card.classList.toggle('excluded', !include.checked);
      updateResultSummary();
    };
    // `input` reacts immediately on iOS; `change` remains as a fallback for other browsers.
    include.addEventListener('input', applyIncludeChoice);
    include.addEventListener('change', applyIncludeChoice);
    includeLabel.addEventListener('click', (clickEvent) => clickEvent.stopPropagation());
    includeLabel.append(include);

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'event-open';
    open.setAttribute('aria-label', `${event.title || event.code || 'Dienst'} bearbeiten`);
    open.addEventListener('click', () => openEventEditor(event.id));

    const token = document.createElement('span');
    token.className = 'shift-token';
    applyShiftAppearance(token, event);
    token.textContent = event.code || '?';

    const copy = document.createElement('span');
    copy.className = 'event-copy';
    const title = document.createElement('strong');
    title.textContent = event.title || friendlyTitle(event.code);
    const meta = document.createElement('span');
    meta.className = 'event-meta';
    const overnightSuffix = isOvernightEvent(event) ? ' · Ende Folgetag' : '';
    meta.textContent = `${formatDateCompact(event.date)} · ${event.start}–${event.end}${overnightSuffix}`;
    copy.append(title, meta);

    const flags = document.createElement('span');
    flags.className = 'event-flags';
    if (event.needsReview) flags.append(makeCompactFlag('Prüfen', 'review'));
    else if (event.timeNormalized) flags.append(makeCompactFlag('Zeit korrigiert', 'normalized'));
    else if (event.fuzzyMerged) flags.append(makeCompactFlag('Doppelt erkannt', 'merged'));
    if (flags.childElementCount) copy.append(flags);

    const chevron = document.createElement('span');
    chevron.className = 'event-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '›';

    open.append(token, copy, chevron);
    card.append(includeLabel, open);
    return card;
  }

  function makeCompactFlag(text, className) {
    const flag = document.createElement('span');
    flag.className = `event-flag${className ? ` ${className}` : ''}`;
    flag.textContent = text;
    return flag;
  }

  function friendlyTitle(code) {
    if (window.ShiftParser && window.ShiftParser.titleForCode) {
      return window.ShiftParser.titleForCode(code, 'Dienst');
    }
    return code || 'Dienst';
  }

  function appearanceForEvent(event) {
    const fallback = window.ShiftParser && window.ShiftParser.shiftMetaForCode
      ? window.ShiftParser.shiftMetaForCode(event.code)
      : { color: '#64748b', textColor: '#ffffff', borderColor: '#475569', icsColor: 'gray' };
    const appearance = {
      color: event.color || fallback.color,
      textColor: event.textColor || fallback.textColor,
      borderColor: event.borderColor || fallback.borderColor,
      icsColor: event.icsColor || fallback.icsColor
    };
    event.color = appearance.color;
    event.textColor = appearance.textColor;
    event.borderColor = appearance.borderColor;
    event.icsColor = appearance.icsColor;
    return appearance;
  }

  function applyShiftAppearance(element, event) {
    const appearance = appearanceForEvent(event);
    element.style.setProperty('--shift-color', appearance.color);
    element.style.setProperty('--shift-text', appearance.textColor);
    element.style.setProperty('--shift-border', appearance.borderColor);
  }

  function effectiveEndDate(event) {
    if (window.ShiftParser && window.ShiftParser.resolvedEventEndDate) {
      return window.ShiftParser.resolvedEventEndDate(event.date, event.start, event.end, event.endDate);
    }
    const validEndDate = event.endDate && /^\d{4}-\d{2}-\d{2}$/.test(event.endDate);
    if (event.end <= event.start && window.ShiftParser && window.ShiftParser.addDays) {
      return validEndDate && event.endDate > event.date
        ? event.endDate
        : window.ShiftParser.addDays(event.date, 1);
    }
    return validEndDate && event.endDate >= event.date ? event.endDate : event.date;
  }

  function isOvernightEvent(event) {
    return effectiveEndDate(event) > event.date || event.end <= event.start;
  }

  function clearDerivedTimes(event) {
    event.segments = [];
    event.usedDetailTimes = false;
    event.manualTimeEdit = true;
    event.timeNormalized = false;
    event.originalTemplateStart = '';
    event.originalTemplateEnd = '';
    event.normalizationDeltaMinutes = 0;
    if (!event.code) {
      event.templateStart = event.start;
      event.templateEnd = event.end;
    }
    event.endDate = event.end <= event.start && window.ShiftParser && window.ShiftParser.addDays
      ? window.ShiftParser.addDays(event.date, 1)
      : event.date;
  }

  function formatSegment(segment, eventDate) {
    const startDate = segment.startDate || eventDate;
    const endDate = segment.endDate || startDate;
    if (startDate === eventDate && endDate === eventDate) return `${segment.start}–${segment.end}`;
    const shortDate = (value) => String(value || '').slice(8, 10) + '.' + String(value || '').slice(5, 7) + '.';
    return `${shortDate(startDate)} ${segment.start}–${shortDate(endDate)} ${segment.end}`;
  }

  function formatDateCompact(isoDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate || ''))) return isoDate || 'Datum prüfen';
    const date = new Date(`${isoDate}T12:00:00Z`);
    return new Intl.DateTimeFormat('de-DE', {
      weekday: 'short', day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'UTC'
    }).format(date);
  }

  function eventById(id) {
    return state.events.find((event) => event.id === id) || null;
  }

  function openEventEditor(eventId) {
    const event = eventById(eventId);
    if (!event) return;
    state.editingEventId = event.id;
    elements.eventEditorHeading.textContent = event.title || friendlyTitle(event.code);
    elements.editorShiftCode.textContent = event.code || 'Unbekannter Code';
    elements.editorShiftHint.textContent = `${formatDateGerman(event.date)} · ${event.start}–${event.end}${isOvernightEvent(event) ? ' (Folgetag)' : ''}`;
    elements.editorEventTitle.value = event.title || friendlyTitle(event.code);
    elements.editorEventDate.value = event.date || '';
    elements.editorEventStart.value = event.start || '';
    elements.editorEventEnd.value = event.end || '';
    elements.editorEventInclude.checked = event.include !== false;
    elements.editorShiftToken.textContent = event.code || '?';
    applyShiftAppearance(elements.editorShiftToken, event);
    elements.editorEventSource.textContent = editorSourceText(event);
    elements.eventEditor.classList.remove('hidden');
    elements.eventEditor.setAttribute('aria-hidden', 'false');
    document.body.classList.add('editor-open');
  }

  function editorSourceText(event) {
    const details = [];
    if (event.timeNormalized && event.originalTemplateStart && event.originalTemplateEnd) {
      details.push(`OCR-Zeit ${event.originalTemplateStart}–${event.originalTemplateEnd} auf ${event.templateStart}–${event.templateEnd} korrigiert`);
    }
    if (event.segments && event.segments.length) {
      details.push(`Arbeitsblöcke: ${event.segments.map((segment) => formatSegment(segment, event.date)).join(', ')}`);
    }
    if (event.fuzzyMerged || Number(event.mergedCopies) > 1) details.push('Ähnliche Doppel-Erkennung wurde zusammengeführt');
    if (event.note) details.push(event.note);
    if (event.sourceLine) details.push(`Erkannt: ${event.sourceLine}`);
    return details.join(' · ') || 'Manuell angelegter Termin';
  }

  function closeEventEditor() {
    state.editingEventId = '';
    elements.eventEditor.classList.add('hidden');
    elements.eventEditor.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('editor-open');
  }

  function saveEditedEvent() {
    const event = eventById(state.editingEventId);
    if (!event) return closeEventEditor();
    const title = elements.editorEventTitle.value.trim();
    const date = elements.editorEventDate.value;
    const start = elements.editorEventStart.value;
    const end = elements.editorEventEnd.value;
    if (!title) return showToast('Bitte einen Titel eintragen.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return showToast('Bitte ein gültiges Datum wählen.');
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return showToast('Bitte gültige Uhrzeiten wählen.');

    const timeChanged = event.date !== date || event.start !== start || event.end !== end;
    event.title = title;
    event.titleEdited = title !== friendlyTitle(event.code);
    event.date = date;
    event.start = start;
    event.end = end;
    const includeChanged = (event.include !== false) !== elements.editorEventInclude.checked;
    if (includeChanged) setEventIncluded(event, elements.editorEventInclude.checked);
    if (timeChanged) clearDerivedTimes(event);
    event.needsReview = false;
    closeEventEditor();
    const mergedCount = applyDedupeToState();
    renderEvents();
    showToast(mergedCount ? 'Ähnliche Doppeltermine wurden zusammengeführt.' : 'Änderung übernommen.');
  }

  function deleteEditedEvent() {
    const event = eventById(state.editingEventId);
    if (!event) return closeEventEditor();
    if (!window.confirm(`„${event.title || event.code || 'Dienst'}“ wirklich löschen?`)) return;
    state.events = state.events.filter((candidate) => candidate !== event);
    closeEventEditor();
    renderEvents();
    showToast('Termin gelöscht.');
  }

  function applyDedupeToState() {
    if (!window.ShiftParser || !window.ShiftParser.mergeAndDedupeDetailed) return 0;
    const before = state.events.length;
    const merged = window.ShiftParser.mergeAndDedupeDetailed(state.events);
    state.events = merged.events;
    state.mergeStats = {
      inputCount: Math.max(state.mergeStats.inputCount || 0, merged.stats.inputCount),
      mergedCount: (state.mergeStats.mergedCount || 0) + merged.stats.mergedCount,
      fuzzyMergedCount: (state.mergeStats.fuzzyMergedCount || 0) + merged.stats.fuzzyMergedCount,
      normalizedCount: merged.stats.normalizedCount
    };
    return Math.max(0, before - state.events.length);
  }

  function updateResultSummary() {
    const selected = state.events.filter((event) => event.include !== false);
    const overnight = selected.filter(isOvernightEvent).length;
    const review = selected.filter((event) => event.needsReview).length;
    elements.resultCount.textContent = String(state.events.length);
    elements.resultSummary.replaceChildren();
    elements.resultSummary.append(makeSummaryChip(`${selected.length} für Export`, 'good'));
    if (overnight) elements.resultSummary.append(makeSummaryChip(`${overnight} über Nacht`));
    if (review) elements.resultSummary.append(makeSummaryChip(`${review} prüfen`, 'warn'));
    if (state.ignoredDaysOff) elements.resultSummary.append(makeSummaryChip(`${state.ignoredDaysOff} Frei-Wunsch übersprungen`));
    if (state.mergeStats.mergedCount) {
      elements.resultSummary.append(makeSummaryChip(`${state.mergeStats.mergedCount} Doppel-Erkennung${state.mergeStats.mergedCount === 1 ? '' : 'en'} vereint`));
    }
    if (state.mergeStats.normalizedCount) {
      elements.resultSummary.append(makeSummaryChip(`${state.mergeStats.normalizedCount} OCR-Zeit${state.mergeStats.normalizedCount === 1 ? '' : 'en'} korrigiert`));
    }

    const warnings = [...state.parserWarnings];
    if (!state.events.length) warnings.push('Es wurde kein Dienst erkannt. Prüfe den OCR-Rohtext oder verwende einen vollständigen, scharfen Screenshot.');
    if (review) warnings.push('Mindestens ein Termin hat keinen bekannten Schichtcode oder enthält unsichere Daten. Bitte vor dem Export korrigieren.');
    if (warnings.length) {
      elements.warningBox.textContent = Array.from(new Set(warnings)).join(' ');
      elements.warningBox.classList.remove('hidden');
    } else {
      elements.warningBox.classList.add('hidden');
      elements.warningBox.textContent = '';
    }
    elements.shareIcsButton.disabled = !selected.length;
    elements.downloadIcsButton.disabled = !selected.length;
  }

  function makeSummaryChip(text, className) {
    const chip = document.createElement('span');
    chip.className = `summary-chip${className ? ` ${className}` : ''}`;
    chip.textContent = text;
    return chip;
  }

  function renderRawResults() {
    elements.rawResults.replaceChildren();
    state.rawResults.forEach((result) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'raw-result';
      const heading = document.createElement('strong');
      const confidence = result.confidence === null ? '' : ` · OCR ${Math.round(result.confidence)} %`;
      heading.textContent = `${result.filename} · ${result.eventsFound} Termine${confidence}`;
      const metadata = document.createElement('p');
      metadata.className = 'muted small';
      metadata.textContent = `${result.datesFound} Datumszeilen erkannt${result.ignoredDaysOff ? ` · ${result.ignoredDaysOff} Frei-Wunsch übersprungen` : ''}`;
      const pre = document.createElement('pre');
      pre.textContent = result.text || '(kein Text erkannt)';
      wrapper.append(heading, metadata, pre);
      elements.rawResults.append(wrapper);
    });
  }

  function addManualEvent() {
    const referenceDate = state.events.length ? state.events[state.events.length - 1].date : todayIso();
    const appearance = window.ShiftParser && window.ShiftParser.shiftMetaForCode
      ? window.ShiftParser.shiftMetaForCode('')
      : { color: '#64748b', textColor: '#ffffff', borderColor: '#475569', icsColor: 'gray' };
    const event = {
      id: `manual-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now()}`,
      date: referenceDate,
      start: '08:00',
      end: '16:00',
      endDate: referenceDate,
      templateStart: '08:00',
      templateEnd: '16:00',
      originalTemplateStart: '',
      originalTemplateEnd: '',
      timeNormalized: false,
      normalizationDeltaMinutes: 0,
      code: '',
      title: 'Dienst',
      titleEdited: true,
      color: appearance.color,
      textColor: appearance.textColor,
      borderColor: appearance.borderColor,
      icsColor: appearance.icsColor,
      note: '',
      segments: [],
      usedDetailTimes: false,
      sourceLine: 'Manuell ergänzt',
      sourceIndex: -1,
      sourceIndices: [-1],
      mergedCopies: 1,
      weekdayMismatch: false,
      needsReview: false,
      extractionMode: 'manual',
      include: true,
      includeTouched: false,
      includeRevision: 0
    };
    state.events.push(event);
    renderEvents();
    requestAnimationFrame(() => openEventEditor(event.id));
  }

  function todayIso() {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  }

  function formatDateGerman(isoDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate || ''))) return isoDate || 'Ungültiges Datum';
    const date = new Date(`${isoDate}T12:00:00Z`);
    return new Intl.DateTimeFormat('de-DE', {
      weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC'
    }).format(date);
  }

  function validateSelectedEvents() {
    // Wichtig: zuerst die Benutzerauswahl anwenden, erst danach nur die ausgewählten
    // Einträge für den Export zusammenführen. So kann ein abgewählter Dienst niemals
    // durch eine ähnliche Doppel-Erkennung wieder aktiviert werden.
    const chosen = state.events.filter((event) => event.include !== false);
    if (!chosen.length) throw new Error('Bitte mindestens einen Termin für den Export auswählen.');

    const selected = window.ShiftParser && window.ShiftParser.mergeAndDedupeDetailed
      ? window.ShiftParser.mergeAndDedupeDetailed(chosen).events
      : chosen.map((event) => ({ ...event }));

    for (const event of selected) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(event.date || '')) throw new Error('Mindestens ein Datum ist ungültig.');
      if (!/^\d{2}:\d{2}$/.test(event.start || '') || !/^\d{2}:\d{2}$/.test(event.end || '')) throw new Error('Mindestens eine Uhrzeit ist ungültig.');
      event.include = true;
      event.endDate = effectiveEndDate(event);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(event.endDate || '')) throw new Error('Mindestens ein Enddatum ist ungültig.');
      if (!String(event.title || '').trim()) throw new Error('Jeder Termin benötigt einen Titel.');
    }
    return selected;
  }

  function createIcsFile() {
    const selected = validateSelectedEvents();
    const settings = currentSettings();
    const content = window.IcsBuilder.buildIcs(selected, settings);
    const filename = window.IcsBuilder.filenameForEvents(selected);
    try {
      return new File([content], filename, { type: 'text/calendar;charset=utf-8' });
    } catch (_) {
      const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' });
      blob.name = filename;
      return blob;
    }
  }

  async function shareIcs() {
    try {
      const file = createIcsFile();
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          title: 'Dienstplan',
          text: 'Polypoint-Dienstplan als Kalenderdatei',
          files: [file]
        });
        showToast('ICS-Datei wurde an das Teilen-Menü übergeben.');
      } else {
        triggerDownload(file, file.name || 'Dienstplan.ics');
        showToast('ICS-Datei wurde erstellt. Öffne sie anschließend mit Kalender.');
      }
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      showToast(friendlyError(error));
    }
  }

  function downloadIcs() {
    try {
      const file = createIcsFile();
      triggerDownload(file, file.name || 'Dienstplan.ics');
      showToast('ICS-Datei wurde erstellt.');
    } catch (error) {
      showToast(friendlyError(error));
    }
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function currentSettings() {
    return {
      calendarName: elements.calendarName.value.trim() || 'Dienstplan',
      location: elements.location.value.trim(),
      reminderMinutes: Number(elements.reminderMinutes.value) || 0,
      includeSourceNote: elements.includeSourceNote.checked,
      timeZone: 'Europe/Berlin'
    };
  }

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      if (typeof saved.calendarName === 'string') elements.calendarName.value = saved.calendarName;
      if (typeof saved.location === 'string') elements.location.value = saved.location;
      if (saved.reminderMinutes !== undefined) elements.reminderMinutes.value = String(saved.reminderMinutes);
      if (typeof saved.includeSourceNote === 'boolean') elements.includeSourceNote.checked = saved.includeSourceNote;
      if (typeof saved.preferDetailTimes === 'boolean') elements.preferDetailTimes.checked = saved.preferDetailTimes;
      if (typeof saved.shiftCodeMap === 'string' && saved.shiftCodeMap.trim()) elements.shiftCodeMap.value = saved.shiftCodeMap;
    } catch (_) { /* ignore invalid local storage */ }
  }

  function saveSettings() {
    const value = {
      calendarName: elements.calendarName.value,
      location: elements.location.value,
      reminderMinutes: Number(elements.reminderMinutes.value) || 0,
      includeSourceNote: elements.includeSourceNote.checked,
      preferDetailTimes: elements.preferDetailTimes.checked,
      shiftCodeMap: elements.shiftCodeMap.value
    };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(value)); } catch (_) { /* private mode */ }
  }

  async function registerServiceWorker() {
    const secureOrigin = window.location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(window.location.hostname);
    if (!('serviceWorker' in navigator) || !secureOrigin) {
      elements.offlineStatus.textContent = 'OCR ist lokal nutzbar; für Installation und Offline-Start einmal über HTTPS öffnen.';
      return;
    }
    try {
      const registration = await navigator.serviceWorker.register('./service-worker.js', { updateViaCache: 'none' });
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            showToast('Eine neue Version ist bereit. App einmal schließen und erneut öffnen.');
          }
        });
      });
      registration.update().catch(() => {});
      await navigator.serviceWorker.ready;
      elements.offlineStatus.textContent = `Offline-Paket v${APP_VERSION} ist bereit.`;
      elements.offlineStatus.classList.add('ready');
    } catch (error) {
      console.warn('Service worker:', error);
      elements.offlineStatus.textContent = 'Online nutzbar; Offline-Paket konnte nicht gespeichert werden.';
    }
  }

  function showFatalError(message) {
    elements.fatalError.textContent = message;
    elements.fatalError.classList.remove('hidden');
  }

  function friendlyError(error) {
    if (!error) return 'Unbekannter Fehler.';
    const message = typeof error === 'string' ? error : error.message;
    if (!message) return 'Unbekannter Fehler.';
    if (/memory|allocate|out of bounds/i.test(message)) return 'Der Screenshot ist zu groß für den verfügbaren Speicher. Bitte einen kürzeren Ausschnitt verwenden.';
    if (/fetch|network|load/i.test(message)) return 'Eine mitgelieferte OCR-Datei konnte nicht geladen werden. Bitte die App einmal online vollständig neu öffnen.';
    return message;
  }

  function showToast(message) {
    if (toastTimer) clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.remove('hidden');
    toastTimer = setTimeout(() => elements.toast.classList.add('hidden'), 4200);
  }
})();
