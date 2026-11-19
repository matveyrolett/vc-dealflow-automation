/**
 * =====================================================================
 * TEST SUITE
 * =====================================================================
 * Real pass/fail tests for the parts of the system with the most edge
 * cases: the routing-line parser, the company-name normalizer and the
 * health-check logic. None of them touch Gmail, Drive or Sheets.
 *
 * Run in Apps Script:  runAllTests()  (results in the Execution log)
 * Run locally:         node tests/run-tests.js
 * =====================================================================
 */

// ---------------------------------------------------------------------
// Minimal test harness
// ---------------------------------------------------------------------

function assertEqual_(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(label + ': expected ' + e + ', got ' + a);
}

function runTestCases_(suiteName, cases, check, results) {
  cases.forEach(function (c, i) {
    const name = suiteName + ' #' + (i + 1) + (c.name ? ' (' + c.name + ')' : '');
    try {
      check(c);
      results.passed++;
    } catch (err) {
      results.failed++;
      results.failures.push(name + ' — ' + err.message);
    }
  });
}

/** Runs every suite. Returns { passed, failed, failures }. */
function runAllTests() {
  const results = { passed: 0, failed: 0, failures: [] };

  runTestCases_('Routing parser', ROUTING_TEST_CASES_, checkRoutingCase_, results);
  runTestCases_('Name normalizer', NORMALIZER_TEST_CASES_, checkNormalizerCase_, results);
  runTestCases_('Canonical lookup', LOOKUP_TEST_CASES_, checkLookupCase_, results);
  runTestCases_('Health check', HEALTH_TEST_CASES_, checkHealthCase_, results);
  runTestCases_('Forwarded email parsing', FORWARD_TEST_CASES_, checkForwardCase_, results);

  const summary = results.failed === 0
    ? '✅ All ' + results.passed + ' tests passed.'
    : '❌ ' + results.failed + ' failed, ' + results.passed + ' passed:\n  ' + results.failures.join('\n  ');
  Logger.log(summary);
  return results;
}

// ---------------------------------------------------------------------
// Routing parser
// Each case: input line -> expected fund, deal, source code, source detail.
// valid:false cases expect NEEDS REVIEW, with an error containing `error`.
// ---------------------------------------------------------------------

