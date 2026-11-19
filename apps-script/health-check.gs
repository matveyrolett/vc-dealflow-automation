/**
 * =====================================================================
 * DAILY HEALTH CHECK
 * =====================================================================
 * An automation that fails quietly is worse than none. This runs once a
 * day and emails CONFIG.HEALTH_ALERT_EMAIL only when something needs a
 * human:
 *   - a required trigger is missing (the intake has silently stopped)
 *   - emails stuck in NEEDS REVIEW (bad routing line, never re-sent)
 *   - ERROR rows (the script crashed on an email)
 *   - DocSend conversions pending for too long, or FAILED / BLOCKED
 * Checkpoint file ages from the agent routines are included as context.
 *
 * The checks themselves live in buildHealthReport_(), a pure function
 * with no Google services, so they are unit-tested (see tests.gs).
 *
 * SETUP: run setupHealthCheckTrigger() once.
 * =====================================================================
 */

const HEALTH_CHECK_FUNCTION_NAME = 'runHealthCheck';
const HEALTH_CHECK_HOUR = 8;               // daily, around 08:00 script time
const HEALTH_LOOKBACK_DAYS = 7;            // how far back to look for problems
const HEALTH_PENDING_MAX_HOURS = 6;        // a conversion pending longer than this is stuck
const HEALTH_CHECKPOINT_FILES = [
  'notion-pipeline-checkpoint.txt',
  'meeting-notes-checkpoint.txt',
  'dataroom-checkpoint.txt'
];

/** Creates the daily trigger. Safe to run more than once. */
function setupHealthCheckTrigger() {
  const exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === HEALTH_CHECK_FUNCTION_NAME;
  });
  if (exists) {
    Logger.log('Health check trigger already exists.');
    return;
  }
  ScriptApp.newTrigger(HEALTH_CHECK_FUNCTION_NAME)
    .timeBased()
    .everyDays(1)
    .atHour(HEALTH_CHECK_HOUR)
    .create();
  Logger.log('Health check trigger created (daily, ~' + HEALTH_CHECK_HOUR + ':00).');
}

/**
 * Entry point. Gathers data from Google services, builds the report,
 * emails it if anything needs attention, and always logs it.
 */
function runHealthCheck() {
  const data = {
    triggerHandlers: ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }),
    docsendEnabled: CONFIG.ENABLE_DOCSEND_CONVERSION,
    logRows: [],
    pendingRows: [],
    checkpoints: []
  };

  FUND_KEYS.forEach(function (fundKey) {
    const logSheet = getOrCreateLogSpreadsheet_(fundKey);
    if (logSheet.getLastRow() > 1) {
      logSheet.getRange(2, 1, logSheet.getLastRow() - 1, LOG_HEADERS.length).getValues()
        .forEach(function (row) { data.logRows.push(row); });
    }
    const pendingSheet = getOrCreatePendingConversionsSheet_(fundKey);
    if (pendingSheet.getLastRow() > 1) {
      pendingSheet.getRange(2, 1, pendingSheet.getLastRow() - 1, PENDING_HEADERS.length).getValues()
        .forEach(function (row) { data.pendingRows.push(row); });
    }
  });

  HEALTH_CHECKPOINT_FILES.forEach(function (name) {
    const files = DriveApp.getFilesByName(name);
    data.checkpoints.push(files.hasNext()
      ? { name: name, lastUpdated: files.next().getLastUpdated() }
      : { name: name, lastUpdated: null });
  });

  const report = buildHealthReport_(data, new Date());
  Logger.log(report.text);

  if (report.issues.length > 0 && CONFIG.HEALTH_ALERT_EMAIL) {
    MailApp.sendEmail({
      to: CONFIG.HEALTH_ALERT_EMAIL,
      subject: 'Deal-flow automation: ' + report.issues.length + ' issue(s) need attention',
      body: report.text
    });
  }
  return report;
}

/**
 * PURE FUNCTION — no Google services, fully unit-tested.
 *
 * data = {
 *   triggerHandlers: ['processNewDeals', ...],
 *   docsendEnabled:  true,
 *   logRows:         rows in LOG_HEADERS order (both funds; duplicates allowed),
 *   pendingRows:     rows in PENDING_HEADERS order,
 *   checkpoints:     [{ name, lastUpdated: Date|null }]
 * }
 * Returns { issues: [string], info: [string], text: string }.
 */
