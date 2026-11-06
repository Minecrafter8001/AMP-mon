import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '../configStore.js';
import { AmpClient } from '../ampClient.js';
import { buildInstanceEmbed } from '../dashboard.js';
import { deriveScheduledEvents, nextScheduleTime } from '../schedule.js';

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status });

test('scheduled backup and restart derives the next time only when backup stops the app', () => {
  const now = Date.parse('2026-11-06T03:00:00Z');
  const interval = { EnabledState: 1, MatchMonths: Array.from({ length: 12 }, (_, index) => index), MatchDays: [0, 1, 2, 3, 4, 5, 6], MatchHours: [4], MatchMinutes: [0], MatchDaysOfMonth: [] };
  const schedule = { PopulatedTriggers: [{ TriggerType: 'TimeIntervalTrigger', EnabledState: 1, interval, Tasks: [
    { TaskMethodName: 'Event.GenericModule.Stop', EnabledState: 1, Order: 10 },
    { TaskMethodName: 'Event.LocalFileBackupPlugin.TakeBackup', EnabledState: 1, Order: 20, ParameterMapping: { BackupWhileRunning: 'false' } },
    { TaskMethodName: 'Event.GenericModule.Start', EnabledState: 1, Order: 30 }
  ] }] };
  const event = deriveScheduledEvents(schedule, true, now)[0];
  assert.equal(event.state, 'scheduled-backup-and-restart');
  assert.equal(event.interval, 'Daily at 04:00 UTC');
  assert.equal(event.nextAt, Date.parse('2026-11-06T04:00:00Z'));
  assert.equal(deriveScheduledEvents(schedule, false, now)[0].state, 'scheduled-restart');
  assert.deepEqual(deriveScheduledEvents(schedule, true, now, 'UTC').map(item => item.nextAt), [nextScheduleTime(interval, now)]);
});

test('scheduled restart is retained independently but a non-stopping backup is not exposed', () => {
  const interval = { EnabledState: 1, MatchMonths: [], MatchDays: [], MatchHours: Array.from({ length: 24 }, (_, index) => index), MatchMinutes: [0], MatchDaysOfMonth: [] };
  const schedule = { PopulatedTriggers: [{ TriggerType: 'TimeIntervalTrigger', EnabledState: 1, interval, Tasks: [
    { TaskMethodName: 'Event.LocalFileBackupPlugin.TakeBackup', EnabledState: 1, Order: 10, ParameterMapping: { BackupWhileRunning: 'true' } }
  ] }] };
  const now = Date.parse('2026-11-06T04:20:00Z');
  assert.deepEqual(deriveScheduledEvents(schedule, true, now), []);
  schedule.PopulatedTriggers[0].Tasks.push({ TaskMethodName: 'Event.GenericModule.Restart', EnabledState: 1, Order: 20 });
  const event = deriveScheduledEvents(schedule, false, now)[0];
  assert.equal(event.state, 'scheduled-restart');
  assert.equal(event.interval, 'Hourly at :00 UTC');
  assert.equal(event.nextAt, Date.parse('2026-11-06T05:00:00Z'));
  schedule.PopulatedTriggers[0].EnabledState = 0;
  assert.deepEqual(deriveScheduledEvents(schedule, false, now), []);
});

test('AMP schedule reads are cached and verified maintenance survives a stop', async () => {
  const config = defaults();
  const trigger = { TriggerType: 'TimeIntervalTrigger', EnabledState: 1, Id: 'trigger-id', Tasks: [
    { TaskMethodName: 'Event.GenericModule.Stop', EnabledState: 1, Order: 10 },
    { TaskMethodName: 'Event.LocalFileBackupPlugin.TakeBackup', EnabledState: 1, Order: 20, ParameterMapping: { BackupWhileRunning: 'false' } },
    { TaskMethodName: 'Event.GenericModule.Start', EnabledState: 1, Order: 30 }
  ] };
  const interval = { EnabledState: 1, MatchMonths: [], MatchDays: [], MatchHours: [4], MatchMinutes: [0], MatchDaysOfMonth: [] };
  const schedule = { PopulatedTriggers: [trigger] };
  const calls = new Map();
  const client = new AmpClient({ url: 'https://amp.example/', username: 'bot', settings: { ...config.settings.amp, scheduleRefreshMs: 300000, scheduleTimeZone: 'UTC' },
    fetchImpl: async url => {
      const method = new URL(url).pathname.split('/').at(-1);
      calls.set(method, (calls.get(method) ?? 0) + 1);
      if (method === 'Login') return jsonResponse({ sessionID: 'child-session' });
      if (method === 'GetStatus') return jsonResponse({ State: 20, Metrics: {} });
      if (method === 'GetScheduleData') return jsonResponse(schedule);
      if (method === 'GetTimeIntervalTrigger') return jsonResponse(interval);
      if (method === 'BackupWillStopServer') return jsonResponse(true);
      throw new Error(`Unexpected method ${method}`);
    }
  });
  const instance = { id: 'factorio', name: 'factorio', ampRunning: true, available: true, rawEndpoints: [] };
  const active = await client.getInstanceStatus(instance);
  assert.equal(active.maintenanceState, 'scheduled-backup-and-restart');
  assert.equal(active.scheduleEvents[0].interval, 'Daily at 04:00 UTC');
  assert.equal(calls.get('GetScheduleData'), 1);
  const embed = buildInstanceEmbed(active, Date.now()).toJSON();
  const maintenance = embed.fields.find(field => field.name === 'Scheduled maintenance');
  assert.match(maintenance.value, /Scheduled backup and restart/);
  assert.match(maintenance.value, /<t:\d+:F> \(<t:\d+:R>\)/);
  await client.getInstanceStatus(instance);
  assert.equal(calls.get('GetScheduleData'), 1);
  const stopped = await client.getInstanceStatus({ ...instance, ampRunning: false });
  assert.equal(stopped.appState, 'stopped');
  assert.equal(stopped.maintenanceState, 'scheduled-backup-and-restart');
  client.close();
});