const ROUTING_TEST_CASES_ = [
  // Basic forms
  { line: 'FUND1 | Acme', fund: 'FUND1', deal: 'Acme', code: '', detail: '' },
  { line: 'FUND1 | Acme | N: Jane Doe (Example Labs)', fund: 'FUND1', deal: 'Acme', code: 'N', detail: 'Jane Doe (Example Labs)' },
  { line: 'FUND1|Acme|N:Jane Doe (Example Labs)', fund: 'FUND1', deal: 'Acme', code: 'N', detail: 'Jane Doe (Example Labs)', name: 'no spaces' },
  { line: 'fund 1 | Acme | n jane doe (example labs)', fund: 'FUND1', deal: 'Acme', code: 'N', detail: 'jane doe (example labs)', name: 'lowercase' },

  // Source spelled out / prefixed / bracketed
  { line: 'FUND1 | Acme | Network - Jane Doe (Example Labs)', fund: 'FUND1', deal: 'Acme', code: 'N', detail: 'Jane Doe (Example Labs)' },
  { line: 'FUND1 | Acme | Source: N: Jane Doe', fund: 'FUND1', deal: 'Acme', code: 'N', detail: 'Jane Doe' },
  { line: 'FUND1 | Acme | (N: Jane Doe (Example Labs))', fund: 'FUND1', deal: 'Acme', code: 'N', detail: 'Jane Doe (Example Labs)', name: 'nested brackets' },

  // Other separators between deal and source
  { line: 'FUND1 | Acme : N: Jane Doe', fund: 'FUND1', deal: 'Acme', code: 'N', detail: 'Jane Doe' },
  { line: 'FUND1 | Acme / Intro - Sam (Example Bank)', fund: 'FUND1', deal: 'Acme', code: 'N', detail: 'Sam (Example Bank)' },
  { line: 'FUND1 | Acme - N: Jane', fund: 'FUND1', deal: 'Acme', code: 'N', detail: 'Jane' },
  { line: 'FUND1 | Acme-Network: Jane', fund: 'FUND1', deal: 'Acme', code: 'N', detail: 'Jane' },

  // Team / Inbound / Event / Outbound
  { line: 'FUND1 | Globex | T: Alex', fund: 'FUND1', deal: 'Globex', code: 'T', detail: 'Alex' },
  { line: 'FUND1 | Globex | t:alex', fund: 'FUND1', deal: 'Globex', code: 'T', detail: 'alex' },
  { line: 'FUND1 | Globex | Team - Alex', fund: 'FUND1', deal: 'Globex', code: 'T', detail: 'Alex' },
  { line: 'FUND1 | Globex | T', fund: 'FUND1', deal: 'Globex', code: 'T', detail: '', note: 'no teammate name', name: 'missing name is noted' },
  { line: 'FUND1 | Initech | i', fund: 'FUND1', deal: 'Initech', code: 'I', detail: '' },
  { line: 'FUND1 | Initech | Inbound', fund: 'FUND1', deal: 'Initech', code: 'I', detail: '' },
  { line: 'FUND1 | Initech | [cold]', fund: 'FUND1', deal: 'Initech', code: 'I', detail: '' },
  { line: 'FUND1 | Initech - Inbound', fund: 'FUND1', deal: 'Initech', code: 'I', detail: '' },
  { line: 'FUND1 | Acme / I', fund: 'FUND1', deal: 'Acme', code: 'I', detail: '' },
  { line: 'FUND2 | Umbrella | E: TechConf Berlin', fund: 'FUND2', deal: 'Umbrella', code: 'E', detail: 'TechConf Berlin' },
  { line: 'Fund2: Umbrella | event – TechConf', fund: 'FUND2', deal: 'Umbrella', code: 'E', detail: 'TechConf', name: 'en dash' },
  { line: 'FUND1 | Globex | O', fund: 'FUND1', deal: 'Globex', code: 'O', detail: '' },

  // Deal names that LOOK like they contain a marker must stay intact
  { line: 'FUND1 | A/B Labs', fund: 'FUND1', deal: 'A/B Labs', code: '', detail: '' },
  { line: 'FUND1 | Coin-Ex', fund: 'FUND1', deal: 'Coin-Ex', code: '', detail: '' },
  { line: 'FUND1 | Nexus-O', fund: 'FUND1', deal: 'Nexus-O', code: '', detail: '' },
  { line: 'FUND1 | AI/O', fund: 'FUND1', deal: 'AI/O', code: '', detail: '' },
  { line: 'FUND1 | Alpha - E Finance', fund: 'FUND1', deal: 'Alpha - E Finance', code: '', detail: '' },
  { line: 'FUND1 | Globex (Germany)', fund: 'FUND1', deal: 'Globex (Germany)', code: '', detail: '' },
  { line: 'FUND1 | Series (A)', fund: 'FUND1', deal: 'Series (A)', code: '', detail: '' },
  { line: 'FUND1 | Globex (Germany) (N: x)', fund: 'FUND1', deal: 'Globex (Germany)', code: 'N', detail: 'x' },

  // Unknown / ambiguous markers never block the deal, they add a note
  { line: 'FUND1 | Globex | Internal', fund: 'FUND1', deal: 'Globex', code: '', detail: 'Internal', note: 'ambiguous' },
  { line: 'FUND1 | Globex | X', fund: 'FUND1', deal: 'Globex', code: '', detail: 'X', note: 'Unrecognised' },

  // Brackets at the end of the deal name
  { line: 'FUND2 | Umbrella (N: Jane)', fund: 'FUND2', deal: 'Umbrella', code: 'N', detail: 'Jane' },
  { line: 'Fund2: Umbrella [I]', fund: 'FUND2', deal: 'Umbrella', code: 'I', detail: '' },
  { line: 'FUND1 | Globex (T: Alex)', fund: 'FUND1', deal: 'Globex', code: 'T', detail: 'Alex' },
  { line: 'FUND1 | Globex(N:Jane Doe (Example Labs))', fund: 'FUND1', deal: 'Globex', code: 'N', detail: 'Jane Doe (Example Labs)' },
  { line: 'FUND2 / Umbrella (event: TechConf)', fund: 'FUND2', deal: 'Umbrella', code: 'E', detail: 'TechConf' },
  { line: 'FUND2 | Umbrella (N Jane Smith)', fund: 'FUND2', deal: 'Umbrella', code: 'N', detail: 'Jane Smith' },
  { line: 'FUND1 | Globex [T Alex]', fund: 'FUND1', deal: 'Globex', code: 'T', detail: 'Alex' },

  // Typing variations
  { line: 'FUND1 ｜ Globex ｜ N: Jane', fund: 'FUND1', deal: 'Globex', code: 'N', detail: 'Jane', name: 'full-width pipes' },
  { line: 'FUND I | Hooli | I', fund: 'FUND1', deal: 'Hooli', code: 'I', detail: '', name: 'roman numeral I' },
  { line: 'FUND II | Globex', fund: 'FUND2', deal: 'Globex', code: '', detail: '', name: 'roman numeral II' },
  { line: 'Fund i | Globex', fund: 'FUND1', deal: 'Globex', code: '', detail: '' },
  { line: '{FUND2} | {Globex} | {I}', fund: 'FUND2', deal: 'Globex', code: 'I', detail: '', name: 'snippet braces' },
  { line: '\u200BFUND1 | Acme', fund: 'FUND1', deal: 'Acme', code: '', detail: '', strip: true, name: 'zero-width character' },
  { line: 'FUND1 | Acme\nSource: N Jane Doe (Example Labs)\n\nHi team,', fund: 'FUND1', deal: 'Acme', code: 'N', detail: 'Jane Doe (Example Labs)', name: 'source on second line' },

  // Must become NEEDS REVIEW
  { line: '{FUND1 or FUND2} | {Company Name} | {Source: Name of source}', valid: false, error: 'Missing or invalid routing instruction', name: 'untouched snippet' },
  { line: '{FUND1} | {Company Name} | {N: Jane}', valid: false, error: 'placeholder', name: 'unfilled company name' },
  { line: 'FUND1 | [Startup Name]', valid: false, error: 'placeholder' },
  { line: 'FUND3 | Acme', valid: false, error: 'Only FUND1 or FUND2' },
  { line: 'FUND1 |', valid: false, error: 'Missing deal name' },
  { line: 'Hi team, see below', valid: false, error: 'Missing or invalid routing instruction', name: 'no routing line' },
  { line: '', valid: false, error: 'Missing or invalid routing instruction', name: 'empty body' }
];