function buildHealthReport_(data, now) {
  const issues = [];
  const info = [];
  const lookbackStart = new Date(now.getTime() - HEALTH_LOOKBACK_DAYS * 24 * 3600 * 1000);

  // 1. Triggers. A missing trigger means the automation has stopped.
  const handlers = data.triggerHandlers || [];
  if (handlers.indexOf(TRIGGER_FUNCTION_NAME) === -1) {
    issues.push('The ' + TRIGGER_FUNCTION_NAME + ' trigger is missing, so no new emails are being processed. Run setupTrigger().');
  }
  if (data.docsendEnabled && handlers.indexOf(CHECK_CONVERSIONS_TRIGGER_FUNCTION_NAME) === -1) {
    issues.push('The ' + CHECK_CONVERSIONS_TRIGGER_FUNCTION_NAME + ' trigger is missing, so DocSend conversions are never collected. Run setupTrigger().');
  }

  // 2 + 3. NEEDS REVIEW and ERROR rows. These are copied into BOTH fund
  // logs, so de-duplicate by Message ID (or Thread ID for crashes).
  const seen = {};
  const needsReview = [];
  const errors = [];
  let processedRecently = 0;

  (data.logRows || []).forEach(function (row) {
    const when = parseLogTimestamp_(row[COL_TIMESTAMP]);
    if (!when || when < lookbackStart) return;

    const status = String(row[COL_STATUS] || '');
    if (status === 'PROCESSED') { processedRecently++; return; }

    const key = status + '|' + (row[COL_MESSAGE_ID] || row[COL_THREAD_ID] || when.getTime());
    if (seen[key]) return;
    seen[key] = true;

    const subject = row[5] || '(no subject)';
    const note = row[14] || '';
    if (status === 'NEEDS REVIEW') needsReview.push('"' + subject + '": ' + note);
    if (status === 'ERROR') errors.push(note || '(no details)');
  });

  if (needsReview.length > 0) {
    issues.push(needsReview.length + ' email(s) need a corrected routing line and a re-forward:\n  - ' +
      needsReview.join('\n  - '));
  }
  if (errors.length > 0) {
    issues.push(errors.length + ' email(s) crashed the intake script:\n  - ' + errors.join('\n  - '));
  }

  // 4. DocSend conversions.
  const stuck = [];
  const failed = [];
  (data.pendingRows || []).forEach(function (row) {
    const status = String(row[PENDING_COL.STATUS - 1] || '');
    const name = row[PENDING_COL.SUGGESTED_FILENAME - 1] || '(unnamed)';
    const submitted = parseLogTimestamp_(row[PENDING_COL.SUBMITTED_AT - 1]);
    if (status === 'PENDING' && submitted &&
        now.getTime() - submitted.getTime() > HEALTH_PENDING_MAX_HOURS * 3600 * 1000) {
      stuck.push(name);
    }
    if ((status === 'FAILED' || status === 'BLOCKED' || status === 'ERROR') && submitted && submitted >= lookbackStart) {
      failed.push(name + ' (' + status + ')');
    }
  });
  if (stuck.length > 0) {
    issues.push(stuck.length + ' DocSend conversion(s) pending for over ' + HEALTH_PENDING_MAX_HOURS + 'h: ' + stuck.join(', '));
  }
  if (failed.length > 0) {
    issues.push(failed.length + ' DocSend link(s) need downloading by hand: ' + failed.join(', '));
  }

  // Context, not alerts: activity and checkpoint ages.
  info.push(processedRecently + ' deal(s) processed in the last ' + HEALTH_LOOKBACK_DAYS + ' days.');
  (data.checkpoints || []).forEach(function (cp) {
    if (!cp.lastUpdated) {
      info.push(cp.name + ': not created yet.');
    } else {
      const days = Math.floor((now.getTime() - cp.lastUpdated.getTime()) / (24 * 3600 * 1000));
      info.push(cp.name + ': last updated ' + days + ' day(s) ago.');
    }
  });

  const text = (issues.length === 0
    ? 'All checks passed.'
    : 'ISSUES\n' + issues.map(function (i, n) { return (n + 1) + '. ' + i; }).join('\n')) +
    '\n\nCONTEXT\n' + info.map(function (i) { return '- ' + i; }).join('\n');

  return { issues: issues, info: info, text: text };
}

/**
 * Sheets hands back timestamps either as Date objects or as the
 * 'yyyy-MM-dd HH:mm:ss' strings the intake writes. Accept both.
 */
function parseLogTimestamp_(value) {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}
