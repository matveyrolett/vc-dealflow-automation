/**
 * =====================================================================
 * VC DEAL FLOW EMAIL INTAKE AUTOMATION
 * =====================================================================
 * Native Google Apps Script only. No external APIs except the optional
 * DocSend-to-PDF conversion service.
 *
 * Settings live in config.example.gs (CONFIG).
 *
 * SETUP ORDER:
 *   1. Fill in the placeholders in config.example.gs.
 *   2. Run validateConfiguration() — confirms the folder IDs work.
 *   3. Run initializeDealLog()     — creates "Deal Flow Log - FUND1" and
 *                                    "Deal Flow Log - FUND2" (each with a
 *                                    "Processed Deals" tab).
 *   4. Run migrateOldDealLog()     — OPTIONAL, ONE TIME: copies every row
 *                                    of an old single log into the two
 *                                    new logs. Safe to run again.
 *   5. Run testRoutingParser()     — checks the routing-line parser.
 *   6. Run testProcessLatestDeal() — tests against one real email.
 *   7. Run setupTrigger()          — turns on the 5-minute automatic check.
 *
 * LOGS: one Deal Flow Log per fund. A deal routed to FUND1 is logged
 * only in the FUND1 log, FUND2 only in the FUND2 log. Anything without
 * a valid routing line (NEEDS REVIEW) or that crashed before the fund
 * was known (ERROR) is copied into BOTH logs, so each fund can see
 * every email that did not get through.
 *
 * ROUTING LINE (first line of the email body):
 *   FUND1 | Deal Name                              <- no source marker
 *   FUND1 | Deal Name | N: Jane Doe (Example Labs) <- Network + referrer
 *   FUND1 | Deal Name | T: Alex                    <- Team (teammate's own relationship)
 *   FUND1 | Deal Name | I                          <- Inbound (cold, nobody in between)
 *   FUND1 | Deal Name | E: TechConf Berlin         <- Event + event name
 *   FUND1 | Deal Name | O                          <- Outbound (we reached out)
 * Case and spacing never matter; | : / and - all work as separators.
 * =====================================================================
 */

// Internal constants for DocSend conversion tracking.
const PENDING_CONVERSIONS_SHEET_NAME = 'Pending Docsend Conversions';
const PENDING_HEADERS = [
  'Task ID', 'Deal Folder ID', 'Deal Name', 'Fund', 'Docsend URL',
  'Suggested Filename', 'Submitted At', 'Last Checked', 'Attempts', 'Status', 'Notes'
];
const PENDING_COL = {
  TASK_ID: 1, DEAL_FOLDER_ID: 2, DEAL_NAME: 3, FUND: 4, DOCSEND_URL: 5,
  SUGGESTED_FILENAME: 6, SUBMITTED_AT: 7, LAST_CHECKED: 8, ATTEMPTS: 9, STATUS: 10, NOTES: 11
};
// Give up after this many 1-minute checks (~5 hours) so a permanently
// stuck conversion doesn't sit "pending" forever.
const MAX_CONVERSION_ATTEMPTS = 300;
const CHECK_CONVERSIONS_TRIGGER_FUNCTION_NAME = 'checkPendingDocsendConversions';
const CHECK_CONVERSIONS_INTERVAL_MINUTES = 1;

// Internal constants.
const LOG_SPREADSHEET_NAME = 'Deal Flow Log';          // name of the OLD single log
const LOG_SHEET_NAME = 'Processed Deals';
const FUND_KEYS = ['FUND1', 'FUND2'];
const DOCUMENTS_SUBFOLDER_NAME = 'Documents';
const TRIGGER_FUNCTION_NAME = 'processNewDeals';
const TRIGGER_INTERVAL_MINUTES = 5;

// The six Source columns are appended at the END, so earlier column
// positions (and any downstream CSV reader) are unaffected.
const LOG_HEADERS = [
  'Timestamp', 'Status', 'Fund', 'Deal Name', 'Sender', 'Subject',
  'Email Date', 'Message ID', 'Thread ID', 'Drive Folder ID',
  'Drive Folder URL', 'Email Doc ID', 'Email Doc URL',
  'Attachment Count', 'Error / Notes',
  'Source Code', 'Source Detail', 'Forwarded By', 'Original Sender',
  'Forward Chain', 'Source Hints'
];
// Column indices (0-based) into LOG_HEADERS, used when re-reading the log.
const COL_TIMESTAMP = 0;
const COL_STATUS = 1;
const COL_FUND = 2;
const COL_MESSAGE_ID = 7;
const COL_THREAD_ID = 8;

// Source codes and every spelling a forwarder might type (case never matters).
// "Internal" is deliberately NOT accepted: it is ambiguous (it could just
// mean a teammate forwarded it), so it is flagged with a hint to use T.
const SOURCE_CODES = { N: 'Network', T: 'Team', I: 'Inbound', E: 'Event', O: 'Outbound' };
const SOURCE_ALIASES = {
  N: 'N', NW: 'N', NET: 'N', NETWORK: 'N', INTRO: 'N', REF: 'N', REFERRAL: 'N', WARM: 'N',
  T: 'T', TEAM: 'T',
  I: 'I', INBOUND: 'I', COLD: 'I',
  E: 'E', EVENT: 'E',
  O: 'O', OUTBOUND: 'O'
};
// Longest first, so "NETWORK" wins over "NET" and "N", "INTRO" over "I".
const SOURCE_TOKEN_PATTERN = Object.keys(SOURCE_ALIASES)
  .sort(function (a, b) { return b.length - a.length; })
  .join('|');

// Per-execution cache of each fund's "Processed Deals" sheet.
const logSheetCache_ = {};

// =====================================================================
// SETUP / MAINTENANCE ENTRY POINTS
// =====================================================================

/**
 * Confirms every configured folder ID exists and is accessible.
 */
function validateConfiguration() {
  let allValid = true;

  function checkFolder(label, id) {
    if (!id || /^PASTE_/.test(id)) {
      Logger.log('[MISSING] ' + label + ' is not set.');
      allValid = false;
      return null;
    }
    try {
      const folder = DriveApp.getFolderById(id);
      Logger.log('[OK] ' + label + ' -> "' + folder.getName() + '"');
      return folder;
    } catch (err) {
      Logger.log('[INVALID] ' + label + ' (' + id + ') could not be opened: ' + err);
      allValid = false;
      return null;
    }
  }

  const fund1Folder = checkFolder('FUND1_FOLDER_ID', CONFIG.FUND1_FOLDER_ID);
  const fund2Folder = checkFolder('FUND2_FOLDER_ID', CONFIG.FUND2_FOLDER_ID);
  checkFolder('FUND1_LOG_FOLDER_ID', CONFIG.FUND1_LOG_FOLDER_ID);
  checkFolder('FUND2_LOG_FOLDER_ID', CONFIG.FUND2_LOG_FOLDER_ID);

  if (CONFIG.ROOT_FOLDER_ID) {
    const rootFolder = checkFolder('ROOT_FOLDER_ID', CONFIG.ROOT_FOLDER_ID);
    if (rootFolder && fund1Folder && !isFolderInsideParent_(fund1Folder, rootFolder)) {
      Logger.log('[WARNING] FUND1_FOLDER_ID does not appear to be located inside ROOT_FOLDER_ID.');
    }
    if (rootFolder && fund2Folder && !isFolderInsideParent_(fund2Folder, rootFolder)) {
      Logger.log('[WARNING] FUND2_FOLDER_ID does not appear to be located inside ROOT_FOLDER_ID.');
    }
  } else {
    Logger.log('[INFO] ROOT_FOLDER_ID is blank, skipping the "inside root" check.');
  }

  if (!CONFIG.MAIN_DEAL_EMAIL) {
    Logger.log('[MISSING] MAIN_DEAL_EMAIL is not set.');
    allValid = false;
  }

  Logger.log('[INFO] Source tracking is on for: ' +
    ((CONFIG.SOURCE_TRACKING_FUNDS || []).join(', ') || '(no funds)'));

  Logger.log(allValid ? 'All required configuration values look valid.' : 'One or more configuration values need attention — see above.');
}

function isFolderInsideParent_(folder, expectedParent) {
  const parents = folder.getParents();
  while (parents.hasNext()) {
    const parent = parents.next();
    if (parent.getId() === expectedParent.getId()) {
      return true;
    }
  }
  return false;
}

/**
 * Creates "Deal Flow Log - FUND1" and "Deal Flow Log - FUND2" (each with
 * a "Processed Deals" tab) if they don't already exist. Safe to run
 * multiple times.
 */
function initializeDealLog() {
  FUND_KEYS.forEach(function (fundKey) {
    const sheet = getOrCreateLogSpreadsheet_(fundKey);
    Logger.log(fundKey + ' Deal Flow Log is ready: ' + sheet.getParent().getUrl());
  });
}

/**
 * ONE-TIME MIGRATION. Copies every row of an old single "Deal Flow Log"
 * into the two per-fund logs:
 *   - Fund = FUND1  -> FUND1 log
 *   - Fund = FUND2  -> FUND2 log
 *   - anything else (NEEDS REVIEW, ERROR, blank) -> BOTH logs
 * Does the same for the "Pending Docsend Conversions" tab.
 * Timestamps are copied unchanged, so downstream checkpoints keep
 * working. Safe to run again: rows already present are skipped.
 */