function checkRoutingCase_(c) {
  const input = c.strip ? stripInvisibleCharacters_(c.line) : c.line;
  const r = parseRoutingInstruction_(input);

  if (c.valid === false) {
    assertEqual_(r.valid, false, 'valid');
    if (r.error.indexOf(c.error) === -1) {
      throw new Error('error message: expected to contain "' + c.error + '", got "' + r.error + '"');
    }
    return;
  }

  assertEqual_(r.valid, true, 'valid');
  assertEqual_(r.fundKey, c.fund, 'fund');
  assertEqual_(r.dealName, c.deal, 'deal');
  assertEqual_(r.source.code, c.code, 'source code');
  assertEqual_(r.source.detail, c.detail, 'source detail');
  if (c.note && r.source.note.indexOf(c.note) === -1) {
    throw new Error('note: expected to contain "' + c.note + '", got "' + r.source.note + '"');
  }
}

// ---------------------------------------------------------------------
// Name normalizer
// ---------------------------------------------------------------------

const NORMALIZER_TEST_CASES_ = [
  { input: 'Acme', expected: 'acme' },
  { input: '  ACME  ', expected: 'acme', name: 'case and spaces' },
  { input: 'Acme Inc.', expected: 'acme', name: 'suffix with punctuation' },
  { input: 'Acme AI', expected: 'acme' },
  { input: 'Acme AI Inc', expected: 'acme', name: 'stacked suffixes' },
  { input: 'Globex GmbH', expected: 'globex' },
  { input: 'Initech LLC', expected: 'initech' },
  { input: 'Hooli Ltd', expected: 'hooli' },
  { input: '07_Acme', expected: 'acme', name: 'data-room folder prefix' },
  { input: '10_Globex Inc', expected: 'globex' },
  { input: 'Coin-Ex', expected: 'coinex' },
  { input: 'Café Labs', expected: 'cafe labs', name: 'accent' },
  { input: 'Bluebird VC Fund 1', expected: 'bluebird vc fund 1', name: 'trailing number kept' },
  { input: 'Bluebird Fund', expected: 'bluebird' },
  { input: 'AI', expected: 'ai', name: 'never strips to nothing' },
  { input: 'Fund', expected: 'fund' },
  { input: '', expected: '' },
  { input: null, expected: '' },
  { a: 'Acme Inc.', b: 'ACME', match: true },
  { a: '07_Acme', b: 'Acme GmbH', match: true },
  { a: 'Bluebird Ventures', b: 'Bluebird VC Fund 1', match: false, name: 'near-duplicates stay apart' },
  { a: '', b: '', match: false, name: 'empty never matches' }
];

