(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShiftParser = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WEEKDAYS = [
    'sonntag', 'montag', 'dienstag', 'mittwoch',
    'donnerstag', 'freitag', 'samstag'
  ];

  const DEFAULT_SHIFT_CODES = Object.freeze({
    '06:30-15:00': 'F6',
    '08:00-16:30': 'F4',
    '11:30-20:00': 'Z1',
    '14:30-23:00': 'S2',
    '22:30-07:00': 'N2',
    '16:36-06:54': 'R+'
  });

  const IGNORED_CODE_TOKENS = new Set([
    'SONNTAG', 'MONTAG', 'DIENSTAG', 'MITTWOCH', 'DONNERSTAG', 'FREITAG', 'SAMSTAG',
    'SO', 'MO', 'DI', 'MI', 'DO', 'FR', 'SA', 'ARBEITSZEIT', 'UHR', 'FREI', 'WUNSCH'
  ]);

  const OCR_NUMBER_CHARS = '0-9OoQIl|!ZzSsBb';

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function normalizeLine(value) {
    return String(value || '')
      .normalize('NFKC')
      .replace(/[\u2010-\u2015\u2212]/g, '-')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  function parseOcrNumber(value) {
    const normalized = String(value || '')
      .replace(/[OoQ]/g, '0')
      .replace(/[Il|!]/g, '1')
      .replace(/[Zz]/g, '2')
      .replace(/[Ss]/g, '5')
      .replace(/[Bb]/g, '8')
      .replace(/[^0-9]/g, '');
    return normalized ? Number(normalized) : NaN;
  }

  function validDateParts(year, month, day) {
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day;
  }

  function isoDate(year, month, day) {
    return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
  }

  function addDays(value, days) {
    const parts = String(value || '').split('-').map(Number);
    if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return value;
    const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + days));
    return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }

  function parseDateFromLine(line) {
    const value = normalizeLine(line);
    const weekdayMatch = value.match(/\b(sonntag|montag|dienstag|mittwoch|donnerstag|freitag|samstag)\b/i);
    const dateMatch = value.match(new RegExp(`([${OCR_NUMBER_CHARS}]{1,2})\\s*[.\\/-]\\s*([${OCR_NUMBER_CHARS}]{1,2})\\s*[.\\/-]\\s*([${OCR_NUMBER_CHARS}]{4})`));
    if (!dateMatch) return null;

    const day = parseOcrNumber(dateMatch[1]);
    const month = parseOcrNumber(dateMatch[2]);
    const year = parseOcrNumber(dateMatch[3]);
    if (!validDateParts(year, month, day)) return null;

    const valueIsoDate = isoDate(year, month, day);
    const expectedWeekdayIndex = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const statedWeekday = weekdayMatch ? weekdayMatch[1].toLowerCase() : '';
    const statedWeekdayIndex = statedWeekday ? WEEKDAYS.indexOf(statedWeekday) : -1;

    return {
      isoDate: valueIsoDate,
      year,
      month,
      day,
      statedWeekday,
      weekdayMismatch: statedWeekdayIndex >= 0 && statedWeekdayIndex !== expectedWeekdayIndex,
      matchStart: dateMatch.index || 0,
      matchEnd: (dateMatch.index || 0) + dateMatch[0].length
    };
  }

  function extractTimeRanges(line) {
    const value = normalizeLine(line);
    const ranges = [];
    const pattern = new RegExp(`([${OCR_NUMBER_CHARS}]{1,2})\\s*[:.;]\\s*([${OCR_NUMBER_CHARS}]{2})\\s*-\\s*([${OCR_NUMBER_CHARS}]{1,2})\\s*[:.;]\\s*([${OCR_NUMBER_CHARS}]{2})`, 'g');
    let match;
    while ((match = pattern.exec(value)) !== null) {
      const startHour = parseOcrNumber(match[1]);
      const startMinute = parseOcrNumber(match[2]);
      const endHour = parseOcrNumber(match[3]);
      const endMinute = parseOcrNumber(match[4]);
      if (
        startHour >= 0 && startHour <= 23 && startMinute >= 0 && startMinute <= 59 &&
        endHour >= 0 && endHour <= 23 && endMinute >= 0 && endMinute <= 59
      ) {
        const start = `${pad2(startHour)}:${pad2(startMinute)}`;
        const end = `${pad2(endHour)}:${pad2(endMinute)}`;
        ranges.push({
          start,
          end,
          startMinutes: startHour * 60 + startMinute,
          endMinutes: endHour * 60 + endMinute,
          raw: match[0],
          index: match.index,
          endIndex: match.index + match[0].length
        });
      }
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    }
    return ranges;
  }

  function resolvePartialDate(contextDate, day, month, yearValue, referenceDate) {
    let year;
    if (yearValue) {
      year = parseOcrNumber(yearValue);
      if (year < 100) year += 2000;
    } else {
      year = contextDate.year;
      if (referenceDate) {
        const referenceMonth = Number(referenceDate.slice(5, 7));
        const referenceYear = Number(referenceDate.slice(0, 4));
        year = referenceYear + (month < referenceMonth ? 1 : 0);
      }
    }
    if (!validDateParts(year, month, day)) return '';
    return isoDate(year, month, day);
  }

  function extractDatedIntervals(line, contextDate) {
    const value = normalizeLine(line);
    const intervals = [];
    const pattern = new RegExp(
      `([${OCR_NUMBER_CHARS}]{1,2})\\s*[./]\\s*([${OCR_NUMBER_CHARS}]{1,2})(?:\\s*[./]\\s*([${OCR_NUMBER_CHARS}]{2,4}))?\\s+` +
      `([${OCR_NUMBER_CHARS}]{1,2})\\s*[:.;]\\s*([${OCR_NUMBER_CHARS}]{2})\\s*-\\s*` +
      `([${OCR_NUMBER_CHARS}]{1,2})\\s*[./]\\s*([${OCR_NUMBER_CHARS}]{1,2})(?:\\s*[./]\\s*([${OCR_NUMBER_CHARS}]{2,4}))?\\s+` +
      `([${OCR_NUMBER_CHARS}]{1,2})\\s*[:.;]\\s*([${OCR_NUMBER_CHARS}]{2})`,
      'g'
    );

    let match;
    while ((match = pattern.exec(value)) !== null) {
      const startDay = parseOcrNumber(match[1]);
      const startMonth = parseOcrNumber(match[2]);
      const startHour = parseOcrNumber(match[4]);
      const startMinute = parseOcrNumber(match[5]);
      const endDay = parseOcrNumber(match[6]);
      const endMonth = parseOcrNumber(match[7]);
      const endHour = parseOcrNumber(match[9]);
      const endMinute = parseOcrNumber(match[10]);
      const startDate = resolvePartialDate(contextDate, startDay, startMonth, match[3], '');
      const endDate = resolvePartialDate(contextDate, endDay, endMonth, match[8], startDate);
      if (
        startDate && endDate &&
        startHour >= 0 && startHour <= 23 && startMinute >= 0 && startMinute <= 59 &&
        endHour >= 0 && endHour <= 23 && endMinute >= 0 && endMinute <= 59
      ) {
        let resolvedEndDate = endDate;
        const start = `${pad2(startHour)}:${pad2(startMinute)}`;
        const end = `${pad2(endHour)}:${pad2(endMinute)}`;
        if (dateTimeValue(resolvedEndDate, end) <= dateTimeValue(startDate, start)) {
          resolvedEndDate = addDays(resolvedEndDate, 1);
        }
        intervals.push({
          startDate,
          endDate: resolvedEndDate,
          start,
          end,
          startMinutes: startHour * 60 + startMinute,
          endMinutes: endHour * 60 + endMinute,
          raw: match[0],
          index: match.index,
          endIndex: match.index + match[0].length
        });
      }
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    }
    return intervals;
  }

  function timeToMinutes(value) {
    const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
    if (!match) return NaN;
    return Number(match[1]) * 60 + Number(match[2]);
  }

  function minutesToTime(value) {
    const normalized = ((Math.round(value) % 1440) + 1440) % 1440;
    return `${pad2(Math.floor(normalized / 60))}:${pad2(normalized % 60)}`;
  }

  function durationMinutes(range) {
    let duration = range.endMinutes - range.startMinutes;
    if (duration <= 0) duration += 24 * 60;
    return duration;
  }

  function absoluteInterval(range, anchorStart) {
    let start = range.startMinutes;
    let end = range.endMinutes;
    if (end <= start) end += 24 * 60;

    if (typeof anchorStart === 'number') {
      while (start < anchorStart - 60) {
        start += 24 * 60;
        end += 24 * 60;
      }
    }
    return { start, end };
  }

  function containsRange(main, child) {
    const mainAbs = absoluteInterval(main);
    const childAbs = absoluteInterval(child, mainAbs.start);
    return childAbs.start >= mainAbs.start && childAbs.end <= mainAbs.end;
  }

  function findContainingMainIndex(ranges) {
    let bestIndex = -1;
    let bestDuration = -1;
    for (let index = 0; index < ranges.length; index += 1) {
      const candidate = ranges[index];
      const containsAll = ranges.every((range, rangeIndex) => rangeIndex === index || containsRange(candidate, range));
      const duration = durationMinutes(candidate);
      if (containsAll && duration > bestDuration) {
        bestIndex = index;
        bestDuration = duration;
      }
    }
    return bestIndex;
  }

  function cleanCode(value) {
    let token = String(value || '').toUpperCase().replace(/[^A-Z0-9+]/g, '');
    const corrections = {
      R4: 'R+', RY: 'R+', RP: 'R+', RT: 'R+', R7: 'R+',
      FB: 'F6', F8: 'F6',
      ZI: 'Z1', ZL: 'Z1',
      SI: 'S1',
      NI: 'N1'
    };
    token = corrections[token] || token;
    return token;
  }

  function extractCodeFromLine(line, range) {
    const value = normalizeLine(line);
    const firstTimeIndex = range && Number.isInteger(range.index) ? range.index : value.length;
    const prefix = value.slice(0, firstTimeIndex)
      .replace(/[^A-Za-z0-9+]+/g, ' ')
      .trim();
    const tokens = prefix.split(/\s+/).filter(Boolean);
    for (const rawToken of tokens) {
      const token = cleanCode(rawToken);
      if (!token || IGNORED_CODE_TOKENS.has(token)) continue;
      if (/^[A-Z][A-Z0-9+]{0,3}$/.test(token) && /[0-9+]/.test(token)) return token;
    }
    return '';
  }

  function extractNoteFromLine(line) {
    const value = normalizeLine(line);
    if (/\bMo\s*-\s*Fr\b/i.test(value)) return 'Mo–Fr';
    return '';
  }

  function mappingKey(start, end) {
    return `${start}-${end}`;
  }

  function mappedCodeForRange(range, shiftCodes) {
    if (!range) return '';
    return shiftCodes[mappingKey(range.start, range.end)] || '';
  }

  function inferCodeByStart(start, shiftCodes) {
    const matches = new Set();
    Object.entries(shiftCodes || {}).forEach(([key, code]) => {
      if (key.slice(0, 5) === start && code) matches.add(code);
    });
    return matches.size === 1 ? Array.from(matches)[0] : '';
  }

  function isDayOffLine(line) {
    const value = normalizeLine(line);
    return /\bfrei\b/i.test(value) && (/\bwunsch\b/i.test(value) || value.length < 40);
  }

  function makeEntry(dateInfo, line, templateRange, sourceIndex, fallback) {
    return {
      dateInfo,
      templateLine: normalizeLine(line),
      templateRange,
      plainSegments: [],
      datedSegments: [],
      sourceIndex,
      fallback: Boolean(fallback),
      directCode: extractCodeFromLine(line, templateRange),
      note: extractNoteFromLine(line)
    };
  }

  function addPlainSegments(entry, ranges) {
    if (!entry) return;
    ranges.forEach((range) => {
      const key = `${range.start}-${range.end}`;
      if (!entry.plainSegments.some((existing) => `${existing.start}-${existing.end}` === key)) {
        entry.plainSegments.push(range);
      }
    });
  }

  function addDatedSegments(entry, intervals) {
    if (!entry) return;
    intervals.forEach((interval) => {
      const key = `${interval.startDate}T${interval.start}-${interval.endDate}T${interval.end}`;
      if (!entry.datedSegments.some((existing) => `${existing.startDate}T${existing.start}-${existing.endDate}T${existing.end}` === key)) {
        entry.datedSegments.push(interval);
      }
    });
  }

  function likelyContinuation(entry, range, shiftCodes) {
    if (!entry || mappedCodeForRange(range, shiftCodes)) return false;
    const templateStart = entry.templateRange.startMinutes;
    const candidate = absoluteInterval(range, templateStart);
    const maximumReasonableEnd = templateStart + (18 * 60);
    if (candidate.start < templateStart - 15 || candidate.end > maximumReasonableEnd) return false;
    if (!entry.plainSegments.length) {
      return Math.abs(candidate.start - templateStart) <= 15 || candidate.start <= entry.templateRange.endMinutes + 120;
    }
    const previous = entry.plainSegments
      .map((segment) => absoluteInterval(segment, templateStart))
      .sort((a, b) => a.end - b.end)
      .at(-1);
    return candidate.start >= previous.start && candidate.start <= previous.end + 240;
  }

  function dateTimeValue(date, time) {
    const [year, month, day] = String(date || '').split('-').map(Number);
    const minutes = timeToMinutes(time);
    if (![year, month, day, minutes].every(Number.isFinite)) return NaN;
    return Date.UTC(year, month - 1, day) + minutes * 60000;
  }

  function normalizeSegments(entry) {
    const segments = [];
    const anchor = entry.templateRange.startMinutes;

    entry.plainSegments.forEach((range) => {
      const absolute = absoluteInterval(range, anchor);
      segments.push({
        startDate: addDays(entry.dateInfo.isoDate, Math.floor(absolute.start / 1440)),
        endDate: addDays(entry.dateInfo.isoDate, Math.floor(absolute.end / 1440)),
        start: minutesToTime(absolute.start),
        end: minutesToTime(absolute.end)
      });
    });

    entry.datedSegments.forEach((interval) => {
      segments.push({
        startDate: interval.startDate,
        endDate: interval.endDate,
        start: interval.start,
        end: interval.end
      });
    });

    const unique = new Map();
    segments.forEach((segment) => {
      const key = `${segment.startDate}T${segment.start}-${segment.endDate}T${segment.end}`;
      unique.set(key, segment);
    });
    return Array.from(unique.values()).sort((a, b) => dateTimeValue(a.startDate, a.start) - dateTimeValue(b.startDate, b.start));
  }

  function canUseDetailTimes(entry, segments) {
    if (!segments.length) return false;
    if (segments.length >= 2) return true;
    const segment = segments[0];
    const templateDuration = durationMinutes(entry.templateRange);
    const segmentDuration = Math.max(0, (dateTimeValue(segment.endDate, segment.end) - dateTimeValue(segment.startDate, segment.start)) / 60000);
    return segment.startDate === entry.dateInfo.isoDate &&
      Math.abs(timeToMinutes(segment.start) - entry.templateRange.startMinutes) <= 15 &&
      segmentDuration >= templateDuration * 0.7;
  }

  function finalizeEntry(entry, options) {
    if (!entry || !entry.templateRange) return null;
    const shiftCodes = options.shiftCodes || DEFAULT_SHIFT_CODES;
    const mappedCode = mappedCodeForRange(entry.templateRange, shiftCodes);
    const inferredCode = inferCodeByStart(entry.templateRange.start, shiftCodes);
    const code = mappedCode || entry.directCode || inferredCode;
    const segments = normalizeSegments(entry);
    const useDetailTimes = options.preferDetailTimes !== false && canUseDetailTimes(entry, segments);

    let date = entry.dateInfo.isoDate;
    let start = entry.templateRange.start;
    let end = entry.templateRange.end;
    let endDate = entry.templateRange.endMinutes <= entry.templateRange.startMinutes ? addDays(date, 1) : date;

    if (useDetailTimes) {
      const first = segments[0];
      const last = segments[segments.length - 1];
      date = first.startDate;
      start = first.start;
      endDate = last.endDate;
      end = last.end;
    }

    const spanMinutes = (dateTimeValue(endDate, end) - dateTimeValue(date, start)) / 60000;
    const unexpectedStartDate = date !== entry.dateInfo.isoDate;
    const needsReview = !code || entry.dateInfo.weekdayMismatch || entry.fallback ||
      !Number.isFinite(spanMinutes) || spanMinutes <= 0 || spanMinutes > 18 * 60 || unexpectedStartDate;

    const event = {
      id: '',
      date,
      endDate,
      start,
      end,
      templateStart: entry.templateRange.start,
      templateEnd: entry.templateRange.end,
      code,
      title: code || options.defaultTitle || 'Dienst',
      note: entry.note,
      segments,
      usedDetailTimes: useDetailTimes,
      sourceLine: entry.templateLine,
      sourceIndex: entry.sourceIndex,
      sourceIndices: [entry.sourceIndex],
      weekdayMismatch: entry.dateInfo.weekdayMismatch,
      needsReview,
      extractionMode: entry.fallback ? 'fallback' : 'primary',
      include: true
    };
    return event;
  }

  function parseDateBlock(dateInfo, lines, options, sourceIndex) {
    const events = [];
    let ignoredDaysOff = 0;
    let current = null;

    const flushCurrent = () => {
      const event = finalizeEntry(current, options);
      if (event) events.push(event);
      current = null;
    };

    for (const originalLine of lines) {
      const line = normalizeLine(originalLine);
      if (!line || /^[-–—_]+$/.test(line)) continue;
      if (isDayOffLine(line)) {
        ignoredDaysOff += 1;
        continue;
      }

      const datedIntervals = extractDatedIntervals(line, dateInfo);
      if (datedIntervals.length) {
        if (current) addDatedSegments(current, datedIntervals);
        continue;
      }

      const ranges = extractTimeRanges(line);
      if (!ranges.length) continue;

      if (ranges.length > 1) {
        const knownTemplateIndex = ranges.findIndex((range) => Boolean(mappedCodeForRange(range, options.shiftCodes)));
        const containingIndex = findContainingMainIndex(ranges);
        const templateIndex = knownTemplateIndex >= 0 ? knownTemplateIndex : containingIndex;

        if (templateIndex >= 0) {
          flushCurrent();
          current = makeEntry(dateInfo, line, ranges[templateIndex], sourceIndex, false);
          addPlainSegments(current, ranges.filter((_, index) => index !== templateIndex));
        } else if (current) {
          addPlainSegments(current, ranges);
        } else {
          const sorted = ranges.slice().sort((a, b) => a.startMinutes - b.startMinutes);
          const union = {
            ...sorted[0],
            end: sorted.at(-1).end,
            endMinutes: sorted.at(-1).endMinutes
          };
          current = makeEntry(dateInfo, line, union, sourceIndex, true);
          addPlainSegments(current, ranges);
        }
        continue;
      }

      const range = ranges[0];
      const knownCode = mappedCodeForRange(range, options.shiftCodes);
      const directCode = extractCodeFromLine(line, range);
      const primarySignal = Boolean(knownCode || directCode || /\bMo\s*-\s*Fr\b/i.test(line));

      if (!current) {
        current = makeEntry(dateInfo, line, range, sourceIndex, !primarySignal);
      } else if (primarySignal || !likelyContinuation(current, range, options.shiftCodes)) {
        flushCurrent();
        current = makeEntry(dateInfo, line, range, sourceIndex, !primarySignal);
      } else {
        addPlainSegments(current, [range]);
      }
    }

    flushCurrent();
    return { events, ignoredDaysOff };
  }

  function stableId(event) {
    const value = `${event.date}|${event.code || event.title}|${event.templateStart || event.start}|${event.templateEnd || event.end}`;
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `event-${(hash >>> 0).toString(16)}`;
  }

  function eventMergeKey(event) {
    if (event.code) return `${event.date}|${event.code}|${event.templateStart || event.start}|${event.templateEnd || event.end}`;
    return `${event.date}|${event.start}|${event.end}|${event.title || ''}`;
  }

  function eventQuality(event) {
    return (event.segments ? event.segments.length * 10 : 0) +
      (event.usedDetailTimes ? 5 : 0) +
      (event.code ? 3 : 0) +
      (event.needsReview ? 0 : 2) +
      (event.note ? 1 : 0);
  }

  function mergeAndDedupe(events) {
    const map = new Map();
    for (const sourceEvent of events || []) {
      if (!sourceEvent) continue;
      const event = {
        ...sourceEvent,
        segments: (sourceEvent.segments || []).map((segment) => ({ ...segment })),
        sourceIndices: Array.isArray(sourceEvent.sourceIndices)
          ? sourceEvent.sourceIndices.slice()
          : [sourceEvent.sourceIndex]
      };
      const key = eventMergeKey(event);
      if (!map.has(key)) {
        map.set(key, event);
        continue;
      }

      const current = map.get(key);
      const currentActual = `${current.date}T${current.start}-${current.endDate || current.date}T${current.end}`;
      const incomingActual = `${event.date}T${event.start}-${event.endDate || event.date}T${event.end}`;
      const bothDetailed = current.usedDetailTimes && event.usedDetailTimes;
      const conflict = bothDetailed && currentActual !== incomingActual;
      const better = eventQuality(event) > eventQuality(current) ? event : current;
      const other = better === event ? current : event;

      if (!better.note && other.note) better.note = other.note;
      if ((!better.segments || !better.segments.length) && other.segments && other.segments.length) {
        better.segments = other.segments.map((segment) => ({ ...segment }));
      }
      if (!better.code && other.code) {
        better.code = other.code;
        better.title = other.title;
      }
      better.sourceIndices = Array.from(new Set([
        ...(better.sourceIndices || []),
        ...(other.sourceIndices || [])
      ].filter(Number.isInteger)));
      better.needsReview = conflict || (better.needsReview && other.needsReview);
      if (conflict) {
        better.note = [better.note, 'Abweichende Detailzeiten in überlappenden Screenshots'].filter(Boolean).join('; ');
      }
      map.set(key, better);
    }

    const result = Array.from(map.values());
    result.sort((a, b) => `${a.date}T${a.start}`.localeCompare(`${b.date}T${b.start}`));
    result.forEach((event) => { event.id = stableId(event); });
    return result;
  }

  function parseScheduleText(text, options) {
    const settings = {
      shiftCodes: { ...DEFAULT_SHIFT_CODES, ...((options && options.shiftCodes) || {}) },
      defaultTitle: (options && options.defaultTitle) || 'Dienst',
      preferDetailTimes: !options || options.preferDetailTimes !== false
    };
    const sourceIndex = options && Number.isInteger(options.sourceIndex) ? options.sourceIndex : 0;
    const lines = String(text || '').split(/\r?\n/).map(normalizeLine);
    const blocks = [];
    let current = null;

    for (const line of lines) {
      const dateInfo = parseDateFromLine(line);
      if (dateInfo) {
        if (current) blocks.push(current);
        const trailing = normalizeLine(line.slice(dateInfo.matchEnd));
        current = { dateInfo, lines: trailing ? [trailing] : [] };
      } else if (current) {
        current.lines.push(line);
      }
    }
    if (current) blocks.push(current);

    const events = [];
    let ignoredDaysOff = 0;
    for (const block of blocks) {
      const parsedBlock = parseDateBlock(block.dateInfo, block.lines, settings, sourceIndex);
      events.push(...parsedBlock.events);
      ignoredDaysOff += parsedBlock.ignoredDaysOff;
    }

    return {
      events: mergeAndDedupe(events),
      datesFound: blocks.length,
      ignoredDaysOff,
      warnings: blocks.filter((block) => block.dateInfo.weekdayMismatch)
        .map((block) => `Wochentag passt nicht zum Datum ${block.dateInfo.isoDate}.`)
    };
  }

  function parseShiftCodeMapping(value) {
    const result = { ...DEFAULT_SHIFT_CODES };
    String(value || '').split(/\r?\n/).forEach((line) => {
      const normalized = normalizeLine(line);
      if (!normalized || normalized.startsWith('#')) return;
      const separatorIndex = normalized.indexOf('=');
      if (separatorIndex < 0) return;
      const left = normalizeLine(normalized.slice(0, separatorIndex));
      const right = cleanCode(normalized.slice(separatorIndex + 1));
      const ranges = extractTimeRanges(left);
      if (ranges.length === 1 && right) result[mappingKey(ranges[0].start, ranges[0].end)] = right;
    });
    return result;
  }

  function defaultShiftCodeText() {
    return Object.entries(DEFAULT_SHIFT_CODES).map(([range, code]) => `${range}=${code}`).join('\n');
  }

  return {
    DEFAULT_SHIFT_CODES,
    normalizeLine,
    parseDateFromLine,
    extractTimeRanges,
    extractDatedIntervals,
    durationMinutes,
    parseScheduleText,
    mergeAndDedupe,
    parseShiftCodeMapping,
    defaultShiftCodeText,
    stableId,
    addDays
  };
});