function migrateOldDealLog() {
  const oldFolder = DriveApp.getFolderById(CONFIG.OLD_DEAL_LOG_FOLDER_ID);
  const files = oldFolder.getFilesByName(LOG_SPREADSHEET_NAME);
  if (!files.hasNext()) {
    Logger.log('No old "' + LOG_SPREADSHEET_NAME + '" found in OLD_DEAL_LOG_FOLDER_ID. Nothing to migrate.');
    return;
  }
  const oldSpreadsheet = SpreadsheetApp.open(files.next());

  // --- Processed Deals ---
  const oldLog = oldSpreadsheet.getSheetByName(LOG_SHEET_NAME);
  if (oldLog && oldLog.getLastRow() > 1) {
    const rows = oldLog.getRange(2, 1, oldLog.getLastRow() - 1, LOG_HEADERS.length).getValues();
    const result = migrateRows_(rows, COL_FUND, LOG_HEADERS.length, function (fundKey) {
      return getOrCreateLogSpreadsheet_(fundKey);
    }, function (row) {
      return [String(row[COL_TIMESTAMP]), row[COL_STATUS], row[COL_MESSAGE_ID], row[COL_THREAD_ID]].join('|');
    });
    Logger.log('Processed Deals: ' + JSON.stringify(result));
  } else {
    Logger.log('Old "' + LOG_SHEET_NAME + '" tab is empty or missing.');
  }

  // --- Pending Docsend Conversions ---
  const oldPending = oldSpreadsheet.getSheetByName(PENDING_CONVERSIONS_SHEET_NAME);
  if (oldPending && oldPending.getLastRow() > 1) {
    const rows = oldPending.getRange(2, 1, oldPending.getLastRow() - 1, PENDING_HEADERS.length).getValues();
    const result = migrateRows_(rows, PENDING_COL.FUND - 1, PENDING_HEADERS.length, function (fundKey) {
      return getOrCreatePendingConversionsSheet_(fundKey);
    }, function (row) {
      return String(row[PENDING_COL.TASK_ID - 1]);
    });
    Logger.log('Pending Docsend Conversions: ' + JSON.stringify(result));
  }

  Logger.log('Migration finished. The old log was not changed. Once you have checked the new logs, ' +
    'rename or archive the old one.');
}

function migrateRows_(rows, fundColIndex, width, getTargetSheet, keyOf) {
  const toWrite = {};
  const existingKeys = {};
  const counts = {};

  FUND_KEYS.forEach(function (fundKey) {
    toWrite[fundKey] = [];
    counts[fundKey] = { copied: 0, alreadyThere: 0 };
    existingKeys[fundKey] = {};
    const sheet = getTargetSheet(fundKey);
    if (sheet.getLastRow() > 1) {
      sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues().forEach(function (r) {
        existingKeys[fundKey][keyOf(r)] = true;
      });
    }
  });

  rows.forEach(function (row) {
    if (row.join('') === '') return; // blank row
    const fund = String(row[fundColIndex] || '').trim().toUpperCase();
    const targets = FUND_KEYS.indexOf(fund) !== -1 ? [fund] : FUND_KEYS;
    const key = keyOf(row);
    targets.forEach(function (fundKey) {
      if (existingKeys[fundKey][key]) {
        counts[fundKey].alreadyThere++;
        return;
      }
      existingKeys[fundKey][key] = true;
      toWrite[fundKey].push(row);
      counts[fundKey].copied++;
    });
  });

  FUND_KEYS.forEach(function (fundKey) {
    const newRows = toWrite[fundKey];
    if (newRows.length === 0) return;
    const sheet = getTargetSheet(fundKey);
    const startRow = sheet.getLastRow() + 1;
    const neededRows = startRow + newRows.length - 1;
    if (sheet.getMaxRows() < neededRows) {
      sheet.insertRowsAfter(sheet.getMaxRows(), neededRows - sheet.getMaxRows());
    }
    if (sheet.getMaxColumns() < width) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
    }
    sheet.getRange(startRow, 1, newRows.length, width).setValues(newRows);
    // Keep the log in time order (old rows first, then anything newer).
    if (sheet.getLastRow() > 2) {
      sheet.getRange(2, 1, sheet.getLastRow() - 1, width).sort(1);
    }
  });

  return counts;
}

/**
 * Creates the 5-minute trigger for processNewDeals, and — if DocSend
 * conversion is enabled — a 1-minute trigger for checking on pending
 * conversions. Safe to run more than once; never creates duplicates.
 */
function setupTrigger() {
  createTriggerIfMissing_(TRIGGER_FUNCTION_NAME, TRIGGER_INTERVAL_MINUTES);

  if (CONFIG.ENABLE_DOCSEND_CONVERSION) {
    createTriggerIfMissing_(CHECK_CONVERSIONS_TRIGGER_FUNCTION_NAME, CHECK_CONVERSIONS_INTERVAL_MINUTES);
  }
}

function createTriggerIfMissing_(handlerName, intervalMinutes) {
  const existing = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === handlerName;
  });

  if (existing.length > 0) {
    Logger.log('Trigger for ' + handlerName + ' already exists. Skipping creation.');
    return;
  }

  ScriptApp.newTrigger(handlerName)
    .timeBased()
    .everyMinutes(intervalMinutes)
    .create();

  Logger.log('Trigger created: ' + handlerName + ' every ' + intervalMinutes + ' minutes.');
}

/**
 * Removes both triggers. Use this to pause the automation.
 */
function deleteTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  let deleted = 0;
  triggers.forEach(function (t) {
    const handler = t.getHandlerFunction();
    if (handler === TRIGGER_FUNCTION_NAME || handler === CHECK_CONVERSIONS_TRIGGER_FUNCTION_NAME) {
      ScriptApp.deleteTrigger(t);
      deleted++;
    }
  });
  Logger.log('Deleted ' + deleted + ' trigger(s).');
}

// =====================================================================
// MAIN ENTRY POINTS
// =====================================================================

/**
 * Main processing loop. Safe to run manually or via trigger.
 */
function processNewDeals() {
  // Only one run at a time. If another run is still busy, this one
  // skips; the next 5-minute run picks up anything left.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log('Another run is still in progress. Skipping this run.');
    return;
  }
  try {
    processNewDealsLocked_();
  } finally {
    lock.releaseLock();
  }
}

function processNewDealsLocked_() {
  ensureProcessedLabel_();
  const loggedStatuses = getLoggedMessageStatuses_();
  const threads = findUnprocessedMessages_(CONFIG.MAX_EMAILS_PER_RUN);

  Logger.log('Found ' + threads.length + ' candidate thread(s).');

  threads.forEach(function (thread) {
    try {
      processThread_(thread, loggedStatuses);
    } catch (err) {
      Logger.log('Unhandled error on thread ' + thread.getId() + ': ' + err);
      try {
        // Fund is blank here, so this row goes into BOTH logs.
        logProcessedDeal_({
          status: 'ERROR',
          fund: '', dealName: '', sender: '', subject: '', emailDate: '',
          messageId: '', threadId: thread.getId(),
          folderId: '', folderUrl: '', docId: '', docUrl: '', attachmentCount: '',
          notes: 'Unhandled exception: ' + err
        });
      } catch (logErr) {
        Logger.log('Also failed to log the error: ' + logErr);
      }
    }
  });
}

/**
 * Manually test against only the single most recent unprocessed email.
 */
function testProcessLatestDeal() {
  ensureProcessedLabel_();
  const loggedStatuses = getLoggedMessageStatuses_();
  const threads = findUnprocessedMessages_(1);

  if (threads.length === 0) {
    Logger.log('No unprocessed emails found to test with.');
    return;
  }

  Logger.log('Testing against thread: ' + threads[0].getId());
  try {
    processThread_(threads[0], loggedStatuses);
    Logger.log('Test complete. Check the Deal Flow Logs and Drive for results.');
  } catch (err) {
    Logger.log('Test failed with error: ' + err);
  }
}

// =====================================================================
// GMAIL SEARCH / LABELING
// =====================================================================

function ensureProcessedLabel_() {
  let label = GmailApp.getUserLabelByName(CONFIG.PROCESSED_LABEL);
  if (!label) {
    label = GmailApp.createLabel(CONFIG.PROCESSED_LABEL);
    Logger.log('Created Gmail label: ' + CONFIG.PROCESSED_LABEL);
  }
  return label;
}

function findUnprocessedMessages_(maxResults) {
  // Deliberately NOT filtered by "FUND1"/"FUND2" text — a typo
  // (e.g. "FUND I", "Fund-1") must still surface as NEEDS REVIEW rather
  // than being silently invisible to the script.
  // It IS filtered by sender (CONFIG.ALLOWED_SENDERS).
  const senderClause = (CONFIG.ALLOWED_SENDERS && CONFIG.ALLOWED_SENDERS.length > 0)
    ? ' (' + CONFIG.ALLOWED_SENDERS.map(function (addr) { return 'from:' + addr; }).join(' OR ') + ')'
    : '';
  const query = 'in:inbox -label:' + CONFIG.PROCESSED_LABEL + senderClause;
  return GmailApp.search(query, 0, maxResults);
}

function applyProcessedLabel_(thread) {
  const label = ensureProcessedLabel_();
  thread.addLabel(label);
}

/**
 * Reads BOTH fund logs and returns a map of messageId -> logged status
 * (PROCESSED wins if a message appears in both). This is what stops an
 * email that keeps failing from being re-logged every single run.
 */
function getLoggedMessageStatuses_() {
  const statusByMessageId = {};

  FUND_KEYS.forEach(function (fundKey) {
    const sheet = getOrCreateLogSpreadsheet_(fundKey);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    const values = sheet.getRange(2, 1, lastRow - 1, LOG_HEADERS.length).getValues();
    values.forEach(function (row) {
      const messageId = row[COL_MESSAGE_ID];
      if (!messageId) return;
      if (statusByMessageId[messageId] === 'PROCESSED') return;
      statusByMessageId[messageId] = row[COL_STATUS];
    });
  });

  return statusByMessageId;
}

// =====================================================================
// THREAD / EMAIL PROCESSING
// =====================================================================