function checkNormalizerCase_(c) {
  if ('match' in c) {
    assertEqual_(namesMatch_(c.a, c.b), c.match, 'namesMatch_("' + c.a + '", "' + c.b + '")');
  } else {
    assertEqual_(normalizeCompanyName_(c.input), c.expected, 'normalize("' + c.input + '")');
  }
}

const LOOKUP_TEST_CASES_ = [
  { name: 'single match', heard: 'acme inc', list: ['Acme', 'Globex'], status: 'match', match: 'Acme' },
  { name: 'folder name to card', heard: '10_Globex', list: ['Acme', 'Globex GmbH'], status: 'match', match: 'Globex GmbH' },
  { name: 'no match', heard: 'Hooli', list: ['Acme', 'Globex'], status: 'none' },
  { name: 'two cards collide', heard: 'Acme', list: ['Acme Inc', 'ACME GmbH', 'Globex'], status: 'ambiguous' },
  { name: 'empty name', heard: '', list: ['Acme'], status: 'none' }
];

function checkLookupCase_(c) {
  const r = findCanonicalName_(c.heard, c.list);
  assertEqual_(r.status, c.status, 'status');
  if (c.match) assertEqual_(r.match, c.match, 'match');
}

// ---------------------------------------------------------------------
// Health check (pure logic, fixed clock)
// ---------------------------------------------------------------------

const HEALTH_NOW_ = new Date(2026, 9, 15, 9, 0, 0); // 15 Oct 2026, 09:00

function healthLogRow_(timestamp, status, messageId, subject, note) {
  const row = new Array(LOG_HEADERS.length).fill('');
  row[COL_TIMESTAMP] = timestamp;
  row[COL_STATUS] = status;
  row[COL_MESSAGE_ID] = messageId;
  row[5] = subject;
  row[14] = note || '';
  return row;
}

function healthPendingRow_(submittedAt, status, filename) {
  const row = new Array(PENDING_HEADERS.length).fill('');
  row[PENDING_COL.SUBMITTED_AT - 1] = submittedAt;
  row[PENDING_COL.STATUS - 1] = status;
  row[PENDING_COL.SUGGESTED_FILENAME - 1] = filename;
  return row;
}

const HEALTH_ALL_TRIGGERS_ = ['processNewDeals', 'checkPendingDocsendConversions'];

const HEALTH_TEST_CASES_ = [
  {
    name: 'healthy system has no issues',
    data: { triggerHandlers: HEALTH_ALL_TRIGGERS_, docsendEnabled: true,
      logRows: [healthLogRow_('2026-10-14 10:00:00', 'PROCESSED', 'm1', 'Acme deck')], pendingRows: [], checkpoints: [] },
    issues: 0, contains: 'All checks passed'
  },
  {
    name: 'missing intake trigger is an issue',
    data: { triggerHandlers: ['checkPendingDocsendConversions'], docsendEnabled: true, logRows: [], pendingRows: [], checkpoints: [] },
    issues: 1, contains: 'processNewDeals trigger is missing'
  },
  {
    name: 'docsend trigger only required when docsend is on',
    data: { triggerHandlers: ['processNewDeals'], docsendEnabled: false, logRows: [], pendingRows: [], checkpoints: [] },
    issues: 0
  },
  {
    name: 'NEEDS REVIEW copied into both logs counts once',
    data: { triggerHandlers: HEALTH_ALL_TRIGGERS_, docsendEnabled: true,
      logRows: [
        healthLogRow_('2026-10-13 12:00:00', 'NEEDS REVIEW', 'm2', 'Fwd: deck', 'Missing deal name'),
        healthLogRow_('2026-10-13 12:00:00', 'NEEDS REVIEW', 'm2', 'Fwd: deck', 'Missing deal name')
      ], pendingRows: [], checkpoints: [] },
    issues: 1, contains: '1 email(s) need a corrected routing line'
  },
  {
    name: 'old problems outside the lookback are ignored',
    data: { triggerHandlers: HEALTH_ALL_TRIGGERS_, docsendEnabled: true,
      logRows: [healthLogRow_('2026-09-01 12:00:00', 'ERROR', 'm3', 'x', 'boom')], pendingRows: [], checkpoints: [] },
    issues: 0
  },
  {
    name: 'Date objects from Sheets are understood',
    data: { triggerHandlers: HEALTH_ALL_TRIGGERS_, docsendEnabled: true,
      logRows: [healthLogRow_(new Date(2026, 9, 14, 8, 0, 0), 'ERROR', 'm4', 'x', 'Unhandled exception')], pendingRows: [], checkpoints: [] },
    issues: 1, contains: 'crashed the intake script'
  },
  {
    name: 'conversion pending 10h is stuck, 1h is fine',
    data: { triggerHandlers: HEALTH_ALL_TRIGGERS_, docsendEnabled: true, logRows: [],
      pendingRows: [
        healthPendingRow_('2026-10-14 23:00:00', 'PENDING', 'Acme - Deck.pdf'),
        healthPendingRow_('2026-10-15 08:00:00', 'PENDING', 'Globex - Deck.pdf')
      ], checkpoints: [] },
    issues: 1, contains: 'Acme - Deck.pdf'
  },
  {
    name: 'blocked conversion asks for manual download',
    data: { triggerHandlers: HEALTH_ALL_TRIGGERS_, docsendEnabled: true, logRows: [],
      pendingRows: [healthPendingRow_('2026-10-14 09:00:00', 'BLOCKED', 'Initech - Deck.pdf')], checkpoints: [] },
    issues: 1, contains: 'need downloading by hand'
  },
  {
    name: 'checkpoint ages appear as context',
    data: { triggerHandlers: HEALTH_ALL_TRIGGERS_, docsendEnabled: true, logRows: [], pendingRows: [],
      checkpoints: [{ name: 'dataroom-checkpoint.txt', lastUpdated: new Date(2026, 9, 12, 9, 0, 0) },
                    { name: 'meeting-notes-checkpoint.txt', lastUpdated: null }] },
    issues: 0, contains: 'dataroom-checkpoint.txt: last updated 3 day(s) ago'
  }
];

