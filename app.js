(function () {
  'use strict';

  const APP_VERSION = '1.3.3';
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
      'result-card', 'result-count', 'result-summary', 'drop-unclear-button', 'warning-box', 'event-list', 'add-event-button',
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
    elements.dropUnclearButton.addEventListener('click', dropUnclearEvents);
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
        await state.worker.setParameters({
          tessedit_pageseg_mode: (window.Tesseract.PSM && window.Tesseract.PSM.SPARSE_TEXT) || 11,
          tessedit_char_whitelist: ''
        });
        const result = await state.worker.recognize(canvas, {}, { text: true, tsv: true, blocks: true });
        const text = result && result.data ? result.data.text || '' : '';
        const confidence = result && result.data && Number.isFinite(result.data.confidence) ? result.data.confidence : null;
        const parsed = window.ShiftParser.parseScheduleText(text, {
          shiftCodes,
          sourceIndex: index,
          preferDetailTimes: elements.preferDetailTimes.checked
        });
        const windowsParsed = (looksLikeWindowsGridScreenshot(canvas, text, result && result.data) || !parsed.events.length)
          ? await extractWindowsGridEvents(canvas, state.worker, shiftCodes, index, result)
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
      applyRealityChecksToState();
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
          const landscapeGrid = image.naturalWidth / Math.max(1, image.naturalHeight) >= 2.4;
          const maxWidth = landscapeGrid ? 2400 : 1600;
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

  function median(values) {
    const sorted = (values || []).filter(Number.isFinite).slice().sort((left, right) => left - right);
    if (!sorted.length) return NaN;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  function looksLikeWindowsGridScreenshot(canvas, ocrText, ocrData) {
    if (!canvas || canvas.width < 450) return false;
    const monthYear = extractMonthYearFromText(ocrText);
    if (!monthYear) return false;
    const numericWords = wordsFromOcrData(ocrData).filter((word) => {
      const token = wordText(word).replace(/[Oo]/g, '0');
      return /^\d{1,2}$/.test(token) && Number(token) >= 1 && Number(token) <= 31;
    });
    return numericWords.length >= 7 || /\bSaldo\b/i.test(String(ocrText || ''));
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
    if (Number.isFinite(word && word.left) && Number.isFinite(word && word.top) && Number.isFinite(word && word.width) && Number.isFinite(word && word.height)) {
      return { left: word.left, top: word.top, right: word.left + word.width, bottom: word.top + word.height };
    }
    return null;
  }


  function parseOcrTsvWords(tsv) {
    const lines = String(tsv || '').split(/\r?\n/);
    if (lines.length < 2) return [];
    const words = [];
    for (let index = 1; index < lines.length; index += 1) {
      if (!lines[index]) continue;
      const fields = lines[index].split('\t');
      if (fields.length < 12 || Number(fields[0]) !== 5) continue;
      const left = Number(fields[6]);
      const top = Number(fields[7]);
      const width = Number(fields[8]);
      const height = Number(fields[9]);
      const confidence = Number(fields[10]);
      const value = fields.slice(11).join('\t').trim();
      if (!value || ![left, top, width, height].every(Number.isFinite)) continue;
      words.push({
        text: value,
        confidence: Number.isFinite(confidence) ? confidence : 0,
        bbox: { x0: left, y0: top, x1: left + width, y1: top + height }
      });
    }
    return words;
  }

  function flattenOcrBlockWords(blocks) {
    const words = [];
    const visit = (value) => {
      if (!value) return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (typeof value !== 'object') return;
      if (typeof value.text === 'string' && value.bbox && !value.paragraphs && !value.lines && !value.words && !value.symbols) {
        words.push(value);
        return;
      }
      ['paragraphs', 'lines', 'words'].forEach((key) => {
        if (value[key]) visit(value[key]);
      });
    };
    visit(blocks);
    return words;
  }

  function wordsFromOcrData(data) {
    if (data && Array.isArray(data.words) && data.words.length) return data.words;
    const tsvWords = parseOcrTsvWords(data && data.tsv);
    if (tsvWords.length) return tsvWords;
    return flattenOcrBlockWords(data && data.blocks);
  }

  function clusterByRow(items) {
    const sorted = items.slice().sort((left, right) => left.centerY - right.centerY);
    const typicalHeight = median(sorted.map((item) => item.height)) || 12;
    const tolerance = Math.max(7, typicalHeight * 1.15);
    const clusters = [];
    sorted.forEach((item) => {
      let bestCluster = null;
      let bestDistance = Infinity;
      clusters.forEach((cluster) => {
        const distance = Math.abs(item.centerY - cluster.meanY);
        if (distance <= tolerance && distance < bestDistance) {
          bestCluster = cluster;
          bestDistance = distance;
        }
      });
      if (!bestCluster) {
        bestCluster = { items: [], meanY: item.centerY };
        clusters.push(bestCluster);
      }
      bestCluster.items.push(item);
      bestCluster.meanY = bestCluster.items.reduce((sum, candidate) => sum + candidate.centerY, 0) / bestCluster.items.length;
    });
    return clusters;
  }

  function linearRegression(points, xKey, yKey) {
    const usable = (points || []).filter((point) => Number.isFinite(point[xKey]) && Number.isFinite(point[yKey]));
    if (!usable.length) return { slope: 0, intercept: 0 };
    if (usable.length === 1) return { slope: 0, intercept: usable[0][yKey] };
    const meanX = usable.reduce((sum, point) => sum + point[xKey], 0) / usable.length;
    const meanY = usable.reduce((sum, point) => sum + point[yKey], 0) / usable.length;
    let numerator = 0;
    let denominator = 0;
    usable.forEach((point) => {
      const dx = point[xKey] - meanX;
      numerator += dx * (point[yKey] - meanY);
      denominator += dx * dx;
    });
    const slope = denominator ? numerator / denominator : 0;
    return { slope, intercept: meanY - slope * meanX };
  }

  function findDayRowModel(words, monthYear, canvas) {
    const candidates = [];
    (words || []).forEach((word) => {
      const raw = wordText(word).replace(/[Oo]/g, '0').replace(/[^0-9]/g, '');
      if (!/^\d{1,2}$/.test(raw)) return;
      const day = Number(raw);
      if (day < 1 || day > 31) return;
      const box = wordBox(word);
      if (!box) return;
      const width = Math.max(1, box.right - box.left);
      const height = Math.max(1, box.bottom - box.top);
      candidates.push({
        day,
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width,
        height,
        centerX: (box.left + box.right) / 2,
        centerY: (box.top + box.bottom) / 2,
        confidence: Number(word.confidence || word.conf || 0)
      });
    });
    if (candidates.length < 7) return null;

    const rowClusters = clusterByRow(candidates)
      .map((cluster) => {
        const sorted = cluster.items.slice().sort((left, right) => left.centerX - right.centerX);
        const deduped = [];
        sorted.forEach((item) => {
          const previous = deduped[deduped.length - 1];
          if (previous && Math.abs(previous.centerX - item.centerX) < Math.max(8, Math.min(previous.width, item.width))) {
            if (item.confidence > previous.confidence) deduped[deduped.length - 1] = item;
          } else {
            deduped.push(item);
          }
        });
        const span = deduped.length > 1 ? deduped.at(-1).centerX - deduped[0].centerX : 0;
        return {
          items: deduped,
          span,
          score: deduped.length * 100 + (span / Math.max(1, canvas.width)) * 80
        };
      })
      .filter((cluster) => cluster.items.length >= 7 && cluster.span >= canvas.width * 0.25)
      .sort((left, right) => right.score - left.score);
    if (!rowClusters.length) return null;

    const row = rowClusters[0].items;
    const sortedX = row.map((item) => item.centerX).sort((left, right) => left - right);
    const gaps = sortedX.slice(1).map((value, index) => value - sortedX[index])
      .filter((gap) => gap >= 8 && gap <= canvas.width / 4)
      .sort((left, right) => left - right);
    if (!gaps.length) return null;
    const lowerGapCount = Math.max(1, Math.ceil(gaps.length * 0.65));
    let spacing = median(gaps.slice(0, lowerGapCount));
    if (!Number.isFinite(spacing) || spacing < 12 || spacing > 120) return null;

    const intercepts = row.map((item) => item.centerX - (item.day - 1) * spacing).sort((left, right) => left - right);
    const windowWidth = spacing * 0.55;
    let densest = [];
    for (let index = 0; index < intercepts.length; index += 1) {
      const window = intercepts.filter((value) => value >= intercepts[index] && value <= intercepts[index] + windowWidth);
      if (window.length > densest.length) densest = window;
    }
    let intercept = median(densest.length ? densest : intercepts);
    let inliers = row.filter((item) => Math.abs(item.centerX - (intercept + (item.day - 1) * spacing)) <= spacing * 0.48);
    if (inliers.length >= 5) {
      const fit = linearRegression(inliers.map((item) => ({ dayIndex: item.day - 1, x: item.centerX })), 'dayIndex', 'x');
      if (fit.slope >= 12 && fit.slope <= 120) {
        spacing = fit.slope;
        intercept = fit.intercept;
      }
      inliers = row.filter((item) => Math.abs(item.centerX - (intercept + (item.day - 1) * spacing)) <= spacing * 0.48);
    }

    const countDays = daysInMonth(monthYear.year, monthYear.month);
    const firstCenter = intercept;
    const lastCenter = intercept + (countDays - 1) * spacing;
    if (firstCenter < -spacing || lastCenter > canvas.width + spacing) return null;

    const yFit = linearRegression(inliers.length ? inliers : row, 'centerX', 'bottom');
    const fallbackBottom = median((inliers.length ? inliers : row).map((item) => item.bottom));
    const bestByDay = new Map();
    (inliers.length ? inliers : row).forEach((item) => {
      const residual = Math.abs(item.centerX - (intercept + (item.day - 1) * spacing));
      const previous = bestByDay.get(item.day);
      if (!previous || residual < previous.residual || (residual === previous.residual && item.confidence > previous.item.confidence)) {
        bestByDay.set(item.day, { item, residual });
      }
    });
    const knownDays = Array.from(bestByDay.keys()).sort((left, right) => left - right);
    const interpolateDayValue = (day, property, fallbackValue) => {
      const exact = bestByDay.get(day);
      if (exact) return exact.item[property];
      const lowerDay = knownDays.filter((value) => value < day).at(-1);
      const upperDay = knownDays.find((value) => value > day);
      if (Number.isInteger(lowerDay) && Number.isInteger(upperDay)) {
        const lower = bestByDay.get(lowerDay).item[property];
        const upper = bestByDay.get(upperDay).item[property];
        return lower + ((upper - lower) * (day - lowerDay)) / (upperDay - lowerDay);
      }
      if (Number.isInteger(lowerDay)) {
        const lower = bestByDay.get(lowerDay).item[property];
        return property === 'centerX'
          ? lower + (day - lowerDay) * spacing
          : lower;
      }
      if (Number.isInteger(upperDay)) {
        const upper = bestByDay.get(upperDay).item[property];
        return property === 'centerX'
          ? upper - (upperDay - day) * spacing
          : upper;
      }
      return fallbackValue;
    };
    const dayCenters = Array.from({ length: countDays }, (_, index) =>
      interpolateDayValue(index + 1, 'centerX', firstCenter + index * spacing));
    const dayBottoms = Array.from({ length: countDays }, (_, index) => {
      const centerX = dayCenters[index];
      const fitted = yFit.slope * centerX + yFit.intercept;
      return interpolateDayValue(index + 1, 'bottom', Number.isFinite(fitted) ? fitted : fallbackBottom);
    });
    const localSpacings = dayCenters.slice(1).map((value, index) => value - dayCenters[index])
      .filter((value) => Number.isFinite(value) && value >= 8 && value <= 120);
    const resolvedSpacing = median(localSpacings) || spacing;

    return {
      spacing: resolvedSpacing,
      firstCenter: dayCenters[0],
      countDays,
      dayCenter(day) {
        return dayCenters[Math.max(0, Math.min(countDays - 1, day - 1))];
      },
      dayRowBottom(day) {
        return dayBottoms[Math.max(0, Math.min(countDays - 1, day - 1))];
      },
      recognizedDays: bestByDay.size,
      rawDays: row.length
    };
  }

  function canvasGrayAnalysis(canvas) {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const gray = new Float32Array(canvas.width * canvas.height);
    let sum = 0;
    let sumSquares = 0;
    const border = [];
    const innerValues = [];
    let edgeTotal = 0;
    let edgeCount = 0;
    const innerLeft = Math.max(1, Math.floor(canvas.width * 0.08));
    const innerRight = Math.min(canvas.width - 1, Math.ceil(canvas.width * 0.92));
    const innerTop = Math.max(1, Math.floor(canvas.height * 0.06));
    const innerBottom = Math.min(canvas.height - 1, Math.ceil(canvas.height * 0.90));
    const rowSum = new Float64Array(canvas.height);
    const rowSumSquares = new Float64Array(canvas.height);
    const rowCount = new Uint32Array(canvas.height);

    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const pixelIndex = (y * canvas.width + x) * 4;
        const value = imageData.data[pixelIndex] * 0.299 + imageData.data[pixelIndex + 1] * 0.587 + imageData.data[pixelIndex + 2] * 0.114;
        const index = y * canvas.width + x;
        gray[index] = value;
        sum += value;
        sumSquares += value * value;
        if (x < 3 || y < 3 || x >= canvas.width - 3 || y >= canvas.height - 3) border.push(value);
        if (x >= innerLeft && x < innerRight && y >= innerTop && y < innerBottom) {
          innerValues.push(value);
          rowSum[y] += value;
          rowSumSquares[y] += value * value;
          rowCount[y] += 1;
        }
        if (x > 0) {
          edgeTotal += Math.abs(value - gray[index - 1]);
          edgeCount += 1;
        }
        if (y > 0) {
          edgeTotal += Math.abs(value - gray[index - canvas.width]);
          edgeCount += 1;
        }
      }
    }

    const count = Math.max(1, gray.length);
    const mean = sum / count;
    const variance = Math.max(0, sumSquares / count - mean * mean);
    const sortedInner = innerValues.slice().sort((left, right) => left - right);
    const percentile = (fraction) => {
      if (!sortedInner.length) return mean;
      const index = Math.max(0, Math.min(sortedInner.length - 1, Math.round((sortedInner.length - 1) * fraction)));
      return sortedInner[index];
    };
    const p10 = percentile(0.10);
    const p50 = percentile(0.50);
    const p90 = percentile(0.90);
    const rowStd = Array.from({ length: canvas.height }, (_, y) => {
      if (!rowCount[y]) return 0;
      const rowMean = rowSum[y] / rowCount[y];
      return Math.sqrt(Math.max(0, rowSumSquares[y] / rowCount[y] - rowMean * rowMean));
    });
    const meanRange = (from, to) => {
      const start = Math.max(0, Math.floor(canvas.height * from));
      const finish = Math.min(canvas.height, Math.ceil(canvas.height * to));
      const values = rowStd.slice(start, finish).filter(Number.isFinite);
      return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
    };
    const rowTopStd = meanRange(0.04, 0.38);
    const rowMidStd = meanRange(0.18, 0.76);
    const rowBottomStd = meanRange(0.70, 0.98);

    const signatureCanvas = document.createElement('canvas');
    signatureCanvas.width = 12;
    signatureCanvas.height = 12;
    const signatureContext = signatureCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
    signatureContext.drawImage(canvas, 0, 0, 12, 12);
    const signatureData = signatureContext.getImageData(0, 0, 12, 12).data;
    const signatureRaw = [];
    let minSignature = 255;
    let maxSignature = 0;
    for (let index = 0; index < signatureData.length; index += 4) {
      const value = signatureData[index] * 0.299 + signatureData[index + 1] * 0.587 + signatureData[index + 2] * 0.114;
      signatureRaw.push(value);
      minSignature = Math.min(minSignature, value);
      maxSignature = Math.max(maxSignature, value);
    }
    const signatureRange = Math.max(1, maxSignature - minSignature);
    return {
      mean,
      std: Math.sqrt(variance),
      edge: edgeTotal / Math.max(1, edgeCount),
      borderMedian: median(border),
      p10,
      median: p50,
      p90,
      contrastRange: p90 - p10,
      upperTail: p90 - p50,
      lowerTail: p50 - p10,
      rowTopStd,
      rowMidStd,
      rowBottomStd,
      mainRowLikely: rowBottomStd <= rowMidStd * 0.92 + 4,
      signature: signatureRaw.map((value) => (value - minSignature) / signatureRange)
    };
  }

  function signatureDistance(left, right) {
    if (!left || !right || left.length !== right.length || !left.length) return Infinity;
    let normal = 0;
    let inverted = 0;
    for (let index = 0; index < left.length; index += 1) {
      normal += Math.abs(left[index] - right[index]);
      inverted += Math.abs(left[index] - (1 - right[index]));
    }
    return Math.min(normal, inverted) / left.length;
  }

  function occupancyThreshold(records) {
    const values = records.map((record) => record.analysis.std).filter(Number.isFinite).sort((left, right) => left - right);
    let bestGap = 0;
    let threshold = 18;
    for (let index = 0; index < values.length - 1; index += 1) {
      const gap = values[index + 1] - values[index];
      if (values[index] <= 27 && values[index + 1] >= 14 && gap > bestGap) {
        bestGap = gap;
        threshold = (values[index] + values[index + 1]) / 2;
      }
    }
    return bestGap >= 4 ? Math.max(14, Math.min(27, threshold)) : 17;
  }

  function createPreparedCodeCanvas(cellCanvas, mode, options) {
    const settings = {
      scale: 10,
      insetX: Math.max(1, Math.round(cellCanvas.width * 0.08)),
      insetY: Math.max(1, Math.round(cellCanvas.height * 0.06)),
      ...options
    };
    const sourceWidth = Math.max(1, cellCanvas.width - settings.insetX * 2);
    const sourceHeight = Math.max(1, cellCanvas.height - settings.insetY * 2);
    const result = document.createElement('canvas');
    result.width = Math.max(1, Math.round(sourceWidth * settings.scale));
    result.height = Math.max(1, Math.round(sourceHeight * settings.scale));
    const context = result.getContext('2d', { alpha: false, willReadFrequently: true });
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, result.width, result.height);
    context.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in context) context.imageSmoothingQuality = 'high';
    context.drawImage(
      cellCanvas,
      settings.insetX,
      settings.insetY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      result.width,
      result.height
    );

    const imageData = context.getImageData(0, 0, result.width, result.height);
    const grayValues = new Uint8Array(result.width * result.height);
    const histogram = new Uint32Array(256);
    for (let pixel = 0, index = 0; pixel < grayValues.length; pixel += 1, index += 4) {
      const gray = Math.max(0, Math.min(255, Math.round(
        imageData.data[index] * 0.299 +
        imageData.data[index + 1] * 0.587 +
        imageData.data[index + 2] * 0.114
      )));
      grayValues[pixel] = gray;
      histogram[gray] += 1;
    }

    let equalizationMap = null;
    if (mode === 'equalized') {
      equalizationMap = new Uint8Array(256);
      let cumulative = 0;
      let firstNonZero = 0;
      while (firstNonZero < 255 && histogram[firstNonZero] === 0) firstNonZero += 1;
      const minimumCdf = histogram[firstNonZero] || 0;
      const denominator = Math.max(1, grayValues.length - minimumCdf);
      for (let value = 0; value < 256; value += 1) {
        cumulative += histogram[value];
        equalizationMap[value] = Math.max(0, Math.min(255, Math.round((cumulative - minimumCdf) * 255 / denominator)));
      }
    }

    for (let pixel = 0, index = 0; pixel < grayValues.length; pixel += 1, index += 4) {
      let value = equalizationMap ? equalizationMap[grayValues[pixel]] : grayValues[pixel];
      if (mode === 'inverted') value = 255 - value;
      imageData.data[index] = value;
      imageData.data[index + 1] = value;
      imageData.data[index + 2] = value;
      imageData.data[index + 3] = 255;
    }
    context.putImageData(imageData, 0, 0);
    return result;
  }

  async function recognizePreparedCode(worker, canvas, whitelist, psm) {
    try {
      await worker.setParameters({
        tessedit_pageseg_mode: psm,
        tessedit_char_whitelist: whitelist
      });
      const result = await worker.recognize(canvas);
      return String(result && result.data ? result.data.text || '' : '').trim();
    } catch (_) {
      return '';
    }
  }

  function normalizeGridToken(token) {
    let value = String(token || '').toUpperCase().replace(/[^A-Z0-9+]/g, '');
    const corrections = {
      R4: 'R+', RY: 'R+', RP: 'R+', RT: 'R+', R7: 'R+',
      FB: 'F6', F8: 'F6',
      ZI: 'Z1', ZL: 'Z1',
      SI: 'S2', S1: 'S2',
      NI: 'N2'
    };
    return corrections[value] || value;
  }

  function classifyGridOcrText(text) {
    const compact = String(text || '').toUpperCase().replace(/[^A-Z0-9+]/g, '');
    if (!compact) return { codes: [], family: '', exact: false, ignoredRCode: '' };
    const codes = [];
    const add = (code) => { if (!codes.includes(code)) codes.push(code); };
    const ignoredMatch = compact.match(/R([123])/);
    const ignoredRCode = ignoredMatch ? `R${ignoredMatch[1]}` : '';

    if (/R(?:4|\+)/.test(compact)) add('R+');
    if (/F6/.test(compact)) add('F6');
    if (/F4/.test(compact)) add('F4');
    if (/(?:Z1|21)/.test(compact)) add('Z1');
    if (/(?:S2|52|22)/.test(compact)) add('S2');
    if (/N2/.test(compact)) add('N2');
    if (codes.length) return { codes, family: '', exact: true, ignoredRCode };

    if (/N1/.test(compact) || /S1/.test(compact) || /F[123579]/.test(compact)) {
      return { codes: [], family: '', exact: false, ignoredRCode };
    }
    if (ignoredRCode && /^R[123]$/.test(compact)) {
      return { codes: [], family: '', exact: false, ignoredRCode };
    }
    if (['OF', '0F', 'ON', 'IN', 'IN2'].includes(compact)) {
      return { codes: ['N2'], family: 'N', exact: false, ignoredRCode };
    }
    if (compact.includes('N') && !/[FRSZ]/.test(compact)) {
      return { codes: ['N2'], family: 'N', exact: false, ignoredRCode };
    }
    if ((compact.includes('Z') || compact === '21') && !/[FRSN]/.test(compact)) {
      return { codes: ['Z1'], family: 'Z', exact: false, ignoredRCode };
    }
    if (['IS', 'ISS', 'AS'].includes(compact)) {
      return { codes: [], family: 'S', exact: false, ignoredRCode };
    }
    if (compact.includes('S') && !/[FNRZ]/.test(compact)) {
      return { codes: ['S2'], family: 'S', exact: false, ignoredRCode };
    }
    if (compact.includes('F')) {
      return { codes: [], family: 'F', exact: false, ignoredRCode };
    }
    return { codes: [], family: '', exact: false, ignoredRCode };
  }

  function extractRelevantCodesFromOcrText(text) {
    return classifyGridOcrText(text).codes;
  }

  function createThresholdLetterCanvas(cellCanvas, analysis, factor) {
    const width = Math.max(120, Math.round(cellCanvas.width * 6));
    const height = Math.max(160, Math.round(cellCanvas.height * 6));
    const source = document.createElement('canvas');
    source.width = width;
    source.height = height;
    const sourceContext = source.getContext('2d', { alpha: false, willReadFrequently: true });
    sourceContext.fillStyle = '#ffffff';
    sourceContext.fillRect(0, 0, width, height);
    sourceContext.imageSmoothingEnabled = true;
    sourceContext.drawImage(cellCanvas, 0, 0, width, height);
    const imageData = sourceContext.getImageData(0, 0, width, height);
    const darkOnLight = analysis.median > 135 && analysis.lowerTail > analysis.upperTail * 1.35;
    const tail = darkOnLight ? analysis.lowerTail : analysis.upperTail;
    const threshold = darkOnLight
      ? analysis.median - Math.max(4, tail * factor)
      : analysis.median + Math.max(4, tail * factor);
    const foreground = new Uint8Array(width * height);

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixelIndex = (y * width + x) * 4;
        const gray = imageData.data[pixelIndex] * 0.299 + imageData.data[pixelIndex + 1] * 0.587 + imageData.data[pixelIndex + 2] * 0.114;
        foreground[y * width + x] = darkOnLight ? (gray < threshold ? 1 : 0) : (gray > threshold ? 1 : 0);
      }
    }

    const clearTop = Math.round(height * 0.04);
    const clearBottom = Math.round(height * 0.06);
    const clearSide = Math.round(width * 0.035);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (y < clearTop || y >= height - clearBottom || x < clearSide || x >= width - clearSide) {
          foreground[y * width + x] = 0;
        }
      }
    }

    const cleaned = foreground.slice();
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        if (!foreground[index]) continue;
        let neighbors = 0;
        for (let yy = -1; yy <= 1; yy += 1) {
          for (let xx = -1; xx <= 1; xx += 1) {
            if (xx || yy) neighbors += foreground[(y + yy) * width + x + xx];
          }
        }
        if (neighbors <= 1) cleaned[index] = 0;
      }
    }

    const resultWidth = Math.max(80, Math.round(width * 0.76));
    const result = document.createElement('canvas');
    result.width = resultWidth;
    result.height = height;
    const resultContext = result.getContext('2d', { alpha: false, willReadFrequently: true });
    resultContext.fillStyle = '#ffffff';
    resultContext.fillRect(0, 0, resultWidth, height);
    const resultData = resultContext.getImageData(0, 0, resultWidth, height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < resultWidth; x += 1) {
        const value = cleaned[y * width + x] ? 0 : 255;
        const pixelIndex = (y * resultWidth + x) * 4;
        resultData.data[pixelIndex] = value;
        resultData.data[pixelIndex + 1] = value;
        resultData.data[pixelIndex + 2] = value;
        resultData.data[pixelIndex + 3] = 255;
      }
    }
    resultContext.putImageData(resultData, 0, 0);
    return result;
  }

  function firstShiftLetter(value) {
    const match = String(value || '').toUpperCase().match(/[FZSN]/);
    return match ? match[0] : '';
  }

  function inferFCodeFromAppearance(analysis) {
    const lightBox = analysis.median > 135 && analysis.lowerTail > analysis.upperTail * 1.35;
    const ambiguous = analysis.median > 130 && analysis.median < 155 &&
      analysis.lowerTail > analysis.upperTail * 1.12 && analysis.lowerTail < analysis.upperTail * 1.55;
    return { code: lightBox ? 'F4' : 'F6', needsReview: ambiguous };
  }

  async function recognizeGridLetter(worker, canvas) {
    const psmChar = (window.Tesseract.PSM && window.Tesseract.PSM.SINGLE_CHAR) || 10;
    const text = await recognizePreparedCode(worker, canvas, 'FZSN', psmChar);
    return { letter: firstShiftLetter(text), text };
  }

  async function recognizeGridCell(worker, cellCanvas, analysis) {
    const psmWord = (window.Tesseract.PSM && window.Tesseract.PSM.SINGLE_WORD) || 8;
    const wordAttempts = [];
    for (const mode of ['raw', 'inverted', 'equalized']) {
      const prepared = createPreparedCodeCanvas(cellCanvas, mode, {
        insetX: Math.max(0, Math.round(cellCanvas.width * 0.02)),
        insetY: 0,
        scale: 10
      });
      const text = await recognizePreparedCode(worker, prepared, 'FZSN1246R+', psmWord);
      const classified = classifyGridOcrText(text);
      wordAttempts.push({ text, ...classified });
    }

    const exactVotes = new Map();
    wordAttempts.forEach((attempt) => {
      if (!attempt.exact) return;
      attempt.codes.forEach((code) => exactVotes.set(code, (exactVotes.get(code) || 0) + 1));
    });
    const exactCodes = Array.from(exactVotes.entries())
      .filter(([, votes]) => votes >= 2 || exactVotes.size === 1)
      .sort((left, right) => right[1] - left[1])
      .map(([code]) => code);
    const ignoredRCode = wordAttempts.map((attempt) => attempt.ignoredRCode).find(Boolean) || '';

    if (exactCodes.length) {
      return {
        codes: Array.from(new Set(exactCodes)),
        family: '',
        exact: true,
        ignoredRCode,
        text: wordAttempts.map((attempt) => attempt.text).filter(Boolean).join(' / '),
        needsReview: false
      };
    }

    const raw = await recognizeGridLetter(worker, createPreparedCodeCanvas(cellCanvas, 'inverted', {
      insetX: 0,
      insetY: 0,
      scale: 8
    }));
    const primaryMask = await recognizeGridLetter(worker, createThresholdLetterCanvas(cellCanvas, analysis, 0.22));
    const attempts = [raw, primaryMask];

    if ((!raw.letter && !primaryMask.letter) || (raw.letter && primaryMask.letter && raw.letter !== primaryMask.letter)) {
      attempts.push(await recognizeGridLetter(worker, createThresholdLetterCanvas(cellCanvas, analysis, 0.38)));
    }

    wordAttempts.forEach((attempt) => {
      if (attempt.family) attempts.push({ letter: attempt.family, text: attempt.text });
    });

    const counts = new Map();
    attempts.forEach((attempt) => {
      if (attempt.letter) counts.set(attempt.letter, (counts.get(attempt.letter) || 0) + 1);
    });
    const ranked = Array.from(counts.entries()).sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      if (raw.letter === left[0]) return -1;
      if (raw.letter === right[0]) return 1;
      return 0;
    });
    const letter = ranked.length ? ranked[0][0] : '';
    const codes = [];
    let needsReview = false;
    if (letter === 'Z') codes.push('Z1');
    if (letter === 'S') codes.push('S2');
    if (letter === 'N') codes.push('N2');
    if (letter === 'F') {
      const resolved = inferFCodeFromAppearance(analysis);
      codes.push(resolved.code);
      needsReview = resolved.needsReview;
    }
    return {
      codes,
      family: letter,
      exact: Boolean(letter && (counts.get(letter) || 0) >= 2),
      ignoredRCode,
      text: [...wordAttempts.map((attempt) => attempt.text), ...attempts.map((attempt) => attempt.text)]
        .filter(Boolean)
        .join(' / '),
      needsReview
    };
  }

  async function recognizeLowerRCode(worker, cellCanvas) {
    const lowerTop = Math.max(0, Math.floor(cellCanvas.height * 0.43));
    const lowerCanvas = cropCanvasRegion(
      cellCanvas,
      0,
      lowerTop,
      cellCanvas.width,
      cellCanvas.height - lowerTop,
      { scale: 1 }
    );
    const psmWord = (window.Tesseract.PSM && window.Tesseract.PSM.SINGLE_WORD) || 8;
    for (const mode of ['raw', 'equalized']) {
      const prepared = createPreparedCodeCanvas(lowerCanvas, mode, {
        insetX: Math.max(1, Math.round(lowerCanvas.width * 0.06)),
        insetY: Math.max(0, Math.round(lowerCanvas.height * 0.03)),
        scale: 11
      });
      const text = await recognizePreparedCode(worker, prepared, 'R1234+', psmWord);
      const compact = text.toUpperCase().replace(/[^R1234+]/g, '');
      if (/R(?:4|\+)/.test(compact)) return { code: 'R+', raw: compact };
      if (/R[123]/.test(compact)) return { code: '', ignored: compact.match(/R[123]/)[0], raw: compact };
    }
    return { code: '', ignored: '', raw: '' };
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

  async function extractWindowsGridEvents(canvas, worker, shiftCodes, sourceIndex, initialOcrResult) {
    const warnings = [];
    let ocrData = initialOcrResult && initialOcrResult.data ? initialOcrResult.data : {};
    let ocrText = String(ocrData.text || '');
    let monthYear = extractMonthYearFromText(ocrText);
    let dayModel = monthYear ? findDayRowModel(wordsFromOcrData(ocrData), monthYear, canvas) : null;

    if (!monthYear || !dayModel) {
      try {
        await worker.setParameters({
          tessedit_pageseg_mode: (window.Tesseract.PSM && window.Tesseract.PSM.SINGLE_BLOCK) || 6,
          tessedit_char_whitelist: ''
        });
        const fallbackCanvas = cropCanvasRegion(canvas, 0, 0, canvas.width, canvas.height, { scale: 1, grayscale: true });
        const fallbackResult = await worker.recognize(fallbackCanvas, {}, { text: true, tsv: true, blocks: true });
        const fallbackData = fallbackResult && fallbackResult.data ? fallbackResult.data : {};
        const fallbackMonthYear = extractMonthYearFromText(fallbackData.text || '');
        const fallbackDayModel = fallbackMonthYear ? findDayRowModel(wordsFromOcrData(fallbackData), fallbackMonthYear, canvas) : null;
        if (fallbackMonthYear && fallbackDayModel) {
          ocrData = fallbackData;
          ocrText = String(fallbackData.text || '');
          monthYear = fallbackMonthYear;
          dayModel = fallbackDayModel;
        }
      } catch (_) {
        // The normal OCR result remains the fallback.
      }
    }

    if (!monthYear || !dayModel) {
      return { events: [], warnings };
    }

    const records = [];
    const horizontalInset = 0;
    for (let day = 1; day <= dayModel.countDays; day += 1) {
      const centerX = dayModel.dayCenter(day);
      const halfWidth = dayModel.spacing * 0.46;
      const left = Math.max(0, Math.floor(centerX - halfWidth + horizontalInset));
      const right = Math.min(canvas.width, Math.ceil(centerX + halfWidth - horizontalInset));
      const tileTop = Math.max(0, Math.round(dayModel.dayRowBottom(day) + Math.max(2, dayModel.spacing * 0.10)));
      const tileBottom = Math.min(canvas.height, Math.round(tileTop + dayModel.spacing * 1.35));
      if (right - left < 10 || tileBottom - tileTop < 12) continue;
      const cellCanvas = cropCanvasRegion(canvas, left, tileTop, right - left, tileBottom - tileTop, { scale: 1 });
      const analysis = canvasGrayAnalysis(cellCanvas);
      records.push({
        day,
        centerX,
        tileTop,
        tileBottom,
        cellCanvas,
        analysis,
        codes: [],
        family: '',
        rawText: '',
        exact: false,
        ignoredRCode: '',
        inferred: false,
        needsReview: false
      });
    }

    const tileThreshold = occupancyThreshold(records);
    const occupied = records.filter((record) =>
      record.analysis.std >= tileThreshold &&
      (record.analysis.edge >= 5 || record.analysis.std >= tileThreshold + 4)
    );

    for (const record of occupied) {
      const recognized = await recognizeGridCell(worker, record.cellCanvas, record.analysis);
      record.codes = recognized.codes.slice();
      record.family = recognized.family;
      record.rawText = recognized.text || '';
      record.exact = recognized.exact;
      record.ignoredRCode = recognized.ignoredRCode || '';
      record.needsReview = record.needsReview || Boolean(recognized.needsReview);

      const shouldCheckLowerR = record.family === 'F' ||
        record.codes.some((code) => code === 'F4' || code === 'F6');
      if (shouldCheckLowerR) {
        const lowerR = await recognizeLowerRCode(worker, record.cellCanvas);
        if (lowerR.code && !record.codes.includes(lowerR.code)) record.codes.push(lowerR.code);
        if (!record.ignoredRCode && lowerR.ignored) record.ignoredRCode = lowerR.ignored;
      }
    }

    const byDay = new Map(occupied.map((record) => [record.day, record]));
    for (let pass = 0; pass < 3; pass += 1) {
      for (const record of occupied) {
        if (record.codes.length) continue;
        const visuallyMatchingNeighbors = [byDay.get(record.day - 1), byDay.get(record.day + 1)]
          .filter(Boolean)
          .filter((neighbor) => neighbor.codes.length === 1)
          .map((neighbor) => ({
            neighbor,
            distance: signatureDistance(record.analysis.signature, neighbor.analysis.signature)
          }))
          .filter((item) => item.distance <= 0.105)
          .sort((left, right) => left.distance - right.distance);
        if (!visuallyMatchingNeighbors.length) continue;
        record.codes = [visuallyMatchingNeighbors[0].neighbor.codes[0]];
        record.inferred = true;
      }
    }

    const codeMatchesFamily = (code, family) => {
      if (!code || !family) return false;
      if (family === 'F') return /^F[46]$/.test(code);
      return code.startsWith(family);
    };

    for (let pass = 0; pass < 3; pass += 1) {
      for (const record of occupied) {
        if (record.codes.length || !record.family) continue;
        const neighbors = [byDay.get(record.day - 1), byDay.get(record.day + 1)]
          .filter(Boolean)
          .filter((neighbor) => neighbor.codes.length === 1)
          .map((neighbor) => ({
            neighbor,
            distance: signatureDistance(record.analysis.signature, neighbor.analysis.signature)
          }))
          .filter((item) => item.distance <= 0.19 && codeMatchesFamily(item.neighbor.codes[0], record.family));
        if (!neighbors.length) continue;
        neighbors.sort((left, right) => left.distance - right.distance);
        record.codes = [neighbors[0].neighbor.codes[0]];
        record.inferred = true;
      }
    }

    const unresolvedF = occupied.filter((record) => !record.codes.length && record.family === 'F');
    const visited = new Set();
    for (const record of unresolvedF) {
      if (visited.has(record.day)) continue;
      const group = [record];
      visited.add(record.day);
      let cursor = record;
      while (true) {
        const next = byDay.get(cursor.day + 1);
        if (!next || next.family !== 'F' || next.codes.length || signatureDistance(cursor.analysis.signature, next.analysis.signature) > 0.17) break;
        group.push(next);
        visited.add(next.day);
        cursor = next;
      }
      const nearbyResolved = occupied
        .filter((candidate) => candidate.codes.length === 1 && /^F[46]$/.test(candidate.codes[0]))
        .map((candidate) => ({
          candidate,
          distance: Math.min(...group.map((member) => signatureDistance(member.analysis.signature, candidate.analysis.signature))),
          dayDistance: Math.min(...group.map((member) => Math.abs(member.day - candidate.day)))
        }))
        .filter((item) => item.distance <= 0.18 && item.dayDistance <= 2)
        .sort((left, right) => left.distance - right.distance);
      if (nearbyResolved.length) {
        group.forEach((member) => {
          member.codes = [nearbyResolved[0].candidate.codes[0]];
          member.inferred = true;
        });
      } else if (group.length >= 2) {
        group.forEach((member) => {
          member.codes = ['F6'];
          member.inferred = true;
          member.needsReview = true;
        });
        warnings.push(`F-Kacheln am ${group.map((member) => member.day).join('. und ')}. ${String(monthYear.month).padStart(2, '0')}. wurden als F6 angenommen und sollten kurz geprüft werden.`);
      }
    }

    for (let pass = 0; pass < 2; pass += 1) {
      for (const record of occupied) {
        if (record.codes.length || record.family || record.ignoredRCode) continue;
        const previous = byDay.get(record.day - 1);
        const next = byDay.get(record.day + 1);
        const previousCode = previous && previous.codes.length === 1 ? previous.codes[0] : '';
        const nextCode = next && next.codes.length === 1 ? next.codes[0] : '';
        if (previousCode && nextCode && previousCode === nextCode &&
          signatureDistance(record.analysis.signature, previous.analysis.signature) <= 0.16 &&
          signatureDistance(record.analysis.signature, next.analysis.signature) <= 0.16) {
          record.codes = [previousCode];
          record.inferred = true;
        }
      }
    }

    for (const record of occupied) {
      if (record.codes.length || record.family || record.ignoredRCode) continue;
      const candidates = occupied
        .filter((candidate) => candidate !== record && candidate.codes.length === 1)
        .map((candidate) => ({
          candidate,
          distance: signatureDistance(record.analysis.signature, candidate.analysis.signature),
          dayDistance: Math.abs(record.day - candidate.day)
        }))
        .filter((item) => item.distance <= 0.12)
        .sort((left, right) => left.distance - right.distance || left.dayDistance - right.dayDistance);
      if (!candidates.length) continue;
      const best = candidates[0];
      const competing = candidates.find((item) => item.candidate.codes[0] !== best.candidate.codes[0]);
      if (competing && competing.distance <= best.distance + 0.02) continue;
      record.codes = [best.candidate.codes[0]];
      record.inferred = true;
    }

    const events = [];
    occupied.forEach((record) => {
      const uniqueCodes = Array.from(new Set(record.codes)).filter((code) => ['F6', 'F4', 'Z1', 'S2', 'N2', 'R+'].includes(code));
      if (!uniqueCodes.length) return;
      const date = formatIsoDate(monthYear.year, monthYear.month, record.day);
      uniqueCodes.forEach((code) => {
        const rawSuffix = record.rawText ? ` (OCR: ${record.rawText.replace(/\s+/g, ' ').trim()})` : '';
        const event = eventFromGridCode(code, date, shiftCodes, sourceIndex, `Windows-Kachel ${record.day}: ${code}${rawSuffix}`);
        if (!event) return;
        if (record.inferred) event.note = [event.note, 'Kachel anhand benachbarter, optisch gleicher Dienste zugeordnet'].filter(Boolean).join('; ');
        if (record.needsReview) event.needsReview = true;
        events.push(event);
      });
    });

    const unresolvedFCells = occupied.filter((record) => !record.codes.length && record.family === 'F' && !record.ignoredRCode);
    const unresolvedOther = occupied.filter((record) => !record.codes.length && record.family && record.family !== 'F' && !record.ignoredRCode);
    if (unresolvedFCells.length) {
      warnings.push(`${unresolvedFCells.length} F-Kachel${unresolvedFCells.length === 1 ? '' : 'n'} konnte${unresolvedFCells.length === 1 ? '' : 'n'} nicht eindeutig F4 oder F6 zugeordnet werden und wurde${unresolvedFCells.length === 1 ? '' : 'n'} nicht exportiert.`);
    }
    if (unresolvedOther.length) {
      warnings.push(`${unresolvedOther.length} Dienstkachel${unresolvedOther.length === 1 ? '' : 'n'} konnte${unresolvedOther.length === 1 ? '' : 'n'} nicht sicher zugeordnet werden und wurde${unresolvedOther.length === 1 ? '' : 'n'} nicht exportiert.`);
    }

    try {
      await worker.setParameters({
        tessedit_pageseg_mode: (window.Tesseract.PSM && window.Tesseract.PSM.SPARSE_TEXT) || 11,
        tessedit_char_whitelist: ''
      });
    } catch (_) {
      // The worker is terminated after the current recognition pass anyway.
    }

    if (events.length) {
      warnings.push(`Windows-Raster erkannt: ${events.length} Dienst${events.length === 1 ? '' : 'e'} aus ${dayModel.recognizedDays} sicher gelesenen Tageszahlen.`);
    } else {
      warnings.push('Das Windows-Raster und der Monat wurden erkannt, aber keine Dienstkachel konnte sicher zugeordnet werden. Bitte das Foto möglichst gerade und ohne große schwarze Ränder aufnehmen.');
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
    else if (event.fuzzyMerged) flags.append(makeCompactFlag('Zusammengeführt', 'merged'));
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

  function timeStringToMinutes(value) {
    const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
    if (!match) return NaN;
    return Number(match[1]) * 60 + Number(match[2]);
  }

  function timeStringToMinutesSafe(value) {
    const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
    if (!match) return NaN;
    return Number(match[1]) * 60 + Number(match[2]);
  }

  function eventDurationMinutes(event) {
    if (!event || !event.date || !event.start || !event.end) return NaN;
    const start = new Date(`${event.date}T${event.start}:00`);
    const endDate = effectiveEndDate(event);
    const end = new Date(`${endDate}T${event.end}:00`);
    const minutes = (end.getTime() - start.getTime()) / 60000;
    return Number.isFinite(minutes) ? minutes : NaN;
  }

  function normalizedCodeForEvent(event) {
    if (!event || !event.code) return '';
    if (window.ShiftParser && window.ShiftParser.shiftMetaForCode) {
      return window.ShiftParser.shiftMetaForCode(event.code).code || '';
    }
    return String(event.code || '').toUpperCase();
  }

  function isKnownRelevantCode(code) {
    return ['F6', 'F4', 'Z1', 'S2', 'N2', 'R+'].includes(String(code || ''));
  }

  function isSuspiciousEvent(event) {
    const code = normalizedCodeForEvent(event);
    const duration = eventDurationMinutes(event);
    const startMinutes = timeStringToMinutesSafe(event && event.start);
    const endMinutes = timeStringToMinutesSafe(event && event.end);
    if (!event || !/^\d{4}-\d{2}-\d{2}$/.test(String(event.date || ''))) return true;
    if (!/^\d{2}:\d{2}$/.test(String(event.start || '')) || !/^\d{2}:\d{2}$/.test(String(event.end || ''))) return true;
    if (!isKnownRelevantCode(code)) return true;
    if (!Number.isFinite(duration) || duration <= 120 || duration > 18 * 60) return true;
    if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes)) return true;

    if (code === 'N2') {
      return Math.abs(startMinutes - (22 * 60 + 30)) > 90 || Math.abs(endMinutes - (7 * 60)) > 90;
    }
    if (code === 'R+') {
      return Math.abs(startMinutes - (16 * 60 + 36)) > 90 || Math.abs(endMinutes - (6 * 60 + 54)) > 90;
    }
    if (code === 'F4') return startMinutes < 7 * 60 || startMinutes > 9 * 60 || endMinutes < 15 * 60 || endMinutes > 18 * 60;
    if (code === 'F6') return startMinutes < 5 * 60 + 45 || startMinutes > 7 * 60 + 15 || endMinutes < 14 * 60 || endMinutes > 18 * 60;
    if (code === 'Z1') return startMinutes < 10 * 60 + 45 || startMinutes > 12 * 60 + 30 || endMinutes < 17 * 60 || endMinutes > 23 * 60;
    if (code === 'S2') return startMinutes < 13 * 60 + 45 || startMinutes > 15 * 60 + 15 || endMinutes < 21 * 60 || endMinutes > 24 * 60 - 1;
    return false;
  }

  function isUnclearEvent(event) {
    return !event || event.needsReview || isSuspiciousEvent(event);
  }

  function applyRealityChecksToState() {
    let changed = 0;
    state.events.forEach((event) => {
      if (!isUnclearEvent(event)) return;
      event.needsReview = true;
      event.realityRejected = true;
      event.include = false;
      event.includeTouched = false;
      changed += 1;
    });
    state.realityRejectedCount = changed;
  }

  function dropUnclearEvents() {
    const before = state.events.length;
    state.events = state.events.filter((event) => !isUnclearEvent(event));
    const removed = before - state.events.length;
    if (!removed) {
      showToast('Keine unklaren Termine in der Liste.');
      return;
    }
    renderEvents();
    showToast(`${removed} unklare Termin${removed === 1 ? '' : 'e'} entfernt.`);
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
    const unclear = state.events.filter(isUnclearEvent).length;
    elements.resultCount.textContent = String(state.events.length);
    elements.resultSummary.replaceChildren();
    elements.resultSummary.append(makeSummaryChip(`${selected.length} für Export`, 'good'));
    if (overnight) elements.resultSummary.append(makeSummaryChip(`${overnight} über Nacht`));
    if (review) elements.resultSummary.append(makeSummaryChip(`${review} prüfen`, 'warn'));
    if (unclear) elements.resultSummary.append(makeSummaryChip(`${unclear} unklar`, 'warn'));
    if (state.ignoredDaysOff) elements.resultSummary.append(makeSummaryChip(`${state.ignoredDaysOff} Frei-Wunsch übersprungen`));
    if (state.mergeStats.mergedCount) {
      elements.resultSummary.append(makeSummaryChip(`${state.mergeStats.mergedCount} Überlappung${state.mergeStats.mergedCount === 1 ? '' : 'en'} bereinigt`));
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
    elements.dropUnclearButton.disabled = !unclear;
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
