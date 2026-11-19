/**
 * =====================================================================
 * CONFIGURATION — fill in your own values.
 * Apps Script shares one global scope across all .gs files, so
 * intake.gs reads CONFIG from here.
 * =====================================================================
 */
const CONFIG = {
  MAIN_DEAL_EMAIL: "deals@your-fund.com",

  // Optional. Only used by validateConfiguration() to check that the fund
  // folders sit inside it. Leave "" to skip that check.
  ROOT_FOLDER_ID: "",

  FUND1_FOLDER_ID: "PASTE_FUND1_FOLDER_ID",   // (Google Drive link)
  FUND2_FOLDER_ID: "PASTE_FUND2_FOLDER_ID",   // (Google Drive link)

  // One Deal Flow Log per fund. Create a folder for each one (for example
  // "System" inside the fund folder) and paste its ID here.
  FUND1_LOG_FOLDER_ID: "PASTE_FUND1_LOG_FOLDER_ID",   // (Google Drive link)
  FUND2_LOG_FOLDER_ID: "PASTE_FUND2_LOG_FOLDER_ID",   // (Google Drive link)

  // Where an OLD single "Deal Flow Log" lives. Only used by
  // migrateOldDealLog(). Nothing is ever written there again.
  OLD_DEAL_LOG_FOLDER_ID: "PASTE_OLD_LOG_FOLDER_ID",  // (Google Drive link)

  // Where the daily health check (health-check.gs) sends alerts.
  HEALTH_ALERT_EMAIL: "analyst1@your-fund.com",

  PROCESSED_LABEL: "DEALFLOW_PROCESSED",
  MAX_EMAILS_PER_RUN: 10,

  // Set to false to disable DocSend-to-PDF conversion entirely and just
  // leave DocSend links as clickable text in the Email Doc.
  ENABLE_DOCSEND_CONVERSION: true,
  DOCSEND_API_BASE: "https://docsend2pdf.com",
  // Some DocSend documents ask a viewer to type an email before showing
  // content (no passcode, just an email gate). Supplying one here lets
  // the conversion API get past that the same way you would manually.
  DOCSEND_VERIFICATION_EMAIL: "deals@your-fund.com",

  // Only emails sent FROM one of these addresses are ever looked at.
  // Anything from outside this list is invisible to the script.
  ALLOWED_SENDERS: [
    "partner1@your-fund.com",
    "partner2@your-fund.com",
    "associate1@your-fund.com",
    "analyst1@your-fund.com"
  ],

  // SOURCE TRACKING: which funds get the Source block in the Email Doc,
  // the Source columns in the log, and the "no marker" note.
  SOURCE_TRACKING_FUNDS: ["FUND1", "FUND2"],

  // Public inboxes. An original email addressed to one of these is
  // recorded as a hint that the deal is Inbound.
  PUBLIC_INBOXES: [
    "pitch@your-fund.com",
    "contact@your-fund.com"
  ]
};