test('complementary daily backup and restart triggers form one four-hour cadence', () => {
  const restart = { TaskMethodName: 'Event.GenericModule.Restart', EnabledState: 1, Order: 10 };
  const backup = { TaskMethodName: 'Event.LocalFileBackupPlugin.TakeBackup', EnabledState: 1, Order: 20 };
  const trigger = (hours, tasks) => ({ TriggerType: 'TimeIntervalTrigger', EnabledState: 1, Tasks: tasks, interval: {
    EnabledState: 1, MatchMonths: [], MatchDays: [], MatchHours: hours, MatchMinutes: [0], MatchDaysOfMonth: []
  } });
  const schedule = { PopulatedTriggers: [trigger([0, 4, 8, 12, 16], [restart]), trigger([20], [restart, backup])] };
  const events = deriveScheduledEvents(schedule, true, Date.parse('2026-11-06T18:30:00Z'));
  assert.equal(events.length, 1);
  assert.equal(events[0].label, 'Scheduled restart');
  assert.equal(events[0].interval, 'Every 4 hours (UTC)');
  assert.equal(events[0].nextAt, Date.parse('2026-11-06T20:00:00Z'));
  schedule.PopulatedTriggers.push(trigger([1], [restart]));
  const withAdditional = deriveScheduledEvents(schedule, true, Date.parse('2026-11-06T18:30:00Z'));
  assert.equal(withAdditional.length, 2);
  assert.ok(withAdditional.some(event => event.interval === 'Every 4 hours (UTC)'));
  assert.ok(withAdditional.some(event => event.interval === 'Daily at 01:00 UTC'));
});

test('duplicate intervals merge, while irregular and differently restricted schedules stay distinct', () => {
  const restart = { TaskMethodName: 'Event.GenericModule.Restart', EnabledState: 1, Order: 10 };
  const trigger = (hours, days = []) => ({ TriggerType: 'TimeIntervalTrigger', EnabledState: 1, Tasks: [restart], interval: {
    EnabledState: 1, MatchMonths: [], MatchDays: days, MatchHours: hours, MatchMinutes: [0], MatchDaysOfMonth: []
  } });
  const now = Date.parse('2026-11-06T00:01:00Z');
  assert.equal(deriveScheduledEvents({ PopulatedTriggers: [trigger([4]), trigger([4])] }, false, now).length, 1);
  assert.equal(deriveScheduledEvents({ PopulatedTriggers: [trigger([4]), trigger([9])] }, false, now).length, 2);
  assert.equal(deriveScheduledEvents({ PopulatedTriggers: [trigger([4]), trigger([8], [1])] }, false, now).length, 2);
});

test('maintenance field is absent without events and renders more than three events', () => {
  const instance = { name: 'game', available: true, ampRunning: true, appState: 'running' };
  const empty = buildInstanceEmbed({ ...instance, scheduleEvents: [] }, Date.now()).toJSON();
  assert.ok(!empty.fields.some(field => field.name === 'Scheduled maintenance'));
  const events = Array.from({ length: 5 }, (_, index) => ({ label: `Restart ${index}`, interval: 'Daily', nextAt: Date.parse('2026-11-06T04:00:00Z') + index * 60000 }));
  const populated = buildInstanceEmbed({ ...instance, scheduleEvents: events }, Date.now()).toJSON();
  const maintenance = populated.fields.filter(field => field.name === 'Scheduled maintenance').map(field => field.value).join('\n');
  for (const event of events) assert.ok(maintenance.includes(event.label));
  const many = Array.from({ length: 100 }, (_, index) => ({ label: `Restart ${index}`, interval: 'Daily', nextAt: Date.parse('2026-11-06T04:00:00Z') }));
  const large = buildInstanceEmbed({ ...instance, scheduleEvents: many }, Date.now());
  assert.ok(large.length <= 6000);
  assert.ok(large.toJSON().fields.length <= 25);
  assert.match(JSON.stringify(large.toJSON().fields), /more schedules/);
});