function processThread_(thread, loggedStatuses) {
  const messages = thread.getMessages();
  const message = messages[messages.length - 1]; // most recent message in thread
  const messageId = message.getId();

  const priorStatus = loggedStatuses[messageId];
  if (priorStatus) {
    if (priorStatus === 'PROCESSED') {
      applyProcessedLabel_(thread);
    }
    Logger.log('Message ' + messageId + ' already logged as ' + priorStatus + '. Skipping (no duplicate row created).');
    return;
  }

  const rawBody = stripInvisibleCharacters_(message.getPlainBody());
  const routing = parseRoutingInstruction_(rawBody);

  const baseLogFields = {
    sender: message.getFrom(),
    subject: message.getSubject(),
    emailDate: Utilities.formatDate(message.getDate(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'),
    messageId: messageId,
    threadId: thread.getId()
  };

  if (!routing.valid) {
    // Fund is blank, so this NEEDS REVIEW row goes into BOTH logs.
    logProcessedDeal_(Object.assign({}, baseLogFields, {
      status: 'NEEDS REVIEW',
      fund: '', dealName: '',
      folderId: '', folderUrl: '', docId: '', docUrl: '', attachmentCount: '',
      notes: routing.error
    }));
    Logger.log('Thread ' + thread.getId() + ' needs review: ' + routing.error);
    return; // do NOT mark processed
  }

  const fundKey = routing.fundKey; // 'FUND1' or 'FUND2'
  const dealName = routing.dealName;

  const fundFolderId = fundKey === 'FUND1' ? CONFIG.FUND1_FOLDER_ID : CONFIG.FUND2_FOLDER_ID;
  const fundFolder = DriveApp.getFolderById(fundFolderId);

  const conflictNote = checkOtherFundConflict_(dealName, fundKey);

  const dealFolder = getOrCreateDealFolder_(fundFolder, dealName);

  const forwardChain = extractForwardChain_(rawBody);
  const forwardedMeta = forwardChain.length > 0 ? forwardChain[0] : null;
  const cleanedBody = buildCleanedBody_(rawBody, routing.rawLine, forwardedMeta);

  const sourceInfo = isSourceTrackingEnabled_(fundKey)
    ? buildSourceInfo_(message, routing, forwardChain, cleanedBody)
    : null;

  const emailDocResult = createEmailDocument_(dealFolder, dealName, fundKey, message, forwardedMeta, cleanedBody, sourceInfo);

  const attachments = collectThreadAttachments_(messages);
  const htmlBody = message.getBody();
  const driveLinkedFileIds = extractDriveLinkedFileIds_(htmlBody);
  const driveLinkedFolderIds = extractDriveLinkedFolderIds_(htmlBody);
  const docsendLinks = CONFIG.ENABLE_DOCSEND_CONVERSION ? extractDocsendLinks_(cleanedBody, htmlBody) : [];

  let attachmentCount = 0;
  const noteParts = [];

  const hasAnyFiles = attachments.length > 0 || driveLinkedFileIds.length > 0 ||
    driveLinkedFolderIds.length > 0 || docsendLinks.length > 0;

  if (hasAnyFiles) {
    const documentsFolder = getOrCreateDocumentsFolder_(dealFolder);

    if (attachments.length > 0) {
      attachmentCount += saveAttachments_(attachments, documentsFolder);
    }

    if (driveLinkedFileIds.length > 0) {
      const driveLinkResult = saveDriveLinkedFiles_(driveLinkedFileIds, documentsFolder);
      attachmentCount += driveLinkResult.savedCount;
      driveLinkResult.notes.forEach(function (n) { noteParts.push(n); });
    }

    if (driveLinkedFolderIds.length > 0) {
      const driveFolderResult = saveDriveLinkedFolderFiles_(driveLinkedFolderIds, documentsFolder);
      attachmentCount += driveFolderResult.savedCount;
      driveFolderResult.notes.forEach(function (n) { noteParts.push(n); });
    }

    if (docsendLinks.length > 0) {
      const docsendResult = queueDocsendConversionsForLinks_(docsendLinks, documentsFolder, dealFolder, dealName, fundKey);
      attachmentCount += docsendResult.savedCount;
      docsendResult.notes.forEach(function (n) { noteParts.push(n); });
    }
  }

  if (sourceInfo && sourceInfo.note) {
    noteParts.push(sourceInfo.note);
  }
  if (conflictNote) {
    noteParts.unshift(conflictNote);
  }
  const combinedNotes = noteParts.join(' ');

  logProcessedDeal_(Object.assign({}, baseLogFields, {
    status: 'PROCESSED',
    fund: fundKey,
    dealName: dealName,
    folderId: dealFolder.getId(),
    folderUrl: dealFolder.getUrl(),
    docId: emailDocResult.docId,
    docUrl: emailDocResult.docUrl,
    attachmentCount: attachmentCount,
    notes: combinedNotes
  }, sourceLogFields_(sourceInfo)));

  applyProcessedLabel_(thread);
  Logger.log('Processed deal "' + dealName + '" for ' + fundKey + '. Folder: ' + dealFolder.getUrl());
}

// =====================================================================
// ROUTING LINE PARSING
// =====================================================================

/**
 * Removes invisible/zero-width characters that some external tools
 * silently insert into email bodies.
 */
function stripInvisibleCharacters_(text) {
  if (!text) return text;
  return text.replace(/[\u200B\u200C\u200D\u200E\u200F\uFEFF\u2060\u180E]/g, '');
}

/**
 * Looks at the first non-blank line of the email body for:
 *   FUND1 | Deal Name   or   FUND2 | Deal Name
 * optionally followed by a source marker:
 *   FUND1 | Deal Name | N: Jane Doe (Example Labs)
 * Tolerant of whitespace and case, and | : / as separators. The source
 * marker is read from (in this order):
 *   a) after a pipe:        FUND1 | Acme | N: Jane Doe
 *   b) after : / or - :     FUND1 | Acme : Network - Jane Doe
 *   c) a line starting with "Source" directly below the routing line:
 *                           FUND1 | Acme
 *                           Source: N Jane Doe
 */
function parseRoutingInstruction_(bodyText) {
  const lines = bodyText.split('\n');
  const nonBlank = [];
  for (let i = 0; i < lines.length && nonBlank.length < 2; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.length > 0) nonBlank.push(trimmed);
  }
  const firstLine = nonBlank[0] || null;

  if (!firstLine) {
    return { valid: false, error: 'Missing or invalid routing instruction. Expected FUND1 | Deal Name or FUND2 | Deal Name.' };
  }

  // Look-alike pipe characters some mail clients/keyboards produce.
  // Email-snippet input fields can leave { } around what was typed; ignore them.
  const normalized = firstLine.replace(/[｜¦│∣]/g, '|').replace(/[{}]/g, '');

  // Roman numerals: "FUND I" -> FUND1, "FUND II" -> FUND2.
  const normalizedRoman = normalized.replace(/^FUND\s*(II|I)(?=\s*[|:\/])/i, function (m, r) { return 'FUND' + (r.toUpperCase() === 'II' ? '2' : '1'); });

  // "FUND1"/"FUND2" (with or without a space before the number),
  // followed by a |, :, or / separator.
  const match = normalizedRoman.match(/^FUND\s*([0-9]+)\s*[|:\/]\s*(.*)$/i);
  if (!match) {
    return { valid: false, error: 'Missing or invalid routing instruction. Expected FUND1 | Deal Name or FUND2 | Deal Name.' };
  }

  const fundNumber = match[1];

  // Split "Deal Name" from an optional source marker, so the marker can
  // never end up in the deal name (folder name, Sheet, CRM card title).
  const split = splitDealAndSource_(match[2]);
  const dealName = cleanDealName_(split.deal);

  // c) Fallback: "Source: ..." on the line right under the routing line.
  let markerText = split.marker;
  if (markerText === null && nonBlank[1] && /^\W*source\b/i.test(nonBlank[1])) {
    markerText = nonBlank[1].replace(/^\W*/, '');
  }
  const source = parseSourceMarker_(markerText);

  if (fundNumber !== '1' && fundNumber !== '2') {
    return { valid: false, error: 'Invalid fund "FUND' + fundNumber + '". Only FUND1 or FUND2 are supported.' };
  }

  if (!dealName) {
    return { valid: false, error: 'Missing deal name after "FUND' + fundNumber + ' |".' };
  }

  if (looksLikePlaceholder_(dealName)) {
    return { valid: false, error: 'Deal name "' + dealName + '" looks like an unfilled snippet placeholder. Fill in the company name and forward again.' };
  }

  return {
    valid: true,
    fundKey: 'FUND' + fundNumber,
    dealName: dealName,
    source: source,
    rawLine: firstLine
  };
}

/**
 * Trims and collapses accidental repeated whitespace, but otherwise
 * leaves the company name untouched (punctuation preserved).
 */
function cleanDealName_(rawName) {
  return rawName.replace(/\s+/g, ' ').trim();
}

/**
 * True if the deal name is still an unfilled snippet placeholder,
 * e.g. "Company Name", "Startup Name", or anything with [ ].
 */
function looksLikePlaceholder_(text) {
  const t = String(text || '').trim();
  if (/[\[\]]/.test(t)) return true;
  if (/^(startup|deal|company)\s*name$/i.test(t)) return true;
  return false;
}

/**
 * Splits "Deal Name <separator> marker" into its two parts.
 * - A pipe always splits (any spacing).
 * - ":" "/" "-" only split when what follows is a real source marker,
 *   so deal names like "A/B Labs" or "Coin-Ex" are never cut.
 * - For "/" and "-", a single letter (N, T, I, E, O) only counts if there
 *   is a space around the separator AND the letter stands alone or is
 *   followed by ":" "-" or "(" — so "Nexus-O" and "Alpha - E Finance"
 *   stay deal names, while "Alpha - E: TechConf" is read as Event.
 * Returns marker = null when no marker was found at all.
 */
function splitDealAndSource_(rest) {
  const pipeIndex = rest.indexOf('|');
  if (pipeIndex !== -1) {
    return { deal: rest.substring(0, pipeIndex), marker: rest.substring(pipeIndex + 1) };
  }

  const prefix = '[\\[(]?\\s*(?:source\\s*[:=\\-–—]?\\s*)?';
  const word = '(?:' + SOURCE_TOKEN_PATTERN + ')(?![A-Za-z])';
  const letterOnly = '(?:N|T|I|E|O)\\s*(?:$|[:=\\-–—(])';
  const fullWord = '(?:NW|NET|NETWORK|INTRO|REF|REFERRAL|WARM|TEAM|INBOUND|COLD|EVENT|OUTBOUND)(?![A-Za-z])';

  // Brackets at the end: "Acme (N: Jane)", "Acme (N Jane)", "Acme [I]",
  // "Acme(T:Alex)". Only when the bracket starts with a real marker, so
  // "Acme (Germany)" stays a deal name. Nested brackets inside are fine.
  let m = rest.match(new RegExp('^(.*?\\S)\\s*[\\[(]\\s*(' + prefix.replace('[\\[(]?\\s*', '') +
    '(?:' + fullWord + '|(?:N|T|I|E|O)(?=\\s|$|[:=\\-–—(\\])]))[\\s\\S]*?)\\s*[\\])]\\s*$', 'i'));
  if (m) return { deal: m[1], marker: m[2] };

  // Colon: any spacing.
  m = rest.match(new RegExp('^(.*?\\S)\\s*:\\s*(' + prefix + word + '.*)$', 'i'));
  if (m) return { deal: m[1], marker: m[2] };

  // Slash or dash with a space on either side: full word or single letter.
  m = rest.match(new RegExp('^(.*?\\S)(?:\\s+[\\/\\-–—]\\s*|[\\/\\-–—]\\s+)(' + prefix + '(?:' + fullWord + '|' + letterOnly + ').*)$', 'i'));
  if (m) return { deal: m[1], marker: m[2] };

  // Slash or dash with no spaces ("Acme-Network"): full words only,
  // so names like "Nexus-O" or "AI/O" are never cut.
  m = rest.match(new RegExp('^(.*?\\S)[\\/\\-–—](' + prefix + fullWord + '.*)$', 'i'));
  if (m) return { deal: m[1], marker: m[2] };

  return { deal: rest, marker: null };
}

/**
 * Reads the marker text in any reasonable spelling:
 *   N | n | N: | N : | N- | N – | N=   then the referrer (also Network,
 *                                      Net, NW, Intro, Referral, Ref, Warm)
 *   T | Team                           then the teammate's name
 *   I | Inbound | Cold
 *   E | Event                          then the event name
 *   O | Outbound
 * Also tolerates a "Source:" prefix and wrapping brackets.
 * Never blocks processing: problems only produce a note in the log.
 */
function parseSourceMarker_(raw) {
  if (raw === null || raw === undefined || !String(raw).trim()) {
    return { code: '', label: '', detail: '', note: 'No source marker in routing line.' };
  }

  let text = String(raw).trim();

  // Strip a "Source:" prefix, then wrapping brackets (only as a pair).
  text = text.replace(/^source\s*[:=\-–—]?\s*/i, '');
  const bracketed = text.match(/^[\[(]\s*([\s\S]*?)\s*[\])]$/);
  if (bracketed) text = bracketed[1];
  text = text.replace(/^source\s*[:=\-–—]?\s*/i, '');

  if (!text) {
    return { code: '', label: '', detail: '', note: 'No source marker in routing line.' };
  }

  const m = text.match(new RegExp('^(' + SOURCE_TOKEN_PATTERN + ')(?![A-Za-z])\\s*[:=\\-–—|\\/]?\\s*([\\s\\S]*)$', 'i'));
  if (!m) {
    let note = 'Unrecognised source marker "' + text + '" (expected N, T, I, E or O).';
    if (/^internal/i.test(text)) {
      note = '"Internal" is ambiguous. If the founder came through a teammate\'s own relationship, use T: <name>. ' +
        'If the teammate only forwarded it, use N, I, E or O for the real origin.';
    }
    return { code: '', label: '', detail: text, note: note };
  }

  const code = SOURCE_ALIASES[m[1].toUpperCase()];
  const detail = m[2].trim();
  let note = '';
  if (code === 'N' && !detail) note = 'Source marker N has no referrer name.';
  if (code === 'T' && !detail) note = 'Source marker T has no teammate name.';
  if (code === 'E' && !detail) note = 'Source marker E has no event name.';

  return { code: code, label: SOURCE_CODES[code], detail: detail, note: note };
}

// =====================================================================
// FORWARDED-EMAIL METADATA EXTRACTION
// =====================================================================

/**
 * Returns the most recent forwarded hop, including Cc.
 */
function extractForwardedMetadata_(bodyText) {
  const chain = extractForwardChain_(bodyText);
  return chain.length > 0 ? chain[0] : null;
}

/**
 * Returns every "Forwarded message" hop in the email, newest first,
 * original sender last.
 */
function extractForwardChain_(bodyText) {
  const markerPattern = /-{2,}\s*Forwarded message\s*-{2,}/gi;
  const chain = [];
  let m;
  while ((m = markerPattern.exec(bodyText)) !== null) {
    const meta = parseForwardHeaderBlock_(bodyText.substring(m.index + m[0].length));
    if (meta) chain.push(meta);
  }
  return chain;
}

function parseForwardHeaderBlock_(textAfterMarker) {
  const lines = textAfterMarker.split('\n');
  const meta = { from: '', date: '', subject: '', to: '', cc: '' };

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (trimmed === '') {
      if (meta.from || meta.date || meta.subject || meta.to) break;
      continue;
    }

    const fromM = trimmed.match(/^From:\s*(.*)$/i);
    const dateM = trimmed.match(/^Date:\s*(.*)$/i);
    const subjM = trimmed.match(/^Subject:\s*(.*)$/i);
    const toM = trimmed.match(/^To:\s*(.*)$/i);
    const ccM = trimmed.match(/^Cc:\s*(.*)$/i);

    if (fromM) { meta.from = fromM[1].trim(); continue; }
    if (dateM) { meta.date = dateM[1].trim(); continue; }
    if (subjM) { meta.subject = subjM[1].trim(); continue; }
    if (toM) { meta.to = toM[1].trim(); continue; }
    if (ccM) { meta.cc = ccM[1].trim(); continue; }

    break; // non-header line means the header block already ended
  }

  if (!meta.from && !meta.date && !meta.subject) {
    return null;
  }
  return meta;
}

