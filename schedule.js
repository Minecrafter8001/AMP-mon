const enabled = value => value === true || value === 1 || value === '1';

function dateParts(timestamp, timeZone) {
  if (timeZone === 'UTC') {
    const date = new Date(timestamp);
    return { month: date.getUTCMonth(), day: date.getUTCDay(), date: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes() };
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23'
  }).formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
  return {
    month: Number(parts.month) - 1,
    day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
    date: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute)
  };
}

/** Find the next matching minute in the AMP schedule's configured time zone. */
export function nextScheduleTime(interval, now = Date.now(), timeZone = 'UTC') {
  if (!interval || !enabled(interval.EnabledState)) return null;
  const fields = ['MatchMonths', 'MatchDays', 'MatchHours', 'MatchMinutes', 'MatchDaysOfMonth'];
  if (!fields.every(field => Array.isArray(interval[field]))) return null;
  const lists = fields.map(field => interval[field]);
  const start = Math.floor(now / 60000) * 60000 + 60000;
  const limit = 366 * 24 * 60;
  for (let offset = 0; offset < limit; offset++) {
    const timestamp = start + offset * 60000;
    const parts = dateParts(timestamp, timeZone);
    if (lists[0].length && !lists[0].includes(parts.month)) continue;
    if (lists[1].length && !lists[1].includes(parts.day)) continue;
    if (lists[2].length && !lists[2].includes(parts.hour)) continue;
    if (lists[3].length && !lists[3].includes(parts.minute)) continue;
    if (lists[4].length && !lists[4].includes(parts.date)) continue;
    return timestamp;
  }
  return null;
}

function allValues(values, count) {
  return values.length === count && values.every((value, index) => value === index);
}

