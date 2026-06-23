(function () {
  'use strict';

  const SETTINGS_KEY = 'schichtscan.settings.v2';
  const state = {
    files: [],
    fileUrls: [],
    events: [],
    rawResults: [],
    parserWarnings: [],
    ignoredDaysOff: 0,
    processing: false,
    activeFileIndex: -1,
    worker: null
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
      showFatalError('Auf dem iPhone kann die OCR nicht zuverlässig direkt aus der Dateien-App gestartet werden. Du brauchst aber keinen gekauften Server: Eine kostenlose statische HTTPS-Seite genügt; nach der Installation arbeitet SchichtScan offline.');
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
      'raw-card', 'raw-results', 'offline-status', 'fatal-error', 'toast'
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
        allEvents.push(...parsed.events);
        state.parserWarnings.push(...parsed.warnings);
        state.ignoredDaysOff += Number(parsed.ignoredDaysOff) || 0;
        state.rawResults.push({
          filename: file.name || `Screenshot ${index + 1}`,
          text,
          confidence,
          datesFound: parsed.datesFound,
          eventsFound: parsed.events.length,
          ignoredDaysOff: Number(parsed.ignoredDaysOff) || 0
        });
        canvas.width = 1;
        canvas.height = 1;
      }

      state.events = window.ShiftParser.mergeAndDedupe(allEvents).map((event) => ({ ...event, include: event.include !== false }));
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

  function createEventCard(event) {
    const card = document.createElement('article');
    card.className = 'event-card';
    card.dataset.id = event.id;
    if (event.include === false) card.classList.add('excluded');
    if (event.needsReview) card.classList.add('review');

    const top = document.createElement('div');
    top.className = 'event-top';

    const includeLabel = document.createElement('label');
    includeLabel.className = 'include-toggle';
    const include = document.createElement('input');
    include.type = 'checkbox';
    include.checked = event.include !== false;
    include.setAttribute('aria-label', 'Termin in den Export aufnehmen');
    include.addEventListener('change', () => {
      event.include = include.checked;
      card.classList.toggle('excluded', !include.checked);
      updateResultSummary();
    });
    includeLabel.append(include);

    const titleArea = document.createElement('div');
    titleArea.className = 'event-title-row';
    const heading = document.createElement('strong');
    heading.textContent = event.title || event.code || 'Dienst';
    const badges = document.createElement('div');
    badges.className = 'event-badges';
    if (event.code) badges.append(makeBadge(event.code));
    if (event.usedDetailTimes) badges.append(makeBadge('Detailzeit', 'detail'));
    if (isOvernightEvent(event)) badges.append(makeBadge('endet am Folgetag', 'overnight'));
    if (event.needsReview) badges.append(makeBadge('bitte prüfen', 'review'));
    titleArea.append(heading, badges);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', 'Termin löschen');
    remove.addEventListener('click', () => {
      state.events = state.events.filter((candidate) => candidate !== event);
      renderEvents();
    });

    top.append(includeLabel, titleArea, remove);

    const fields = document.createElement('div');
    fields.className = 'event-fields';

    const titleInput = makeLabeledInput('Titel', 'text', event.title || event.code || 'Dienst');
    titleInput.input.addEventListener('input', () => {
      event.title = titleInput.input.value;
      heading.textContent = event.title || 'Dienst';
      event.needsReview = false;
      card.classList.remove('review');
      updateResultSummary();
    });

    const dateInput = makeLabeledInput('Datum', 'date', event.date);
    dateInput.input.addEventListener('change', () => {
      event.date = dateInput.input.value;
      clearDerivedTimes(event);
      event.needsReview = false;
      renderEvents();
    });

    const startInput = makeLabeledInput('Beginn', 'time', event.start);
    startInput.input.addEventListener('change', () => {
      event.start = startInput.input.value;
      clearDerivedTimes(event);
      event.needsReview = false;
      renderEvents();
    });

    const endInput = makeLabeledInput('Ende', 'time', event.end);
    endInput.input.addEventListener('change', () => {
      event.end = endInput.input.value;
      clearDerivedTimes(event);
      event.needsReview = false;
      renderEvents();
    });

    fields.append(titleInput.label, dateInput.label, startInput.label, endInput.label);

    const source = document.createElement('p');
    source.className = 'event-source';
    const segmentText = event.segments && event.segments.length
      ? ` · Blöcke: ${event.segments.map((segment) => formatSegment(segment, event.date)).join(', ')}`
      : '';
    const noteText = event.note ? ` · Hinweis: ${event.note}` : '';
    const templateDiffers = event.templateStart && event.templateEnd &&
      (event.templateStart !== event.start || event.templateEnd !== event.end);
    const templateText = templateDiffers ? ` · Standard: ${event.templateStart}–${event.templateEnd}` : '';
    const overnightText = isOvernightEvent(event) ? ' (Folgetag)' : '';
    source.textContent = `${formatDateGerman(event.date)}, ${event.start}–${event.end}${overnightText}${templateText}${segmentText}${noteText}`;

    card.append(top, fields, source);
    return card;
  }

  function effectiveEndDate(event) {
    if (event.endDate && /^\d{4}-\d{2}-\d{2}$/.test(event.endDate)) return event.endDate;
    if (event.end <= event.start && window.ShiftParser && window.ShiftParser.addDays) {
      return window.ShiftParser.addDays(event.date, 1);
    }
    return event.date;
  }

  function isOvernightEvent(event) {
    return effectiveEndDate(event) > event.date || event.end <= event.start;
  }

  function clearDerivedTimes(event) {
    event.segments = [];
    event.usedDetailTimes = false;
    event.templateStart = event.start;
    event.templateEnd = event.end;
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

  function makeBadge(text, className) {
    const badge = document.createElement('span');
    badge.className = `event-badge${className ? ` ${className}` : ''}`;
    badge.textContent = text;
    return badge;
  }

  function makeLabeledInput(labelText, type, value) {
    const label = document.createElement('label');
    label.append(document.createTextNode(labelText));
    const input = document.createElement('input');
    input.type = type;
    input.value = value || '';
    input.autocomplete = 'off';
    label.append(input);
    return { label, input };
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
    if (state.files.length > 1) elements.resultSummary.append(makeSummaryChip(`${state.files.length} Screenshots, Duplikate entfernt`));

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
    const event = {
      id: `manual-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now()}`,
      date: referenceDate,
      start: '08:00',
      end: '16:00',
      endDate: referenceDate,
      templateStart: '08:00',
      templateEnd: '16:00',
      code: '',
      title: 'Dienst',
      note: '',
      segments: [],
      usedDetailTimes: false,
      sourceLine: 'Manuell ergänzt',
      sourceIndex: -1,
      sourceIndices: [-1],
      weekdayMismatch: false,
      needsReview: false,
      extractionMode: 'manual',
      include: true
    };
    state.events.push(event);
    renderEvents();
    requestAnimationFrame(() => {
      const card = elements.eventList.querySelector(`[data-id="${CSS.escape(event.id)}"]`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
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
    const selected = state.events.filter((event) => event.include !== false);
    if (!selected.length) throw new Error('Bitte mindestens einen Termin für den Export auswählen.');
    for (const event of selected) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(event.date || '')) throw new Error('Mindestens ein Datum ist ungültig.');
      if (event.endDate && !/^\d{4}-\d{2}-\d{2}$/.test(event.endDate)) throw new Error('Mindestens ein Enddatum ist ungültig.');
      if (!/^\d{2}:\d{2}$/.test(event.start || '') || !/^\d{2}:\d{2}$/.test(event.end || '')) throw new Error('Mindestens eine Uhrzeit ist ungültig.');
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
        showToast('ICS-Datei wurde an das iOS-Teilen-Menü übergeben.');
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
      registration.update().catch(() => {});
      await navigator.serviceWorker.ready;
      elements.offlineStatus.textContent = 'Offline-Paket ist bereit.';
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