/**
 * Produces the body text to store in the Doc: routing line removed,
 * and the forwarded-header block removed if one was found.
 */
function buildCleanedBody_(rawBody, routingRawLine, forwardedMeta) {
  let body = rawBody;

  const routingIndex = body.indexOf(routingRawLine);
  if (routingIndex !== -1) {
    body = body.substring(routingIndex + routingRawLine.length);
  }

  if (forwardedMeta) {
    const markerMatch = body.match(/-{2,}\s*Forwarded message\s*-{2,}/i);
    if (markerMatch) {
      const afterMarker = body.substring(markerMatch.index + markerMatch[0].length);
      const lines = afterMarker.split('\n');
      let i = 0;
      let sawHeader = false;
      for (; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed === '') {
          if (sawHeader) { i++; break; }
          continue;
        }
        // Cc must be listed too, or a Cc line ends the header early and
        // leaks into the stored body (regression-tested in tests.gs).
        if (/^(From|Date|Subject|To|Cc):/i.test(trimmed)) { sawHeader = true; continue; }
        break;
      }
      body = lines.slice(i).join('\n');
    }
  }

  return body.trim();
}

// =====================================================================
// SOURCE TRACKING
// =====================================================================

function isSourceTrackingEnabled_(fundKey) {
  return (CONFIG.SOURCE_TRACKING_FUNDS || []).indexOf(fundKey) !== -1;
}

/**
 * Collects the source evidence for the downstream intake skill. The
 * marker is the forwarder's decision. Hints are evidence only, never a
 * classification.
 */
function buildSourceInfo_(message, routing, chain, cleanedBody) {
  const forwardedBy = message.getFrom();
  const original = chain.length > 0 ? chain[chain.length - 1] : null;

  // Path from the original sender to the deal inbox.
  const hops = chain.slice().reverse().map(function (hop) { return hop.from; });
  hops.push(forwardedBy);
  hops.push(CONFIG.MAIN_DEAL_EMAIL);
  const forwardChain = hops.filter(function (h) { return h; }).join(' → ');

  const hints = [];
  if (!original) {
    hints.push('No forwarded header found, so the original sender is not visible.');
  } else {
    const recipients = ((original.to || '') + ' ' + (original.cc || '')).toLowerCase();
    const publicHit = (CONFIG.PUBLIC_INBOXES || []).filter(function (addr) {
      return recipients.indexOf(addr.toLowerCase()) !== -1;
    });
    if (publicHit.length > 0) {
      hints.push('Original email was addressed to ' + publicHit.join(', ') + ' (consistent with Inbound).');
    }
    if (original.cc) {
      hints.push('Original email had Cc: ' + original.cc + ' (check whether this is an introduction).');
    }
  }
  if (/\b(intro|introduc\w*|referr\w*|connect(ing)? you|put you in touch)\b/i.test(cleanedBody)) {
    hints.push('Body contains introduction/referral wording.');
  }
  if (/\b(telegram|whatsapp|linkedin)\b/i.test(cleanedBody)) {
    hints.push('Body mentions Telegram/WhatsApp/LinkedIn.');
  }
  if (chain.length > 1) {
    hints.push('Forwarded through ' + chain.length + ' hops; the original sender is the first name in the chain.');
  }

  return {
    code: routing.source.code,
    label: routing.source.label,
    detail: routing.source.detail,
    note: routing.source.note,
    forwardedBy: forwardedBy,
    originalSender: original ? original.from : '',
    originalTo: original ? original.to : '',
    originalCc: original ? original.cc : '',
    forwardChain: forwardChain,
    hints: hints.join(' ')
  };
}