function formatClock(hours, minutes) {
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function formatScheduleInterval(interval, timeZone = 'UTC') {
  const days = interval.MatchDays ?? [];
  const months = interval.MatchMonths ?? [];
  const hours = interval.MatchHours ?? [];
  const minutes = interval.MatchMinutes ?? [];
  const dates = interval.MatchDaysOfMonth ?? [];
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const zone = timeZone === 'UTC' ? 'UTC' : timeZone;
  const clocks = hours.flatMap(hour => minutes.map(minute => formatClock(hour, minute)));
  const time = clocks.length ? clocks.join(', ') : 'various times';
  const everyMonth = months.length === 0 || allValues(months, 12);
  const everyDay = days.length === 0 || allValues(days, 7);
  if (everyMonth && everyDay && dates.length === 0) {
    if (hours.length === 24 && minutes.length === 1) return `Hourly at :${String(minutes[0]).padStart(2, '0')} ${zone}`;
    if (hours.length === 1 && minutes.length === 1) return `Daily at ${time} ${zone}`;
    if (hours.length && minutes.length) return `Daily at ${time} ${zone}`;
  }
  if (everyMonth && days.length && days.length < 7 && dates.length === 0) {
    return `Weekly on ${days.map(day => weekdays[day]).join(', ')} at ${time} ${zone}`;
  }
  if (dates.length) return `Monthly on day ${dates.join(', ')} at ${time} ${zone}`;
  return `Custom schedule (${zone})`;
}

function methodName(task) {
  return String(task.TaskMethodName ?? task.MethodID ?? task.MethodName ?? '').toLowerCase();
}

const matchFields = ['MatchMonths', 'MatchDays', 'MatchHours', 'MatchMinutes', 'MatchDaysOfMonth'];
const fullCounts = [12, 7, 24, 60, 31];

function normalizedMatch(interval, field, index) {
  const values = [...new Set(interval[field])].sort((first, second) => first - second);
  if (index < 4 && (values.length === 0 || allValues(values, fullCounts[index]))) return [];
  return values;
}

function intervalKey(interval) {
  return JSON.stringify(matchFields.map((field, index) => normalizedMatch(interval, field, index)));
}

function dailySlots(interval) {
  const months = normalizedMatch(interval, 'MatchMonths', 0);
  const days = normalizedMatch(interval, 'MatchDays', 1);
  if (months.length || days.length || interval.MatchDaysOfMonth.length) return null;
  const hours = normalizedMatch(interval, 'MatchHours', 2);
  const minutes = normalizedMatch(interval, 'MatchMinutes', 3);
  const hourValues = hours.length ? hours : Array.from({ length: 24 }, (_, index) => index);
  const minuteValues = minutes.length ? minutes : Array.from({ length: 60 }, (_, index) => index);
  if (!hourValues.every(hour => Number.isInteger(hour) && hour >= 0 && hour < 24) ||
      !minuteValues.every(minute => Number.isInteger(minute) && minute >= 0 && minute < 60)) return null;
  return hourValues.flatMap(hour => minuteValues.map(minute => hour * 60 + minute));
}

function combineDailySchedules(events, now, timeZone) {
  const remaining = events.map(event => ({ event, slots: dailySlots(event.sourceInterval) }));
  const combined = [];
  while (remaining.length > 1) {
    let best = null;
    for (let spacing = 1; spacing <= 720; spacing++) {
      if (1440 % spacing !== 0) continue;
      const residues = new Set(remaining.flatMap(item => item.slots?.map(slot => slot % spacing) ?? []));
      for (const residue of residues) {
        const group = remaining.filter(item => item.slots?.length && item.slots.every(slot => slot % spacing === residue));
        if (group.length < 2) continue;
        const slots = [...new Set(group.flatMap(item => item.slots))].sort((first, second) => first - second);
        if (slots.length !== 1440 / spacing) continue;
        const hours = [...new Set(slots.map(slot => Math.floor(slot / 60)))];
        const minutes = [...new Set(slots.map(slot => slot % 60))];
        if (hours.length * minutes.length !== slots.length) continue;
        if (!best || group.length > best.group.length) best = { group, hours, minutes, spacing };
      }
    }
    if (!best) break;
    const interval = { EnabledState: 1, MatchMonths: [], MatchDays: [], MatchHours: best.hours, MatchMinutes: best.minutes, MatchDaysOfMonth: [] };
    const nextAt = nextScheduleTime(interval, now, timeZone);
    if (nextAt === null) break;
    const period = best.spacing % 60 === 0 ? `${best.spacing / 60} ${best.spacing === 60 ? 'hour' : 'hours'}` : `${best.spacing} ${best.spacing === 1 ? 'minute' : 'minutes'}`;
    const allBackups = best.group.every(item => item.event.state === 'scheduled-backup');
    combined.push({
      state: allBackups ? 'scheduled-backup' : 'scheduled-restart',
      label: allBackups ? 'Scheduled backup (server stops)' : 'Scheduled restart',
      interval: `Every ${period} (${timeZone})`,
      nextAt
    });
    for (const item of best.group) remaining.splice(remaining.indexOf(item), 1);
  }
  return [...combined, ...remaining.map(({ event: { sourceInterval, ...event } }) => event)].sort((first, second) => first.nextAt - second.nextAt);
}

/**
 * Expose only enabled restart tasks and backups that AMP says will stop this
 * particular application server. Event triggers are excluded because they
 * have no predictable next timestamp.
 */
export function deriveScheduledEvents(scheduleData, backupWillStopServer, now = Date.now(), timeZone = 'UTC') {
  if (!Array.isArray(scheduleData?.PopulatedTriggers)) return [];
  const events = [];
  for (const trigger of scheduleData.PopulatedTriggers) {
    if (trigger.TriggerType !== 'TimeIntervalTrigger' || !enabled(trigger.EnabledState)) continue;
    const interval = trigger.interval;
    if (!interval || !enabled(interval.EnabledState)) continue;
    const tasks = [...(trigger.Tasks ?? [])].filter(task => enabled(task.EnabledState)).sort((first, second) => (first.Order ?? 0) - (second.Order ?? 0));
    const methods = tasks.map(methodName);
    const stopIndex = methods.findIndex(method => /(?:^|\.)stop$/.test(method));
    const startIndex = methods.findIndex((method, index) => index > stopIndex && /(?:^|\.)start$/.test(method));
    const hasRestartMethod = methods.some(method => /(?:^|\.)(?:restart|restartamp)$/.test(method));
    const scheduledRestart = hasRestartMethod || stopIndex >= 0 && startIndex > stopIndex;
    const backupTask = tasks.find(task => /(?:^|\.)localfilebackupplugin\.takebackup$/.test(methodName(task)));
    const backupWhileRunning = backupTask?.ParameterMapping?.BackupWhileRunning;
    const explicitRunWhile = String(backupWhileRunning).toLowerCase() === 'true';
    const scheduledBackup = Boolean(backupTask) && backupWillStopServer === true && !explicitRunWhile;
    if (!scheduledRestart && !scheduledBackup) continue;
    const nextAt = nextScheduleTime(interval, now, timeZone);
    if (nextAt === null) continue;
    const state = scheduledBackup && scheduledRestart ? 'scheduled-backup-and-restart' : scheduledBackup ? 'scheduled-backup' : 'scheduled-restart';
    const label = scheduledBackup && scheduledRestart ? 'Scheduled backup and restart' : scheduledBackup ? 'Scheduled backup (server stops)' : 'Scheduled restart';
    events.push({ state, label, interval: formatScheduleInterval(interval, timeZone), nextAt, sourceInterval: interval });
  }
  const unique = new Map();
  for (const event of events) {
    const key = intervalKey(event.sourceInterval);
    const existing = unique.get(key);
    if (!existing) unique.set(key, event);
    else if (existing.state !== event.state) {
      existing.state = 'scheduled-backup-and-restart';
      existing.label = 'Scheduled backup and restart';
    }
  }
  return combineDailySchedules([...unique.values()], now, timeZone);
}