function checkHealthCase_(c) {
  const report = buildHealthReport_(c.data, HEALTH_NOW_);
  assertEqual_(report.issues.length, c.issues, 'issue count');
  if (c.contains && report.text.indexOf(c.contains) === -1) {
    throw new Error('report text: expected to contain "' + c.contains + '"\n' + report.text);
  }
}

// ---------------------------------------------------------------------
// Forwarded email parsing: chain extraction and the stored body
// ---------------------------------------------------------------------

const FORWARD_SAMPLE_ = [
  'FUND1 | Acme Robotics | N: Jane Doe',
  '',
  'Met them through Jane, worth a look.',
  '',
  '---------- Forwarded message ---------',
  'From: Max Founder <max@acme.example>',
  'Date: Tue, 6 Oct 2026 at 14:02',
  'Subject: Acme Robotics - Seed deck',
  'To: Partner One <partner1@your-fund.com>',
  'Cc: Jane Doe <jane@examplelabs.example>',
  '',
  'Hi! Here is our deck.',
  '',
  'Best, Max'
].join('\n');

const FORWARD_DOUBLE_ = [
  'FUND2 | Umbrella',
  '---------- Forwarded message ---------',
  'From: Associate <associate1@your-fund.com>',
  'Subject: Fwd: Umbrella',
  '',
  '---------- Forwarded message ---------',
  'From: GP <gp@umbrella.example>',
  'Subject: Umbrella Fund II',
  '',
  'Deck attached.'
].join('\n');

const FORWARD_TEST_CASES_ = [
  { name: 'original sender found', input: FORWARD_SAMPLE_, check: function (chain) {
      assertEqual_(chain.length, 1, 'hops');
      assertEqual_(chain[0].from, 'Max Founder <max@acme.example>', 'from');
      assertEqual_(chain[0].cc, 'Jane Doe <jane@examplelabs.example>', 'cc');
    } },
  { name: 'Cc line does not leak into the body (regression)', input: FORWARD_SAMPLE_, body: 'Hi! Here is our deck.\n\nBest, Max' },
  { name: 'two-hop chain, original sender last', input: FORWARD_DOUBLE_, check: function (chain) {
      assertEqual_(chain.length, 2, 'hops');
      assertEqual_(chain[1].from, 'GP <gp@umbrella.example>', 'original sender');
    } },
  { name: 'no forward header', input: 'FUND1 | Acme\n\nDirect email, no forward.', check: function (chain) {
      assertEqual_(chain.length, 0, 'hops');
    }, body: 'Direct email, no forward.' }
];

function checkForwardCase_(c) {
  const chain = extractForwardChain_(c.input);
  if (c.check) c.check(chain);
  if (c.body !== undefined) {
    const routing = parseRoutingInstruction_(c.input);
    assertEqual_(buildCleanedBody_(c.input, routing.rawLine, chain[0] || null), c.body, 'stored body');
  }
}