/** Log fields for the six Source columns (empty when tracking is off). */
function sourceLogFields_(sourceInfo) {
  if (!sourceInfo) return {};
  return {
    sourceCode: sourceInfo.code,
    sourceDetail: sourceInfo.detail,
    forwardedBy: sourceInfo.forwardedBy,
    originalSender: sourceInfo.originalSender,
    forwardChain: sourceInfo.forwardChain,
    sourceHints: sourceInfo.hints
  };
}

// =====================================================================
// DRIVE FOLDER MANAGEMENT
// =====================================================================

function getOrCreateDealFolder_(fundFolder, dealName) {
  const existing = fundFolder.getFoldersByName(dealName);
  if (existing.hasNext()) {
    return existing.next();
  }
  return fundFolder.createFolder(dealName);
}

function getOrCreateDocumentsFolder_(dealFolder) {
  const existing = dealFolder.getFoldersByName(DOCUMENTS_SUBFOLDER_NAME);
  if (existing.hasNext()) {
    return existing.next();
  }
  return dealFolder.createFolder(DOCUMENTS_SUBFOLDER_NAME);
}

/**
 * If the same deal name already exists under the *other* fund, this
 * does not block processing — the explicit routing wins — it just
 * returns a warning to record in the log.
 */
function checkOtherFundConflict_(dealName, currentFundKey) {
  const otherFundFolderId = currentFundKey === 'FUND1' ? CONFIG.FUND2_FOLDER_ID : CONFIG.FUND1_FOLDER_ID;
  const otherFundKey = currentFundKey === 'FUND1' ? 'FUND2' : 'FUND1';

  try {
    const otherFundFolder = DriveApp.getFolderById(otherFundFolderId);
    const matches = otherFundFolder.getFoldersByName(dealName);
    if (matches.hasNext()) {
      return 'WARNING: A deal folder named "' + dealName + '" already exists under ' +
        otherFundKey + '. This deal was NOT merged — verify manually whether this is a conflict.';
    }
  } catch (err) {
    Logger.log('Could not check other-fund conflict: ' + err);
  }
  return null;
}

// =====================================================================
// GOOGLE DOC CREATION
// =====================================================================

/**
 * sourceInfo is null for funds without source tracking.
 */
function createEmailDocument_(dealFolder, dealName, fundKey, message, forwardedMeta, cleanedBody, sourceInfo) {
  const baseName = dealName + ' - Email';
  const docName = getUniqueDocName_(dealFolder, baseName);

  const doc = DocumentApp.create(docName);
  const body = doc.getBody();

  body.appendParagraph(docName).setHeading(DocumentApp.ParagraphHeading.TITLE);

  body.appendParagraph('Fund: ' + fundKey);
  body.appendParagraph('Deal: ' + dealName);
  body.appendHorizontalRule();

  if (sourceInfo) {
    body.appendParagraph('Source').setHeading(DocumentApp.ParagraphHeading.HEADING2);
    body.appendParagraph('Source marker (set by forwarder): ' +
      (sourceInfo.code
        ? sourceInfo.label + (sourceInfo.detail ? ' — ' + sourceInfo.detail : '')
        : 'none given'));
    body.appendParagraph('Forwarded to deal inbox by: ' + (sourceInfo.forwardedBy || 'unknown'));
    body.appendParagraph('Original sender: ' + (sourceInfo.originalSender || 'not visible'));
    if (sourceInfo.originalTo) body.appendParagraph('Original To: ' + sourceInfo.originalTo);
    if (sourceInfo.originalCc) body.appendParagraph('Original Cc: ' + sourceInfo.originalCc);
    body.appendParagraph('Forward chain: ' + (sourceInfo.forwardChain || 'n/a'));
    if (sourceInfo.hints) {
      body.appendParagraph('Source hints (evidence only, not a classification): ' + sourceInfo.hints);
    }
    body.appendHorizontalRule();
  }

  const fromText = forwardedMeta && forwardedMeta.from ? forwardedMeta.from : message.getFrom();
  const toText = forwardedMeta && forwardedMeta.to ? forwardedMeta.to : CONFIG.MAIN_DEAL_EMAIL;
  const dateText = forwardedMeta && forwardedMeta.date ? forwardedMeta.date :
    Utilities.formatDate(message.getDate(), Session.getScriptTimeZone(), 'MMMM d, yyyy');
  const subjectText = forwardedMeta && forwardedMeta.subject ? forwardedMeta.subject : message.getSubject();

  body.appendParagraph('From:');
  body.appendParagraph(fromText);
  body.appendParagraph('To:');
  body.appendParagraph(toText);
  body.appendParagraph('Date:');
  body.appendParagraph(dateText);
  body.appendParagraph('Subject:');
  body.appendParagraph(subjectText);

  if (!forwardedMeta) {
    body.appendParagraph('(Note: no "Forwarded message" header block was detected. The metadata above ' +
      'reflects the message as received at ' + CONFIG.MAIN_DEAL_EMAIL + ', not necessarily the original sender.)');
  }

  body.appendHorizontalRule();
  body.appendParagraph(cleanedBody || '(empty body)');

  doc.saveAndClose();

  // Move the Doc out of My Drive root and into the deal folder.
  // moveTo works for normal folders AND Shared Drives.
  DriveApp.getFileById(doc.getId()).moveTo(dealFolder);

  return { docId: doc.getId(), docUrl: doc.getUrl() };
}

/**
 * If "Acme - Email" already exists, produces a unique name like
 * "Acme - Email - 2026-08-10", falling back to "- 2", "- 3", etc.
 */
function getUniqueDocName_(dealFolder, baseName) {
  if (!dealFolder.getFilesByName(baseName).hasNext()) {
    return baseName;
  }

  const dateSuffix = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const dateName = baseName + ' - ' + dateSuffix;
  if (!dealFolder.getFilesByName(dateName).hasNext()) {
    return dateName;
  }

  let counter = 2;
  let candidate = baseName + ' - ' + counter;
  while (dealFolder.getFilesByName(candidate).hasNext()) {
    counter++;
    candidate = baseName + ' - ' + counter;
  }
  return candidate;
}

// =====================================================================
// ATTACHMENT SAVING
// =====================================================================

function saveAttachments_(attachments, documentsFolder) {
  let count = 0;
  attachments.forEach(function (attachment) {
    const uniqueName = getUniqueFileName_(documentsFolder, attachment.getName());
    const file = documentsFolder.createFile(attachment).setName(uniqueName);
    maybeCreateOcrDocForPdf_(documentsFolder, file);
    count++;
  });
  return count;
}

/**
 * Gathers attachments from EVERY message in the thread, deduplicated by
 * file content.
 */
function collectThreadAttachments_(messages) {
  const seenContentHashes = new Set();
  const uniqueAttachments = [];

  messages.forEach(function (msg) {
    const msgAttachments = msg.getAttachments({ includeInlineImages: false, includeAttachments: true });
    msgAttachments.forEach(function (attachment) {
      const contentHash = Utilities.base64Encode(
        Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, attachment.getBytes())
      );
      if (!seenContentHashes.has(contentHash)) {
        seenContentHashes.add(contentHash);
        uniqueAttachments.push(attachment);
      }
    });
  });

  return uniqueAttachments;
}

/**
 * If the given file is a PDF, creates a companion OCR'd Google Doc in
 * the same folder using Drive's built-in OCR (Advanced Drive Service).
 * supportsAllDrives is required so this also works inside Shared Drives.
 * Never blocks the main pipeline.
 */
function maybeCreateOcrDocForPdf_(documentsFolder, savedFile) {
  try {
    const name = savedFile.getName();
    const mimeType = savedFile.getMimeType ? savedFile.getMimeType() : '';
    const looksLikePdf = /\.pdf$/i.test(name) || mimeType === MimeType.PDF;
    if (!looksLikePdf) {
      return null; // not a PDF — nothing to OCR
    }

    if (typeof Drive === 'undefined' || !Drive.Files) {
      Logger.log('OCR skipped for "' + name + '": the Advanced Drive Service is not enabled (Services -> add "Drive API").');
      return 'Could not create an OCR version of "' + name + '": the Advanced Drive Service is not enabled in this project (Services -> add "Drive API").';
    }

    const ocrName = name.replace(/\.pdf$/i, '') + ' (OCR)';
    const blob = savedFile.getBlob();

    if (typeof Drive.Files.create === 'function') {
      // Advanced Drive Service v3.
      Drive.Files.create(
        { name: ocrName, mimeType: MimeType.GOOGLE_DOCS, parents: [documentsFolder.getId()] },
        blob,
        { ocr: true, ocrLanguage: 'en', supportsAllDrives: true }
      );
    } else if (typeof Drive.Files.insert === 'function') {
      // Advanced Drive Service v2.
      Drive.Files.insert(
        { title: ocrName, mimeType: MimeType.GOOGLE_DOCS, parents: [{ id: documentsFolder.getId() }] },
        blob,
        { ocr: true, ocrLanguage: 'en', supportsAllDrives: true }
      );
    } else {
      Logger.log('OCR skipped for "' + name + '": Drive service is enabled but no compatible Files.create/insert method was found.');
      return 'Could not create an OCR version of "' + name + '": the enabled Drive service version doesn\'t expose a compatible method.';
    }

    Logger.log('Created OCR Doc: "' + ocrName + '"');
    return null;
  } catch (err) {
    Logger.log('OCR failed for "' + savedFile.getName() + '": ' + err);
    return 'Could not create an OCR searchable version of "' + savedFile.getName() + '": ' + err;
  }
}

/**
 * Appends " (1)", " (2)", etc. as needed, preserving the file extension.
 * Never overwrites an existing file.
 */
