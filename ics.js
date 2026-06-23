(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IcsBuilder = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function escapeText(value) {
    return String(value || '')
      .replace(/\\/g, '\\\\')
      .replace(/\r?\n/g, '\\n')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,');
  }

  function utf8Length(value) {
    return new TextEncoder().encode(value).length;
  }

  function foldLine(line) {
    if (utf8Length(line) <= 75) return line;
    const chunks = [];
    let current = '';
    let limit = 75;
    for (const character of line) {
      if (utf8Length(current + character) > limit) {
        chunks.push(current);
        current = character;
        limit = 74;
      } else {
        current += character;
      }
    }
    if (current) chunks.push(current);
    return chunks.map((chunk, index) => (index === 0 ? chunk : ` ${chunk}`)).join('\r\n');
  }

  function addDays(isoDate, days) {
    const [year, month, day] = isoDate.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + days));
    return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
  }

  function localDateTime(isoDate, time) {
    return `${isoDate.replace(/-/g, '')}T${time.replace(':', '')}00`;
  }

  function utcTimestamp(date) {
    const value = date || new Date();
    return `${value.getUTCFullYear()}${pad2(value.getUTCMonth() + 1)}${pad2(value.getUTCDate())}T${pad2(value.getUTCHours())}${pad2(value.getUTCMinutes())}${pad2(value.getUTCSeconds())}Z`;
  }

  function endsNextDay(start, end) {
    return end <= start;
  }

  function fnv1a(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function validIsoDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
  }

  function germanDate(value) {
    if (!validIsoDate(value)) return String(value || '');
    const [year, month, day] = value.split('-');
    return `${day}.${month}.${year}`;
  }

  function segmentText(segment, eventDate) {
    const startDate = validIsoDate(segment.startDate) ? segment.startDate : eventDate;
    const endDate = validIsoDate(segment.endDate) ? segment.endDate : startDate;
    if (startDate === eventDate && endDate === eventDate) {
      return `${segment.start}–${segment.end}`;
    }
    if (startDate === endDate) {
      return `${germanDate(startDate)} ${segment.start}–${segment.end}`;
    }
    return `${germanDate(startDate)} ${segment.start}–${germanDate(endDate)} ${segment.end}`;
  }

  function buildDescription(event, options) {
    const lines = [];
    const resolvedEnd = resolvedEndDate(event);
    if (validIsoDate(event.date) && resolvedEnd > event.date) {
      lines.push(`Ende: ${germanDate(resolvedEnd)} ${event.end}`);
    }
    const templateDiffers = event.templateStart && event.templateEnd &&
      (event.templateStart !== event.start || event.templateEnd !== event.end ||
        (event.endDate && event.endDate !== event.date && event.templateEnd > event.templateStart));

    if (templateDiffers) {
      lines.push(`Standardzeit: ${event.templateStart}–${event.templateEnd}`);
    }
    if (event.timeNormalized && event.originalTemplateStart && event.originalTemplateEnd) {
      lines.push(`OCR-Zeit korrigiert: ${event.originalTemplateStart}–${event.originalTemplateEnd} → ${event.templateStart}–${event.templateEnd}`);
    }
    if (event.segments && event.segments.length) {
      lines.push(`Arbeitsblöcke: ${event.segments.map((segment) => segmentText(segment, event.date)).join(', ')}`);
    }
    if (event.note) lines.push(`Hinweis: ${event.note}`);
    if (options.includeSourceNote !== false) {
      lines.push('Aus einem Polypoint-Screenshot mit SchichtScan erkannt. Bitte mit dem Originaldienstplan abgleichen.');
    }
    return lines.join('\n');
  }

  function resolvedEndDate(event) {
    const date = validIsoDate(event.date) ? event.date : '';
    if (!date) return validIsoDate(event.endDate) ? event.endDate : event.date;

    const crossesMidnight = endsNextDay(event.start, event.end);
    let endDate = validIsoDate(event.endDate) ? event.endDate : date;

    // Never trust a stale same-day endDate for a clock range such as 16:36–06:54.
    // This guarantees that Ruf- and Nachtdienste end on the following calendar day.
    if (crossesMidnight && endDate <= date) endDate = addDays(date, 1);
    if (!crossesMidnight && endDate < date) endDate = date;
    return endDate;
  }

  function buildIcs(events, options) {
    const settings = {
      calendarName: 'Dienstplan',
      location: '',
      reminderMinutes: 0,
      includeSourceNote: true,
      timeZone: 'Europe/Berlin',
      ...options
    };
    const selected = (events || []).filter((event) => event && event.include !== false);
    const dtstamp = utcTimestamp();
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//SchichtScan//Polypoint Screenshot Import//DE',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:${escapeText(settings.calendarName)}`,
      `X-WR-TIMEZONE:${escapeText(settings.timeZone)}`,
      'BEGIN:VTIMEZONE',
      `TZID:${settings.timeZone}`,
      'X-LIC-LOCATION:Europe/Berlin',
      'BEGIN:DAYLIGHT',
      'TZOFFSETFROM:+0100',
      'TZOFFSETTO:+0200',
      'TZNAME:CEST',
      'DTSTART:19700329T020000',
      'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
      'END:DAYLIGHT',
      'BEGIN:STANDARD',
      'TZOFFSETFROM:+0200',
      'TZOFFSETTO:+0100',
      'TZNAME:CET',
      'DTSTART:19701025T030000',
      'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
      'END:STANDARD',
      'END:VTIMEZONE'
    ];

    for (const event of selected) {
      const endDate = resolvedEndDate(event);
      const title = event.title || event.code || 'Dienst';
      const uidSeed = event.id || `${event.date}|${event.code || title}|${event.templateStart || event.start}|${event.templateEnd || event.end}`;
      const description = buildDescription(event, settings);
      lines.push('BEGIN:VEVENT');
      const uidValue = /^event-[a-f0-9]+$/i.test(uidSeed)
        ? uidSeed
        : `${fnv1a(uidSeed)}-${event.date.replace(/-/g, '')}`;
      lines.push(`UID:${uidValue}@schichtscan.local`);
      lines.push(`DTSTAMP:${dtstamp}`);
      lines.push(`DTSTART;TZID=${settings.timeZone}:${localDateTime(event.date, event.start)}`);
      lines.push(`DTEND;TZID=${settings.timeZone}:${localDateTime(endDate, event.end)}`);
      lines.push(`SUMMARY:${escapeText(title)}`);
      if (settings.location) lines.push(`LOCATION:${escapeText(settings.location)}`);
      if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
      if (/^[A-Za-z]+$/.test(String(event.icsColor || ''))) lines.push(`COLOR:${event.icsColor}`);
      lines.push(event.code ? `CATEGORIES:Dienstplan,${escapeText(event.code)}` : 'CATEGORIES:Dienstplan');
      lines.push('STATUS:CONFIRMED');
      lines.push('TRANSP:OPAQUE');
      lines.push('SEQUENCE:0');
      if (Number(settings.reminderMinutes) > 0) {
        lines.push('BEGIN:VALARM');
        lines.push(`TRIGGER:-PT${Math.round(Number(settings.reminderMinutes))}M`);
        lines.push('ACTION:DISPLAY');
        lines.push(`DESCRIPTION:${escapeText(title)}`);
        lines.push('END:VALARM');
      }
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');

    return lines.map(foldLine).join('\r\n') + '\r\n';
  }

  function filenameForEvents(events) {
    const selected = (events || []).filter((event) => event && event.include !== false);
    if (!selected.length) return 'Dienstplan.ics';
    const dates = selected.flatMap((event) => [event.date, resolvedEndDate(event)]).filter(validIsoDate).sort();
    const from = dates[0];
    const to = dates[dates.length - 1];
    return from === to ? `Dienstplan-${from}.ics` : `Dienstplan-${from}-bis-${to}.ics`;
  }

  return {
    escapeText,
    foldLine,
    addDays,
    buildDescription,
    buildIcs,
    filenameForEvents,
    resolvedEndDate
  };
});