function getUniqueFileName_(folder, filename) {
  if (!folder.getFilesByName(filename).hasNext()) {
    return filename;
  }

  const lastDot = filename.lastIndexOf('.');
  const baseName = lastDot > 0 ? filename.substring(0, lastDot) : filename;
  const extension = lastDot > 0 ? filename.substring(lastDot) : '';

  let counter = 1;
  let candidate = baseName + ' (' + counter + ')' + extension;
  while (folder.getFilesByName(candidate).hasNext()) {
    counter++;
    candidate = baseName + ' (' + counter + ')' + extension;
  }
  return candidate;
}

/**
 * Scans the HTML body for links to Google Drive/Docs files and returns
 * the unique file IDs found.
 */
function extractDriveLinkedFileIds_(htmlBody) {
  if (!htmlBody) return [];

  const pattern = /https:\/\/(?:drive|docs)\.google\.com\/[^\s"'<>]*?(?:\/d\/|[?&]id=)([a-zA-Z0-9_-]{25,})/g;
  const ids = new Set();
  let match;
  while ((match = pattern.exec(htmlBody)) !== null) {
    ids.add(match[1]);
  }
  return Array.from(ids);
}

/**
 * Attempts to copy each Drive-linked file into the Documents folder.
 * Failures (no access / copying disabled) are logged, not treated as errors.
 */
function saveDriveLinkedFiles_(fileIds, documentsFolder) {
  let savedCount = 0;
  const notes = [];

  fileIds.forEach(function (fileId) {
    try {
      const sourceFile = DriveApp.getFileById(fileId);
      const uniqueName = getUniqueFileName_(documentsFolder, sourceFile.getName());
      const copiedFile = sourceFile.makeCopy(uniqueName, documentsFolder);
      const ocrNote = maybeCreateOcrDocForPdf_(documentsFolder, copiedFile);
      if (ocrNote) { notes.push(ocrNote); }
      savedCount++;
    } catch (err) {
      notes.push('Could not copy Drive-linked file (ID ' + fileId + '): no access or copying disabled by owner.');
      Logger.log('Drive-linked file ' + fileId + ' could not be copied: ' + err);
    }
  });

  return { savedCount: savedCount, notes: notes };
}

/**
 * Scans the HTML body for links to a Google Drive *folder*.
 */
function extractDriveLinkedFolderIds_(htmlBody) {
  if (!htmlBody) return [];

  const pattern = /https:\/\/drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?)?folders\/([a-zA-Z0-9_-]{25,})/g;
  const ids = new Set();
  let match;
  while ((match = pattern.exec(htmlBody)) !== null) {
    ids.add(match[1]);
  }
  return Array.from(ids);
}

/**
 * Copies every file out of a linked Drive folder (any depth) into the
 * deal's Documents folder, flat.
 */
function saveDriveLinkedFolderFiles_(folderIds, documentsFolder) {
  let savedCount = 0;
  const notes = [];

  folderIds.forEach(function (folderId) {
    try {
      const sourceFolder = DriveApp.getFolderById(folderId);
      const result = copyFilesFromFolderRecursive_(sourceFolder, documentsFolder, 0);
      savedCount += result.savedCount;

      if (result.savedCount === 0) {
        notes.push('Linked Drive folder "' + sourceFolder.getName() + '" contained no files (including subfolders).');
      }
      if (result.hitDepthLimit) {
        notes.push('Linked Drive folder "' + sourceFolder.getName() + '" is nested unusually deep — some files beyond 20 levels may not have been copied. Check it manually.');
      }
      if (result.ocrNotes && result.ocrNotes.length > 0) {
        result.ocrNotes.forEach(function (n) { notes.push(n); });
      }
    } catch (err) {
      notes.push('Could not open linked Drive folder (ID ' + folderId + '): no access, or it is not actually a folder.');
      Logger.log('Drive-linked folder ' + folderId + ' could not be read: ' + err);
    }
  });

  return { savedCount: savedCount, notes: notes };
}

function copyFilesFromFolderRecursive_(folder, documentsFolder, depth) {
  let savedCount = 0;
  let hitDepthLimit = false;
  const ocrNotes = [];
  const MAX_DEPTH = 20;

  if (depth > MAX_DEPTH) {
    return { savedCount: 0, hitDepthLimit: true, ocrNotes: [] };
  }

  const files = folder.getFiles();
  while (files.hasNext()) {
    const sourceFile = files.next();
    const uniqueName = getUniqueFileName_(documentsFolder, sourceFile.getName());
    const copiedFile = sourceFile.makeCopy(uniqueName, documentsFolder);
    const ocrNote = maybeCreateOcrDocForPdf_(documentsFolder, copiedFile);
    if (ocrNote) { ocrNotes.push(ocrNote); }
    savedCount++;
  }

  const subfolders = folder.getFolders();
  while (subfolders.hasNext()) {
    const subfolder = subfolders.next();
    const subResult = copyFilesFromFolderRecursive_(subfolder, documentsFolder, depth + 1);
    savedCount += subResult.savedCount;
    if (subResult.hitDepthLimit) {
      hitDepthLimit = true;
    }
    if (subResult.ocrNotes && subResult.ocrNotes.length > 0) {
      subResult.ocrNotes.forEach(function (n) { ocrNotes.push(n); });
    }
  }

  return { savedCount: savedCount, hitDepthLimit: hitDepthLimit, ocrNotes: ocrNotes };
}

/**
 * Finds DocSend view links written out as plain text in the email body,
 * capturing a nearby label (e.g. "Deck:") for the saved PDF's name.
 */
function extractDocsendLinksFromPlainText_(bodyText) {
  const lines = bodyText.split('\n');
  const links = [];
  const seenUrls = new Set();
  const urlPattern = /(https?:\/\/(?:[a-zA-Z0-9-]+\.)*docsend\.com\/(?:view\/(?:s\/)?|v\/)[a-z0-9]+(?:\/[a-z0-9-]+)?)/;

  lines.forEach(function (line, lineIndex) {
    const match = line.match(urlPattern);
    if (!match) return;

    const url = match[1];
    if (seenUrls.has(url)) return;
    seenUrls.add(url);

    let label = null;
    const beforeUrl = line.substring(0, match.index);

    // Style 1: "Deck: https://docsend.com/..."
    const colonLabelMatch = beforeUrl.match(/([A-Za-z0-9 ]{2,40}):\s*$/);
    if (colonLabelMatch) {
      label = colonLabelMatch[1].trim();
    } else {
      // Style 2: "Acme Fundraising Deck <https://docsend.com/...>"
      const bracketLabelMatch = beforeUrl.match(/([A-Za-z0-9 ]{2,40})\s*<\s*$/);
      if (bracketLabelMatch) {
        label = bracketLabelMatch[1].trim();
      }
    }

    links.push({ url: url, label: label, lineIndex: lineIndex });
  });

  return links;
}

/**
 * Finds DocSend links that only exist as an HTML hyperlink.
 */
function extractDocsendLinksFromHtml_(htmlBody) {
  if (!htmlBody) return [];

  const linkPattern = /<a\b[^>]*href=["']((?:https?:)?\/\/(?:[a-zA-Z0-9-]+\.)*docsend\.com\/(?:view\/(?:s\/)?|v\/)[a-z0-9]+(?:\/[a-z0-9-]+)?)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  const links = [];
  const seenUrls = new Set();
  let match;

  while ((match = linkPattern.exec(htmlBody)) !== null) {
    let url = match[1];
    if (url.indexOf('//') === 0) {
      url = 'https:' + url;
    }
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);

    const visibleText = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    links.push({ url: url, label: visibleText || null });
  }

  return links;
}

/**
 * Combines both detection methods, de-duplicates by URL, and attaches
 * any password found near each link.
 */
function extractDocsendLinks_(plainBodyText, htmlBody) {
  const seenUrls = new Set();
  const links = [];

  extractDocsendLinksFromPlainText_(plainBodyText).forEach(function (link) {
    if (!seenUrls.has(link.url)) {
      seenUrls.add(link.url);
      links.push(link);
    }
  });

  extractDocsendLinksFromHtml_(htmlBody).forEach(function (link) {
    if (!seenUrls.has(link.url)) {
      seenUrls.add(link.url);
      links.push(link);
    }
  });

  const passwordMentions = findDocsendPasswordMentions_(plainBodyText);
  attachDocsendPasswords_(links, passwordMentions);

  return links;
}

/**
 * Scans the email body for password/passcode mentions.
 */
function findDocsendPasswordMentions_(bodyText) {
  const lines = bodyText.split('\n');
  const pattern = /(?:password|passcode|pass\s*code|access\s*code|pin|key|pw)\s*(?:is\s+|[:\-]\s*)(\S{3,40})/i;
  const mentions = [];

  lines.forEach(function (line, lineIndex) {
    const match = line.match(pattern);
    if (match) {
      // '!' is deliberately NOT stripped — common in real passwords.
      const value = match[1].replace(/[.,;:?)]+$/, '');
      mentions.push({ lineIndex: lineIndex, password: value });
    }
  });

  return mentions;
}

/**
 * Matches each DocSend link to the closest password mention.
 */
function attachDocsendPasswords_(links, passwordMentions) {
  const PROXIMITY_LINES = 3;

  links.forEach(function (link) {
    if (typeof link.lineIndex === 'number') {
      let closest = null;
      let closestDistance = PROXIMITY_LINES + 1;
      passwordMentions.forEach(function (mention) {
        const distance = Math.abs(mention.lineIndex - link.lineIndex);
        if (distance <= PROXIMITY_LINES && distance < closestDistance) {
          closest = mention;
          closestDistance = distance;
        }
      });
      if (closest) {
        link.password = closest.password;
        return;
      }
    }

    if (!link.password && passwordMentions.length === 1) {
      link.password = passwordMentions[0].password;
    }
  });
}

function buildDocsendFilename_(link, dealName) {
  let label = link.label ? link.label : 'Docsend Document';
  if (label.length > 60) {
    label = label.substring(0, 60).trim();
  }
  return dealName + ' - ' + label + '.pdf';
}

/**
 * Submits each DocSend link for conversion. Queued ones are recorded in
 * the fund's "Pending Docsend Conversions" sheet.
 */
function queueDocsendConversionsForLinks_(docsendLinks, documentsFolder, dealFolder, dealName, fundKey) {
  let savedCount = 0;
  const notes = [];

  docsendLinks.forEach(function (link) {
    const suggestedName = buildDocsendFilename_(link, dealName);
    const passwordNote = link.password ? ' (using a password found in the email)' : '';
    let result;

    try {
      result = submitDocsendConversion_(link.url, link.password);
    } catch (err) {
      notes.push('Could not reach the DocSend conversion service for "' + suggestedName + '"' + passwordNote + ': ' + err);
      Logger.log('DocSend submit error for ' + link.url + ': ' + err);
      return;
    }

    if (result.type === 'pdf') {
      const uniqueName = getUniqueFileName_(documentsFolder, suggestedName);
      const savedFile = documentsFolder.createFile(result.blob).setName(uniqueName);
      const ocrNote = maybeCreateOcrDocForPdf_(documentsFolder, savedFile);
      if (ocrNote) { notes.push(ocrNote); }
      savedCount++;
    } else if (result.type === 'queued') {
      addPendingConversion_({
        taskId: result.taskId,
        dealFolderId: dealFolder.getId(),
        dealName: dealName,
        fund: fundKey,
        docsendUrl: link.url,
        suggestedFilename: suggestedName
      });
      notes.push('DocSend conversion queued for "' + suggestedName + '"' + passwordNote + ' — will be added to Documents automatically once ready (checked every minute).');
    } else if (result.type === 'blocked') {
      notes.push('DocSend link "' + suggestedName + '" requires interactive email verification and could not be converted automatically' + passwordNote + '. The original link remains in the Email Doc.');
    } else {
      notes.push('DocSend conversion failed for "' + suggestedName + '"' + passwordNote + ': ' + result.message);
    }
  });

  return { savedCount: savedCount, notes: notes };
}

function submitDocsendConversion_(docsendUrl, passcode) {
  const endpoint = CONFIG.DOCSEND_API_BASE + '/api/convert';
  const payload = { url: docsendUrl, async: true };
  if (CONFIG.DOCSEND_VERIFICATION_EMAIL) {
    payload.email = CONFIG.DOCSEND_VERIFICATION_EMAIL;
  }
  if (passcode) {
    payload.passcode = passcode;
  }
  const response = UrlFetchApp.fetch(endpoint, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  return interpretConvertResponse_(response);
}

function interpretConvertResponse_(response) {
  const code = response.getResponseCode();
  const contentType = getResponseContentType_(response);

  if (contentType.indexOf('application/pdf') !== -1) {
    return { type: 'pdf', blob: response.getBlob() };
  }

  let data;
  try {
    data = JSON.parse(response.getContentText());
  } catch (err) {
    return { type: 'error', message: 'Unexpected non-JSON response (HTTP ' + code + ')' };
  }

  if (code === 202 && data.task_id) {
    return { type: 'queued', taskId: data.task_id };
  }
  if (data.status === 'email_verification_required') {
    return { type: 'blocked', message: 'Requires interactive email verification.' };
  }
  if (code >= 400) {
    return { type: 'error', message: data.user_message || data.error || ('HTTP ' + code) };
  }
  return { type: 'error', message: 'Unrecognized response from conversion API (HTTP ' + code + ')' };
}

/**
 * Manual diagnostic tool — submits one DocSend URL and polls it for up
 * to ~30 seconds, logging the raw response at every step.
 */
function testDocsendConversion(docsendUrl, passcode) {
  Logger.log('Submitting: ' + docsendUrl);
  Logger.log('Using verification email: ' + (CONFIG.DOCSEND_VERIFICATION_EMAIL || '(none configured)'));
  Logger.log('Using passcode: ' + (passcode ? '(provided)' : '(none)'));

  let result;
  try {
    result = submitDocsendConversion_(docsendUrl, passcode);
  } catch (err) {
    Logger.log('Submit threw an error: ' + err);
    return;
  }
  Logger.log('Initial response: ' + describeDocsendResult_(result));

  if (result.type !== 'queued') {
    return;
  }

  for (let i = 1; i <= 10; i++) {
    Utilities.sleep(3000);
    let poll;
    try {
      poll = pollDocsendTask_(result.taskId);
    } catch (err) {
      Logger.log('Poll ' + i + ' threw an error: ' + err);
      continue;
    }
    Logger.log('Poll ' + i + ' (t+' + (i * 3) + 's): ' + describeDocsendResult_(poll));
    if (poll.type !== 'pending') {
      return;
    }
  }
  Logger.log('Still pending after 30 seconds — would keep being checked by the 1-minute trigger.');
}

function describeDocsendResult_(result) {
  if (result.type === 'pdf') {
    return 'type=pdf, size=' + result.blob.getBytes().length + ' bytes';
  }
  return JSON.stringify(result);
}

function pollDocsendTask_(taskId) {
  const endpoint = CONFIG.DOCSEND_API_BASE + '/api/task/' + encodeURIComponent(taskId);
  const response = UrlFetchApp.fetch(endpoint, { method: 'get', muteHttpExceptions: true });
  const code = response.getResponseCode();

  if (code === 404) {
    return { type: 'expired' };
  }

  const contentType = getResponseContentType_(response);
  if (contentType.indexOf('application/pdf') !== -1) {
    return { type: 'pdf', blob: response.getBlob() };
  }

  let data;
  try {
    data = JSON.parse(response.getContentText());
  } catch (err) {
    return { type: 'error', message: 'Unexpected non-JSON response while polling (HTTP ' + code + ')' };
  }

  if (data.status === 'queued' || data.status === 'processing') {
    return { type: 'pending' };
  }
  if (data.status === 'email_verification_required') {
    return { type: 'blocked', message: 'Requires interactive email verification.' };
  }
  if (code >= 400 || data.status === 'failed') {
    return { type: 'error', message: data.user_message || data.error || 'Conversion failed.' };
  }
  return { type: 'error', message: 'Unrecognized poll response (HTTP ' + code + ')' };
}

function getResponseContentType_(response) {
  const headers = response.getAllHeaders();
  for (const key in headers) {
    if (key.toLowerCase() === 'content-type') {
      return headers[key] || '';
    }
  }
  return '';
}

// =====================================================================
// PENDING DOCSEND CONVERSIONS (one sheet per fund, checked every minute)
// =====================================================================

function getOrCreatePendingConversionsSheet_(fundKey) {
  const spreadsheet = getOrCreateLogSpreadsheet_(fundKey).getParent();
  let sheet = spreadsheet.getSheetByName(PENDING_CONVERSIONS_SHEET_NAME);
  if (!sheet) {
    // Inserted at the END, so "Processed Deals" stays the first tab
    // (the downstream CSV export reads the first tab).
    sheet = spreadsheet.insertSheet(PENDING_CONVERSIONS_SHEET_NAME, spreadsheet.getSheets().length);
    sheet.appendRow(PENDING_HEADERS);
    sheet.setFrozenRows(1);
  } else if (sheet.getLastRow() === 0) {
    sheet.appendRow(PENDING_HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function addPendingConversion_(fields) {
  const sheet = getOrCreatePendingConversionsSheet_(fields.fund);
  const now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  sheet.appendRow([
    fields.taskId,
    fields.dealFolderId,
    fields.dealName,
    fields.fund,
    fields.docsendUrl,
    fields.suggestedFilename,
    now,
    now,
    0,
    'PENDING',
    ''
  ]);
}

/**
 * Runs every minute via its own trigger. Checks both funds' pending sheets.
 */
function checkPendingDocsendConversions() {
  FUND_KEYS.forEach(function (fundKey) {
    try {
      checkPendingDocsendConversionsForFund_(fundKey);
    } catch (err) {
      Logger.log('Could not check pending conversions for ' + fundKey + ': ' + err);
    }
  });
}

function checkPendingDocsendConversionsForFund_(fundKey) {
  const sheet = getOrCreatePendingConversionsSheet_(fundKey);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  for (let rowNumber = 2; rowNumber <= lastRow; rowNumber++) {
    const status = sheet.getRange(rowNumber, PENDING_COL.STATUS).getValue();
    if (status !== 'PENDING') continue;

    const taskId = sheet.getRange(rowNumber, PENDING_COL.TASK_ID).getValue();
    const dealFolderId = sheet.getRange(rowNumber, PENDING_COL.DEAL_FOLDER_ID).getValue();
    const suggestedFilename = sheet.getRange(rowNumber, PENDING_COL.SUGGESTED_FILENAME).getValue();
    let attempts = Number(sheet.getRange(rowNumber, PENDING_COL.ATTEMPTS).getValue()) || 0;
    const now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');

    let result;
    try {
      result = pollDocsendTask_(taskId);
    } catch (err) {
      result = { type: 'error', message: 'Network error while polling: ' + err };
    }

    attempts++;
    sheet.getRange(rowNumber, PENDING_COL.ATTEMPTS).setValue(attempts);
    sheet.getRange(rowNumber, PENDING_COL.LAST_CHECKED).setValue(now);

    if (result.type === 'pdf') {
      try {
        const dealFolder = DriveApp.getFolderById(dealFolderId);
        const documentsFolder = getOrCreateDocumentsFolder_(dealFolder);
        const uniqueName = getUniqueFileName_(documentsFolder, suggestedFilename);
        const savedFile = documentsFolder.createFile(result.blob).setName(uniqueName);
        const ocrNote = maybeCreateOcrDocForPdf_(documentsFolder, savedFile);
        sheet.getRange(rowNumber, PENDING_COL.STATUS).setValue('DONE');
        sheet.getRange(rowNumber, PENDING_COL.NOTES).setValue(
          'Saved as "' + uniqueName + '".' + (ocrNote ? ' ' + ocrNote : '')
        );
        Logger.log('DocSend conversion complete: ' + uniqueName);
      } catch (err) {
        sheet.getRange(rowNumber, PENDING_COL.STATUS).setValue('ERROR');
        sheet.getRange(rowNumber, PENDING_COL.NOTES).setValue('PDF ready but could not be saved to Drive: ' + err);
      }
    } else if (result.type === 'pending') {
      if (attempts >= MAX_CONVERSION_ATTEMPTS) {
        sheet.getRange(rowNumber, PENDING_COL.STATUS).setValue('FAILED');
        sheet.getRange(rowNumber, PENDING_COL.NOTES).setValue(
          'Gave up after ' + attempts + ' checks — conversion never completed. Original link remains in the Email Doc.'
        );
      }
    } else if (result.type === 'blocked') {
      sheet.getRange(rowNumber, PENDING_COL.STATUS).setValue('BLOCKED');
      sheet.getRange(rowNumber, PENDING_COL.NOTES).setValue(
        'Requires interactive email verification — cannot be completed automatically. Original link remains in the Email Doc.'
      );
    } else if (result.type === 'expired') {
      sheet.getRange(rowNumber, PENDING_COL.STATUS).setValue('FAILED');
      sheet.getRange(rowNumber, PENDING_COL.NOTES).setValue(
        'Conversion task expired before it could be retrieved. Original link remains in the Email Doc.'
      );
    } else {
      if (attempts >= MAX_CONVERSION_ATTEMPTS) {
        sheet.getRange(rowNumber, PENDING_COL.STATUS).setValue('FAILED');
        sheet.getRange(rowNumber, PENDING_COL.NOTES).setValue('Gave up after repeated errors: ' + result.message);
      } else {
        sheet.getRange(rowNumber, PENDING_COL.NOTES).setValue('Last error: ' + result.message);
      }
    }
  }
}

// =====================================================================
// DEAL FLOW LOG SPREADSHEETS (one per fund)
// =====================================================================

function getLogFolderId_(fundKey) {
  const id = fundKey === 'FUND1' ? CONFIG.FUND1_LOG_FOLDER_ID
    : fundKey === 'FUND2' ? CONFIG.FUND2_LOG_FOLDER_ID
      : null;
  if (!id) throw new Error('Unknown fund for log: "' + fundKey + '"');
  if (/^PASTE_/.test(id)) throw new Error(fundKey + '_LOG_FOLDER_ID is not filled in yet (see CONFIG).');
  return id;
}

function logSpreadsheetName_(fundKey) {
  return LOG_SPREADSHEET_NAME + ' - ' + fundKey;
}

/**
 * Returns the "Processed Deals" sheet of "Deal Flow Log - FUND1" or
 * "Deal Flow Log - FUND2", creating it in that fund's log folder if
 * needed. Cached per execution.
 */
function getOrCreateLogSpreadsheet_(fundKey) {
  if (logSheetCache_[fundKey]) return logSheetCache_[fundKey];

  const logFolder = DriveApp.getFolderById(getLogFolderId_(fundKey));
  const name = logSpreadsheetName_(fundKey);
  const existing = logFolder.getFilesByName(name);

  let spreadsheet;
  if (existing.hasNext()) {
    spreadsheet = SpreadsheetApp.open(existing.next());
  } else {
    spreadsheet = SpreadsheetApp.create(name);
    DriveApp.getFileById(spreadsheet.getId()).moveTo(logFolder);
  }

  let sheet = spreadsheet.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(LOG_SHEET_NAME, 0); // always the first tab
    sheet.appendRow(LOG_HEADERS);
    sheet.setFrozenRows(1);
    const defaultSheet = spreadsheet.getSheetByName('Sheet1');
    if (defaultSheet && spreadsheet.getSheets().length > 1) {
      spreadsheet.deleteSheet(defaultSheet);
    }
  } else if (sheet.getLastRow() === 0) {
    sheet.appendRow(LOG_HEADERS);
    sheet.setFrozenRows(1);
  } else {
    ensureLogHeaders_(sheet);
  }

  logSheetCache_[fundKey] = sheet;
  return sheet;
}

/**
 * Adds any missing header cells to an existing "Processed Deals" sheet.
 * Only fills blank header cells, never overwrites one.
 */
function ensureLogHeaders_(sheet) {
  if (sheet.getMaxColumns() < LOG_HEADERS.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), LOG_HEADERS.length - sheet.getMaxColumns());
  }
  const current = sheet.getRange(1, 1, 1, LOG_HEADERS.length).getValues()[0];
  for (let i = 0; i < LOG_HEADERS.length; i++) {
    if (!current[i]) {
      sheet.getRange(1, i + 1).setValue(LOG_HEADERS[i]);
    }
  }
}

/**
 * Writes one log row.
 *   Fund = FUND1 or FUND2 -> only that fund's log.
 *   Anything else (NEEDS REVIEW, ERROR, blank fund) -> BOTH logs.
 */
function logProcessedDeal_(fields) {
  const row = [
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'),
    fields.status || '',
    fields.fund || '',
    fields.dealName || '',
    fields.sender || '',
    fields.subject || '',
    fields.emailDate || '',
    fields.messageId || '',
    fields.threadId || '',
    fields.folderId || '',
    fields.folderUrl || '',
    fields.docId || '',
    fields.docUrl || '',
    fields.attachmentCount === undefined ? '' : fields.attachmentCount,
    fields.notes || '',
    fields.sourceCode || '',
    fields.sourceDetail || '',
    fields.forwardedBy || '',
    fields.originalSender || '',
    fields.forwardChain || '',
    fields.sourceHints || ''
  ];

  const targets = FUND_KEYS.indexOf(fields.fund) !== -1 ? [fields.fund] : FUND_KEYS;
  targets.forEach(function (fundKey) {
    getOrCreateLogSpreadsheet_(fundKey).appendRow(row);
  });
}

// =====================================================================
// TESTS / DIAGNOSTICS
// =====================================================================

/**
 * Checks the routing-line parser against many spellings. Touches no
 * email, Drive or Sheet — safe to run any time. Check the Execution log.
 */
function testRoutingParser() {
  [
    'FUND1 | Acme',
    'FUND1 | Acme | N: Jane Doe (Example Labs)',
    'FUND1|Acme|N:Jane Doe (Example Labs)',
    'fund 1 | Acme | n jane doe (example labs)',
    'FUND1 | Acme | Network - Jane Doe (Example Labs)',
    'FUND1 | Acme | Source: N: Jane Doe',
    'FUND1 | Acme | (N: Jane Doe (Example Labs))',
    'FUND1 | Acme : N: Jane Doe',
    'FUND1 | Acme / Intro - Sam (Example Bank)',
    'FUND1 | Acme - N: Jane',
    'FUND1 | Acme-Network: Jane',
    'FUND1 | Globex | T: Alex',
    'FUND1 | Globex | t:alex',
    'FUND1 | Globex | Team - Alex',
    'FUND1 | Globex | T',
    'FUND1 | Initech | i',
    'FUND1 | Initech | Inbound',
    'FUND1 | Initech | [cold]',
    'FUND1 | Initech - Inbound',
    'FUND1 | Acme / I',
    'FUND2 | Umbrella | E: TechConf Berlin',
    'Fund2: Umbrella | event – TechConf',
    'FUND1 | Globex | O',
    'FUND1 | A/B Labs',
    'FUND1 | Coin-Ex',
    'FUND1 | Nexus-O',
    'FUND1 | AI/O',
    'FUND1 | Alpha - E Finance',
    'FUND1 | Globex | Internal',
    'FUND1 | Globex | X',
    'FUND1 ｜ Globex ｜ N: Jane',
    'FUND2: Umbrella (N: jdoe N)',
    'FUND2 | Umbrella (N: Jane)',
    'Fund2: Umbrella [I]',
    'FUND1 | Globex (T: Alex)',
    'FUND1 | Globex(N:Jane Doe (Example Labs))',
    'FUND2 / Umbrella (event: TechConf)',
    'FUND1 | Globex (Germany)',
    'FUND1 | Globex (Germany) (N: x)',
    'FUND1 | Series (A)',
    'FUND2 | Umbrella (N Jane Smith)',
    'FUND1 | Globex [T Alex]',
    'FUND I | Hooli | I',
    'FUND II | Globex',
    'Fund i | Globex'
  ].forEach(function (line) {
    const r = parseRoutingInstruction_(line);
    if (!r.valid) {
      Logger.log(line + '  =>  NEEDS REVIEW: ' + r.error);
      return;
    }
    Logger.log(line + '  =>  ' + r.fundKey + '  deal="' + r.dealName + '"  source=' +
      (r.source.code || '-') + '  detail="' + r.source.detail + '"' +
      (r.source.note ? '  note: ' + r.source.note : ''));
  });

  const r2 = parseRoutingInstruction_('FUND1 | Acme\nSource: N Jane Doe (Example Labs)\n\nHi team,');
  Logger.log('two-line  =>  deal="' + r2.dealName + '"  source=' + r2.source.code + '  detail="' + r2.source.detail + '"');

  const r3 = parseRoutingInstruction_('{FUND2} | {Globex} | {I}');
  Logger.log('braces  =>  ' + r3.fundKey + '  deal="' + r3.dealName + '"  source=' + r3.source.code);

  [
    '{FUND1 or FUND2} | {Company Name} | {Source: Name of source}',
    '{FUND1} | {Company Name} | {N: Jane}'
  ].forEach(function (line) {
    const r = parseRoutingInstruction_(line);
    Logger.log(line + '  =>  ' + (r.valid ? 'VALID (unexpected!)' : 'NEEDS REVIEW: ' + r.error));
  });
}
