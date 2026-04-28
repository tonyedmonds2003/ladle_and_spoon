// ════════════════════════════════════════════════════════════════
//  LADLE & SPOON — Complete Apps Script
//  Combines: original email/sync script + new order webhook
//
//  PASTE THIS ENTIRE FILE, replacing ALL existing code.
//  Then run setupAll() once to install triggers.
// ════════════════════════════════════════════════════════════════

// ── CONFIGURATION ──────────────────────────────────────────────
const formSheetName     = "Soup orders";
const customerSheetName = "Customers";
const orderLink         = "https://forms.gle/F1Zh8m8uRmRHcMUt8";
const LOGO_URL          = "https://res.cloudinary.com/drcjmvjc9/image/upload/v1762996224/Ladle_and_Spoon_Logo_Clean_pylcav.png";
const SENDER_EMAIL      = "LadleandSpoon1024@gmail.com";
const SENDER_NAME       = "Ladle & Spoon";
const VENMO_HANDLE      = "@LadleAndSpoon";

// ── FORM SHEET COLUMN INDICES (1-based) ────────────────────────
const timestampColumnIndex    = 1;   // A
const uniqueIdColumnIndex     = 2;   // B — Email
const newCustomerStatusIndex  = 3;   // C — New customer?
const customerDataIndices     = [2, 4, 5, 6]; // Email, Name, Phone, Address

// ── CUSTOMER SHEET COLUMN INDICES ──────────────────────────────
const emailIndexInCustomerSheet = 0; // A — Email (0-based for arrays)
const nameIndexInCustomerData   = 1; // B — Name  (0-based for arrays)
const lastOrderColIndex         = 5; // E — Last Order Date (1-based for ranges)
const lastEmailDateColIndex     = 7; // G — Last Email Date (1-based for ranges)

// ── NEW CUSTOMER STRING — must match form exactly ───────────────
const targetNewStatus = "Yes I am New and hungry! 🎉";

// ── LIA'S EMAIL (auto-detected) ────────────────────────────────
const LIA_EMAIL = Session.getActiveUser().getEmail();


// ════════════════════════════════════════════════════════════════
//  WEBHOOK — receives POST from the app
// ════════════════════════════════════════════════════════════════

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    if      (data.type === "order")              return handleOrder(data);
    else if (data.type === "swap")               return handleSwap(data);
    else if (data.type === "notification_token") return handleNotificationToken(data);
    else if (data.type === "broadcast")         return handleBroadcast(data);
    return jsonResponse({ success: false, error: "Unknown type" });
  } catch(err) {
    Logger.log("doPost error: " + err.message);
    return jsonResponse({ success: false, error: err.message });
  }
}

function doGet(e) {
  return jsonResponse({ status: "Ladle & Spoon backend live ✅", time: new Date().toString() });
}


// ════════════════════════════════════════════════════════════════
//  ORDER HANDLER — writes to "Soup orders", syncs customer, sends emails
// ════════════════════════════════════════════════════════════════

function handleOrder(data) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(formSheetName);
  if (!sheet) return jsonResponse({ success: false, error: "Soup orders tab not found" });

  // Build and append the row
  var headers = sheet.getRange(4, 1, 1, sheet.getLastColumn()).getValues()[0];
  var row     = buildOrderRow(data, headers);
  var lastRow = Math.max(sheet.getLastRow(), 4);
  sheet.getRange(lastRow + 1, 1, 1, row.length).setValues([row]);
  Logger.log("Order written to row " + (lastRow + 1));

  // Sync the customer into the Customers tab (same logic as syncCustomers)
  syncSingleCustomer(ss, data);

  // Send confirmation to customer (HTML, matches existing email style)
  sendConfirmationEmail(data);

  // Refresh intelligence dashboards
  try { generateLadleAndSpoonIntelligence(); } catch(e) {
    Logger.log("Intelligence refresh: " + e.message);
  }

  return jsonResponse({ success: true, orderId: data.id });
}

function buildOrderRow(data, headers) {
  var row = new Array(headers.length).fill("");

  // Fixed columns matching the form layout exactly
  row[0] = new Date();                          // A — Timestamp
  row[1] = data.email;                          // B — Email Address
  row[2] = data.isNew                           // C — New Customer?
    ? targetNewStatus
    : "Nope! I am back for more! 😋";
  row[3] = data.name;                           // D — First and Last Name
  row[4] = data.phone;                          // E — Phone
  row[5] = data.address;                        // F — Delivery Address

  // Item columns — match by header text (pint/quart/salad + item name)
  (data.items || []).forEach(function(item) {
    var sizeLower = (item.size || "").toLowerCase();
    var nameLower = (item.name || "").toLowerCase();
    headers.forEach(function(h, i) {
      var hLower    = h.toString().toLowerCase();
      var nameMatch = hLower.includes(nameLower.substring(0, 12));
      var sizeMatch =
        (sizeLower.includes("pint")   && hLower.includes("pint"))   ||
        (sizeLower.includes("quart")  && hLower.includes("quart"))  ||
        (sizeLower.includes("single") && hLower.includes("salad"));
      if (nameMatch && sizeMatch) row[i] = (parseFloat(row[i]) || 0) + item.qty;
    });
  });

  // Comments column
  var commentCol = headers.findIndex(function(h) {
    return /comment|special instruction/i.test(h.toString());
  });
  if (commentCol >= 0) row[commentCol] = data.notes || "";

  // Payment column
  var payCol = headers.findIndex(function(h) {
    return /how will you be paying/i.test(h.toString());
  });
  if (payCol < 0) payCol = headers.findIndex(function(h) { return /pay/i.test(h.toString()); });
  if (payCol >= 0) row[payCol] = data.payment === "venmo"
    ? "Venmo (QR Code Provided Here)" : "Cash on Delivery";

  return row;
}

// Adds/updates one customer in the Customers sheet after an app order
function syncSingleCustomer(ss, data) {
  var customerSheet = ss.getSheetByName(customerSheetName);
  if (!customerSheet) return;

  var customerData = customerSheet.getDataRange().getValues();
  var emailKey     = data.email.toString().toLowerCase();
  var now          = new Date();

  // Look for existing row
  for (var i = 1; i < customerData.length; i++) {
    var rowEmail = (customerData[i][emailIndexInCustomerSheet] || "").toString().toLowerCase();
    if (rowEmail === emailKey) {
      // Update Last Order Date (col E = lastOrderColIndex = 5, 1-based)
      var current = customerSheet.getRange(i + 1, lastOrderColIndex).getValue();
      if (!current || now > new Date(current)) {
        customerSheet.getRange(i + 1, lastOrderColIndex).setValue(now);
      }
      sortCustomersByDate();
      return;
    }
  }

  // New customer — add row if flagged as new
  if (data.isNew) {
    customerSheet.appendRow([data.email, data.name, data.phone, data.address, now]);
    sortCustomersByDate();
  }
}


// ════════════════════════════════════════════════════════════════
//  ORIGINAL SYNC FUNCTION — unchanged, keep for form submissions
// ════════════════════════════════════════════════════════════════

function sortCustomersByDate() {
  var ss            = SpreadsheetApp.getActiveSpreadsheet();
  var customerSheet = ss.getSheetByName(customerSheetName);
  if (!customerSheet) return;
  var lastRow = customerSheet.getLastRow();
  var lastCol = customerSheet.getLastColumn();
  if (lastRow <= 1) return;
  customerSheet.getRange(2, 1, lastRow - 1, lastCol)
    .sort({ column: lastOrderColIndex, ascending: false });
}

function syncCustomers() {
  var ss            = SpreadsheetApp.getActiveSpreadsheet();
  var formSheet     = ss.getSheetByName(formSheetName);
  var customerSheet = ss.getSheetByName(customerSheetName);
  if (!formSheet || !customerSheet) return;

  var formResponses = formSheet.getDataRange().getValues();
  var customerData  = customerSheet.getDataRange().getValues();

  var customerMap = {};
  customerData.forEach(function(row, index) {
    var email = row[emailIndexInCustomerSheet];
    if (email) customerMap[email.toString().toLowerCase()] = index + 1;
  });

  var newCustomers = [];

  for (var i = 1; i < formResponses.length; i++) {
    var row         = formResponses[i];
    var timestamp   = row[timestampColumnIndex - 1];
    var email       = row[uniqueIdColumnIndex - 1];
    var statusEntry = row[newCustomerStatusIndex - 1];

    if (!email || !email.toString().includes('@')) continue;

    var emailKey           = email.toString().toLowerCase();
    var isNewCustomerEntry = (statusEntry && statusEntry.toString().trim() === targetNewStatus);

    if (customerMap[emailKey]) {
      var existingRow      = customerMap[emailKey];
      var currentSavedDate = customerSheet.getRange(existingRow, lastOrderColIndex).getValue();
      if (!currentSavedDate || new Date(timestamp) > new Date(currentSavedDate)) {
        customerSheet.getRange(existingRow, lastOrderColIndex).setValue(timestamp);
      }
    } else if (isNewCustomerEntry) {
      var newCustomerRow = customerDataIndices.map(function(colIndex) { return row[colIndex - 1]; });
      newCustomerRow[4]  = timestamp;
      newCustomers.push(newCustomerRow);
      customerMap[emailKey] = true;
    }
  }

  if (newCustomers.length > 0) {
    customerSheet.getRange(customerSheet.getLastRow() + 1, 1,
      newCustomers.length, newCustomers[0].length).setValues(newCustomers);
  }

  sortCustomersByDate();
}


// ════════════════════════════════════════════════════════════════
//  ORIGINAL REMINDER FUNCTIONS — unchanged
// ════════════════════════════════════════════════════════════════

function sendSoupReminders(subject) {
  var ss            = SpreadsheetApp.getActiveSpreadsheet();
  var formSheet     = ss.getSheetByName(formSheetName);
  var customerSheet = ss.getSheetByName(customerSheetName);
  if (!formSheet || !customerSheet) return;

  var startOfWeek   = getStartOfWeek();
  var todayStr      = new Date().toDateString();
  var customerData  = customerSheet.getDataRange().getValues();
  var formResponses = formSheet.getDataRange().getValues().slice(1);

  var thisWeekOrders = formResponses.filter(function(row) {
    var timestamp = row[timestampColumnIndex - 1];
    return timestamp instanceof Date && timestamp.getTime() >= startOfWeek.getTime();
  });

  var orderedEmails = {};
  thisWeekOrders.forEach(function(row) {
    orderedEmails[row[uniqueIdColumnIndex - 1].toString().toLowerCase()] = true;
  });

  var emailsSentThisRun = 0;
  var quota             = MailApp.getRemainingDailyQuota();

  for (var i = 1; i < customerData.length; i++) {
    var row           = customerData[i];
    var email         = row[emailIndexInCustomerSheet] ? row[emailIndexInCustomerSheet].toString().toLowerCase() : "";
    var name          = row[nameIndexInCustomerData];
    var lastEmailDate = row[lastEmailDateColIndex - 1];
    var lastEmailStr  = lastEmailDate instanceof Date ? lastEmailDate.toDateString() : "";

    if (email && email.includes('@') && !orderedEmails[email] && lastEmailStr !== todayStr) {
      if (emailsSentThisRun >= quota) break;
      try {
        var body = generateEmailBody(subject, name);
        GmailApp.sendEmail(email, subject, "", {
          htmlBody: body,
          from:     SENDER_EMAIL,
          name:     SENDER_NAME
        });
        customerSheet.getRange(i + 1, lastEmailDateColIndex).setValue(new Date());
        emailsSentThisRun++;
      } catch(e) {
        Logger.log("Error sending to " + email + ": " + e.toString());
      }
    }
  }
  Logger.log("Reminders sent: " + emailsSentThisRun);
}

function generateEmailBody(subject, customerName) {
  var subjectStr     = String(subject || "");
  var greeting       = (customerName && customerName.toString().length > 1)
    ? "Hi " + customerName + "," : "Hi there,";
  var contentHtml, buttonColor, buttonTextColor;

  if (subjectStr.includes("Last Chance") || subjectStr.includes("7 PM")) {
    buttonColor     = "#A0522D";
    buttonTextColor = "#ffffff";
    contentHtml     = '<p style="color: #c0392b; font-size: 18px; font-weight: bold; margin-top: 0;">Last Call for Soup!</p>' +
      '<p>To ensure everyone gets the freshest ingredients, we\'re finalizing quantities today.</p>' +
      '<p><b>Don\'t miss out — once we close orders, the pots start simmering! 🍲💛</b></p>';
  } else {
    buttonColor     = "#D2B48C";
    buttonTextColor = "#000000";
    contentHtml     = '<p style="font-size: 18px; font-weight: 600; margin-top: 0;">It\'s Soup Week!</p>' +
      '<p>Our kitchen is busy preparing to craft another batch of your favorite soups with the freshest ingredients.</p>' +
      '<p>Place your order today to ensure stress-free meals delivered Monday!</p>';
  }

  var buttonHtml = '<table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin: 30px 0;">' +
    '<tr><td align="center"><table border="0" cellpadding="0" cellspacing="0">' +
    '<tr><td align="center" bgcolor="' + buttonColor + '" style="border-radius: 6px;">' +
    '<a href="' + orderLink + '" target="_blank" style="font-size: 16px; font-family: Arial, sans-serif; color: ' + buttonTextColor + ' !important; text-decoration: none; padding: 12px 25px; border-radius: 6px; display: inline-block; font-weight: bold;">' +
    'See This Week\'s Soups & Order Now</a>' +
    '</td></tr></table></td></tr></table>';

  return '<div style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 20px;">' +
    '<table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.1);">' +
    '<tr><td align="center" style="padding: 20px; background-color: #5D4037; border-top-left-radius: 8px; border-top-right-radius: 8px;">' +
    '<img src="' + LOGO_URL + '" alt="Logo" width="150" style="display: block;"></td></tr>' +
    '<tr><td style="padding: 30px; color: #333333; font-size: 15px; line-height: 1.6;">' +
    '<p style="font-weight: bold;">' + greeting + '</p>' +
    contentHtml + buttonHtml +
    '<p>Thanks for supporting our kitchen!</p>' +
    '<p><b>The Ladle & Spoon Team</b></p></td></tr>' +
    '<tr><td align="center" style="padding: 15px; font-size: 12px; color: #777777; background-color: #eeeeee; border-bottom-left-radius: 8px; border-bottom-right-radius: 8px;">' +
    '<p style="margin: 0;">Questions? Email us at ' + SENDER_EMAIL + '</p>' +
    '<p style="margin: 5px 0 0 0;">&copy; ' + new Date().getFullYear() + ' Ladle & Spoon</p>' +
    '</td></tr></table></div>';
}

function getStartOfWeek() {
  var today        = new Date();
  var dayOfWeek    = today.getDay();
  var daysToSubtract = (dayOfWeek === 0) ? 6 : dayOfWeek - 1;
  var monday       = new Date(today.getTime());
  monday.setDate(today.getDate() - daysToSubtract);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function triggerThursdayReminder() {
  sendSoupReminders("Your Weekly Soup Reminder from Ladle & Spoon");
}

function triggerFridayReminder() {
  sendSoupReminders("Last Chance for Soup! Order by 7 PM Tonight");
}

// Tuesday — menu is live (uses same HTML template, neutral style)
function triggerTuesdayAnnouncement() {
  sendSoupReminders("🥣 This Week's Ladle & Spoon Menu is Live!");
  sendPushForTuesday(); // also sends push notification to opted-in customers
}


// ════════════════════════════════════════════════════════════════
//  SUBSCRIBER SWAP
// ════════════════════════════════════════════════════════════════

function handleSwap(data) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Subscriber Swaps") || ss.insertSheet("Subscriber Swaps");
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1,1,1,5).setValues([["Timestamp","Email","Name","New Soup","New Salad"]]);
  }
  sheet.appendRow([new Date(), data.email||"", data.name||"", data.soup||"", data.salad||""]);
  GmailApp.sendEmail(LIA_EMAIL,
    "🔄 Subscriber Swap — " + (data.name || data.email),
    (data.name || data.email) + " wants to swap this week:\n\n" +
    "  Soup:  " + (data.soup  || "no change") + "\n" +
    "  Salad: " + (data.salad || "no change") + "\n\nPlease update before Monday."
  );
  return jsonResponse({ success: true });
}


// ════════════════════════════════════════════════════════════════
//  PUSH TOKEN STORAGE
// ════════════════════════════════════════════════════════════════

function handleNotificationToken(data) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Push Tokens") || ss.insertSheet("Push Tokens");
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1,1,1,3).setValues([["Email","Token","Subscribed At"]]);
  }
  var tokens = sheet.getDataRange().getValues();
  var found  = -1;
  tokens.forEach(function(r, i) { if (i > 0 && r[0] === data.email) found = i; });
  if (found >= 0) {
    sheet.getRange(found + 1, 2, 1, 2).setValues([[data.token, new Date()]]);
  } else {
    sheet.appendRow([data.email, data.token, new Date()]);
  }
  return jsonResponse({ success: true });
}


// ════════════════════════════════════════════════════════════════
//  CONFIRMATION EMAIL TO CUSTOMER (HTML, matches existing style)
// ════════════════════════════════════════════════════════════════

function sendConfirmationEmail(data) {
  try {
    var itemRows = (data.items || []).map(function(i) {
      return '<tr><td style="padding:4px 0;color:#333">' + i.name + ' (' + i.size + ' × ' + i.qty + ')</td>' +
             '<td style="padding:4px 0;color:#333;text-align:right;">$' + (i.price * i.qty).toFixed(2) + '</td></tr>';
    }).join('');

    var payLine = data.payment === "venmo"
      ? 'Please send <strong>$' + data.total.toFixed(2) + '</strong> via Venmo to <strong>' + VENMO_HANDLE + '</strong><br>Use your name as the note.'
      : 'Please have <strong>$' + data.total.toFixed(2) + '</strong> cash ready for Monday delivery.';

    var html = '<div style="font-family:Arial,sans-serif;background-color:#f4f4f4;padding:20px;">' +
      '<table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;box-shadow:0 4px 8px rgba(0,0,0,0.1);">' +
      '<tr><td align="center" style="padding:20px;background-color:#5D4037;border-top-left-radius:8px;border-top-right-radius:8px;">' +
      '<img src="' + LOGO_URL + '" alt="Ladle & Spoon" width="150" style="display:block;"></td></tr>' +
      '<tr><td style="padding:30px;color:#333;font-size:15px;line-height:1.6;">' +
      '<p style="font-weight:bold;">Hi ' + data.name.split(' ')[0] + ',</p>' +
      '<p style="font-size:18px;font-weight:600;margin-top:0;">Your order is confirmed! 🥣</p>' +
      '<p>We\'ll see you Monday for delivery.</p>' +
      '<table width="100%" style="border-top:1px solid #eee;border-bottom:1px solid #eee;margin:16px 0;padding:8px 0;">' +
      itemRows +
      '<tr><td style="padding:8px 0 4px;font-size:12px;color:#888;">Delivery fee</td>' +
      '<td style="padding:8px 0 4px;font-size:12px;color:#888;text-align:right;">$' + (data.deliveryFee || 5).toFixed(2) + '</td></tr>' +
      '<tr><td style="padding:4px 0;font-weight:bold;font-size:16px;">Total</td>' +
      '<td style="padding:4px 0;font-weight:bold;font-size:16px;text-align:right;">$' + data.total.toFixed(2) + '</td></tr>' +
      '</table>' +
      '<p><strong>Payment:</strong><br>' + payLine + '</p>' +
      '<p><strong>Delivery address:</strong><br>' + data.address + '</p>' +
      (data.notes ? '<p><strong>Your notes:</strong><br>' + data.notes + '</p>' : '') +
      '<p>Questions? Reply to this email.</p>' +
      '<p><b>The Ladle & Spoon Team</b></p></td></tr>' +
      '<tr><td align="center" style="padding:15px;font-size:12px;color:#777;background:#eee;border-bottom-left-radius:8px;border-bottom-right-radius:8px;">' +
      '<p style="margin:0;">Questions? Email us at ' + SENDER_EMAIL + '</p>' +
      '<p style="margin:5px 0 0;">&copy; ' + new Date().getFullYear() + ' Ladle & Spoon</p>' +
      '</td></tr></table></div>';

    GmailApp.sendEmail(data.email, "✅ Your Ladle & Spoon order is confirmed!", "", {
      htmlBody: html,
      from:     SENDER_EMAIL,
      name:     SENDER_NAME
    });
  } catch(err) {
    Logger.log("Confirmation email error: " + err.message);
  }
}


// ════════════════════════════════════════════════════════════════
//  SETUP — installs all triggers (run once)
// ════════════════════════════════════════════════════════════════

function setupAll() {
  // Remove existing clock triggers to prevent duplicates
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getTriggerSource() === ScriptApp.TriggerSource.CLOCK) {
      ScriptApp.deleteTrigger(t);
    }
  });

  // Tuesday 10 AM — menu announcement
  ScriptApp.newTrigger("triggerTuesdayAnnouncement")
    .timeBased().onWeekDay(ScriptApp.WeekDay.TUESDAY).atHour(10).create();

  // Thursday 10 AM — weekly reminder
  ScriptApp.newTrigger("triggerThursdayReminder")
    .timeBased().onWeekDay(ScriptApp.WeekDay.THURSDAY).atHour(10).create();

  // Friday 11 AM — last chance
  ScriptApp.newTrigger("triggerFridayReminder")
    .timeBased().onWeekDay(ScriptApp.WeekDay.FRIDAY).atHour(11).create();

  // Log confirmation (no alert — avoids timeout waiting for UI)
  Logger.log("✅ Triggers installed: Tuesday 10AM, Thursday 10AM, Friday 11AM");
}

// Run this separately to confirm triggers are installed
function checkTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  var msg = "Current triggers (" + triggers.length + "):\n";
  triggers.forEach(function(t) {
    msg += "• " + t.getHandlerFunction() + " — " + t.getTriggerSource() + "\n";
  });
  Logger.log(msg);
  SpreadsheetApp.getUi().alert(msg);
}


// ════════════════════════════════════════════════════════════════
//  INTELLIGENCE SCRIPT — with salad price fix
// ════════════════════════════════════════════════════════════════

function generateLadleAndSpoonIntelligence() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = ss.getSheets();
  const monthlyData = {}, customerData = {}, intelData = {}, geoData = {}, weeklyFeb = [];

  sheets.forEach(sheet => {
    const name = sheet.getName();
    if (!name.includes("/") && name !== "Soup orders") return;

    let sDate = (name === "Soup orders") ?
      (sheet.getRange("A1").getValue() instanceof Date ? sheet.getRange("A1").getValue() : new Date()) :
      new Date(name.split('/')[0] < 3 ? 2026 : 2025, name.split('/')[0]-1, name.split('/')[1]);

    let dDate = Utilities.formatDate(sDate, ss.getSpreadsheetTimeZone(), "M/d/yy");
    const data = sheet.getDataRange().getValues();
    if (data.length < 5) return;

    const mKey = (sDate.getMonth() + 1) + "/" + sDate.getFullYear();
    if (!monthlyData[mKey]) monthlyData[mKey] = { s:0, sal:0, muf:0, p3:0, del:0, wks:0, ts: sDate.getTime() };

    const p3Value = parseFloat(sheet.getRange("P3").getValue()) || 0;
    monthlyData[mKey].p3 += p3Value;
    monthlyData[mKey].wks += 1;
    if (mKey === "2/2026") weeklyFeb.push([dDate, p3Value]);

    const head = data[3];
    let colMap = [], eCol = -1, nameCol = -1, addrCol = -1;

    head.forEach((c, i) => {
      let v = c.toString().toLowerCase();
      if (v.includes("email"))                              eCol     = i;
      // FIX: detect combined "first and last name" column as well as split columns
      if (v.includes("first and last") || v.includes("first name")) nameCol = i;
      if (v.includes("address") || v.includes("street"))   addrCol  = i;

      if (v.includes("salad")) {
        // FIX: read actual price from header instead of hardcoded $13
        let priceMatch = c.toString().match(/\$(\d+)/);
        let price = priceMatch ? parseInt(priceMatch[1]) : 13;
        colMap[i] = { type: "Salad", price: price, unit: "Unit" };
      } else if (v.includes("muffin") || v.includes("bread") || v.includes("loaf")) {
        colMap[i] = { type: "Bakery", price: (v.includes("loaf") || v.includes("bread")) ? 10 : 3, unit: "Unit" };
      } else if (v.includes("pint") || v.includes("quart")) {
        colMap[i] = { type: "Soup", isQ: v.includes("quart"), unit: "Oz" };
      }
    });

    for (let i = 4; i < data.length; i++) {
      const r     = data[i];
      const email = eCol !== -1 ? r[eCol] : null;
      if (!email || !email.toString().includes("@")) continue;

      let rawAddr = (addrCol !== -1 && r[addrCol]) ? r[addrCol].toString().toUpperCase() : "";
      let street  = normalizeStreet(rawAddr);

      if (!customerData[email]) {
        // FIX: read name from the combined name column
        let fullName = (nameCol !== -1 ? r[nameCol] : "").toString().trim() || "Customer";
        customerData[email] = { name: fullName, ltv: 0, orders: 0, last: dDate, lastTS: sDate.getTime() };
      }

      let rowRev = 0, hasOrder = false;
      colMap.forEach((meta, idx) => {
        let q = parseFloat(r[idx]) || 0;
        if (q > 0) {
          hasOrder = true;
          let flavorClean = head[idx].toString().toUpperCase()
            .replace(/[\[\]\(\),/]/g, "").replace(/SOUP ORDER\?|PINTS?|QUARTS?|EA|ONLY|SOLD OUT|MUFFINS?|BREAD|LOAF|LOAVES|CH$|\$?\d+/gi, "").trim();

          let key = meta.type + ":" + flavorClean;
          if (!intelData[key]) intelData[key] = { type: meta.type, flavor: flavorClean, qty: 0, rev: 0, weeklySales: {}, unit: meta.unit };

          let itemRev = (meta.type === "Soup")
            ? (q * (sDate.getFullYear() === 2026 ? (meta.isQ ? 15 : 8) : (meta.isQ ? 14 : 7)))
            : (q * meta.price); // uses actual price from header now
          intelData[key].qty += (meta.type === "Soup") ? (q * (meta.isQ ? 32 : 16)) : q;
          intelData[key].rev += itemRev;
          intelData[key].weeklySales[dDate] = (intelData[key].weeklySales[dDate] || 0) + itemRev;

          rowRev += itemRev;
          if      (meta.type === "Soup")   monthlyData[mKey].s   += itemRev;
          else if (meta.type === "Salad")  monthlyData[mKey].sal += itemRev;
          else                             monthlyData[mKey].muf += itemRev;
        }
      });

      if (hasOrder) {
        customerData[email].ltv += (rowRev + (sDate.getFullYear() === 2026 ? 5 : 0));
        customerData[email].orders += 1;
        monthlyData[mKey].del += (sDate.getFullYear() === 2026 ? 5 : 0);
        if (street && street !== "UNKNOWN") {
          if (!geoData[street]) geoData[street] = { customers: new Set(), totalOrders: 0 };
          geoData[street].customers.add(email);
          geoData[street].totalOrders += 1;
        }
      }
    }
  });

  writeMonthly(ss, monthlyData, weeklyFeb);
  writeCustomers(ss, customerData);
  writeIntelligence(ss, intelData);
  writeReactivation(ss, customerData);
  writeGeoDensity(ss, geoData);
}

function normalizeStreet(addr) {
  if (!addr) return "UNKNOWN";
  let part = addr.split(',')[0].replace(/[0-9]/g, '').trim();
  return part.replace(/\b(STREET|ST|AVENUE|AVE|DRIVE|DR|ROAD|RD|COURT|CT|LANE|LN|BOULEVARD|BLVD|CIRCLE|CIR|WAY|TRAIL|TRL)\b/g, "").trim();
}

function writeMonthly(ss, dObj, extra) {
  let s = ss.getSheetByName("Monthly Analysis") || ss.insertSheet("Monthly Analysis"); s.clear();
  let out = [["Month","Soup","Salad","Muffin","Misc/Addons","Delivery","Total w/o Del","Grand Total","Avg/Wk"]];
  Object.keys(dObj).sort((a,b) => dObj[a].ts - dObj[b].ts).forEach(k => {
    let d = dObj[k], misc = Math.max(0, d.p3 - (d.s + d.sal + d.muf));
    out.push([k, d.s, d.sal, d.muf, misc, d.del, d.p3, d.p3 + d.del, d.p3 / d.wks]);
  });
  out.push([""], ["FEBRUARY WEEKLY DETAIL","Revenue (P3)"]);
  extra.forEach(r => out.push([r[0], r[1]]));
  s.getRange(1, 1, out.length, 9).setValues(fillEmpty(out, 9));
  s.getRange("B2:I").setNumberFormat("$#,##0.00");
}

function writeCustomers(ss, dObj) {
  let s = ss.getSheetByName("Customer Deep Dive") || ss.insertSheet("Customer Deep Dive"); s.clear();
  let out = [["Name","Email","Est. LTV","Orders","Last Order"]];
  Object.keys(dObj).forEach(k => { let d = dObj[k]; out.push([d.name, k, d.ltv, d.orders, d.last]); });
  if (out.length > 1) {
    s.getRange(1, 1, out.length, 5).setValues(out).sort({column: 3, ascending: false});
    s.getRange("C2:C").setNumberFormat("$#,##0.00");
  }
}

function writeIntelligence(ss, iLog) {
  let s = ss.getSheetByName("Soup Intelligence") || ss.insertSheet("Soup Intelligence"); s.clear();
  let out = [["Category","Flavor","Total Qty","Unit","Total Revenue","Weeks","Avg Rev/Wk","Last Week Rev","Trend"]];
  Object.keys(iLog).forEach(k => {
    let d = iLog[k], weeks = Object.keys(d.weeklySales).length, avg = d.rev / weeks;
    let dates   = Object.keys(d.weeklySales).sort((a,b) => new Date(b) - new Date(a));
    let lastRev = d.weeklySales[dates[0]];
    let trend   = weeks > 1 ? (lastRev > avg*1.1 ? "📈 Growing" : (lastRev < avg*0.9 ? "📉 Declining" : "Stable")) : "New";
    out.push([d.type, d.flavor, d.qty, d.unit, d.rev, weeks, avg, lastRev, trend]);
  });
  if (out.length > 1) {
    s.getRange(1, 1, out.length, 9).setValues(out).sort({column: 7, ascending: false});
    s.getRange("E2:E").setNumberFormat("$#,##0.00");
    s.getRange("F2:F").setNumberFormat("0");
    s.getRange("G2:H").setNumberFormat("$#,##0.00");
  }
}

function writeReactivation(ss, cData) {
  let s = ss.getSheetByName("Reactivation List") || ss.insertSheet("Reactivation List"); s.clear();
  let out = [["Name","Email","Last Order","Days Since","Total Orders"]], now = new Date().getTime();
  Object.keys(cData).forEach(e => {
    let d = cData[e], diff = Math.floor((now - d.lastTS) / 86400000);
    if (d.orders >= 3 && diff > 21) out.push([d.name, e, d.last, diff, d.orders]);
  });
  if (out.length > 1) s.getRange(1, 1, out.length, 5).setValues(out).sort({column: 4, ascending: false});
}

function writeGeoDensity(ss, gLog) {
  let s = ss.getSheetByName("Geo Density") || ss.insertSheet("Geo Density"); s.clear();
  let out = [["Street/Cluster","Unique Customers","Total Deliveries","Density Score"]];
  Object.keys(gLog).forEach(st => {
    let d = gLog[st], score = d.customers.size * d.totalOrders;
    out.push([st, d.customers.size, d.totalOrders, score]);
  });
  if (out.length > 1) {
    s.getRange(1, 1, out.length, 4).setValues(out).sort({column: 4, ascending: false});
    let range = s.getRange(2, 4, out.length - 1, 1);
    let rule  = SpreadsheetApp.newConditionalFormatRule()
      .whenNumberGreaterThan(0).setBackground("#d9ead3").setRanges([range]).build();
    s.setConditionalFormatRules([rule]);
  }
}

function fillEmpty(arr, width) {
  return arr.map(row => { while(row.length < width) row.push(""); return row; });
}


// ════════════════════════════════════════════════════════════════
//  UTILITY
// ════════════════════════════════════════════════════════════════


// ════════════════════════════════════════════════════════════════
//  PUSH BROADCAST — sends notification to all token subscribers
//  Requires: FCM Server Key from Firebase Console
//  Project Settings → Cloud Messaging → Server key (Legacy)
// ════════════════════════════════════════════════════════════════

// PASTE YOUR SERVER KEY HERE (Firebase Console → Project Settings → Cloud Messaging)
var FCM_SERVER_KEY = 'PASTE_YOUR_SERVER_KEY_HERE';

function handleBroadcast(data) {
  var ss     = SpreadsheetApp.getActiveSpreadsheet();
  var sheet  = ss.getSheetByName("Push Tokens");
  if (!sheet || sheet.getLastRow() < 2) {
    Logger.log("No push tokens found");
    return jsonResponse({ success: false, error: "No subscribers" });
  }

  var tokens = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getValues()
    .map(function(r) { return r[0]; })
    .filter(function(t) { return t && t.length > 10; });

  if (tokens.length === 0) {
    return jsonResponse({ success: false, error: "No valid tokens" });
  }

  var sent = sendFCMNotification(
    tokens,
    data.title || '🥣 Ladle & Spoon',
    data.body  || "Check this week's menu!"
  );

  Logger.log("Broadcast sent to " + sent + " devices");
  return jsonResponse({ success: true, sent: sent });
}

function sendFCMNotification(tokens, title, body) {
  if (!FCM_SERVER_KEY || FCM_SERVER_KEY === 'PASTE_YOUR_SERVER_KEY_HERE') {
    Logger.log("FCM_SERVER_KEY not set — skipping push send");
    return 0;
  }

  var sent = 0;
  // Send in batches of 500 (FCM limit per request)
  var batchSize = 500;
  for (var i = 0; i < tokens.length; i += batchSize) {
    var batch = tokens.slice(i, i + batchSize);
    var payload = {
      registration_ids: batch,
      notification: {
        title: title,
        body:  body,
        icon:  'https://res.cloudinary.com/drcjmvjc9/image/upload/v1762996224/Ladle_and_Spoon_Logo_Clean_pylcav.png'
      },
      data: {
        url: 'https://tonyedmonds2003.github.io/OCBC'
      }
    };

    try {
      var response = UrlFetchApp.fetch('https://fcm.googleapis.com/fcm/send', {
        method:  'post',
        headers: {
          'Authorization': 'key=' + FCM_SERVER_KEY,
          'Content-Type':  'application/json'
        },
        payload:            JSON.stringify(payload),
        muteHttpExceptions: true
      });
      var result = JSON.parse(response.getContentText());
      Logger.log("FCM batch result: " + JSON.stringify(result));
      sent += (result.success || 0);
    } catch(err) {
      Logger.log("FCM send error: " + err.message);
    }
  }
  return sent;
}

// Call this from the scheduler triggers to send push + email together
function sendPushForTuesday() {
  var ss     = SpreadsheetApp.getActiveSpreadsheet();
  var title  = '🥣 This week\'s Ladle & Spoon menu is live!';
  var body   = 'Order by Friday 6 PM for Monday delivery!';
  var sheet  = ss.getSheetByName("Push Tokens");
  if (sheet && sheet.getLastRow() > 1) {
    var tokens = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getValues()
      .map(function(r) { return r[0]; }).filter(function(t) { return t; });
    sendFCMNotification(tokens, title, body);
    Logger.log("Tuesday push sent to " + tokens.length + " subscribers");
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


// ════════════════════════════════════════════════════════════════
//  TESTS
// ════════════════════════════════════════════════════════════════

function testOrder() {
  var result = handleOrder({
    type: "order", id: "#TEST01",
    name: "Test Customer", email: LIA_EMAIL,
    phone: "2485550000", address: "123 Test St, Waterford MI 48328",
    isNew: false, payment: "venmo",
    notes: "Test — please delete this row",
    total: 23.00, deliveryFee: 5,
    items: [
      { name: "Split Pea w/ Bacon",          size: "Quart",  qty: 1, price: 15 },
      { name: "Goat Cheese Blueberry Salad", size: "Single", qty: 1, price: 15 }
    ]
  });
  Logger.log(result.getContent());
  SpreadsheetApp.getUi().alert(
    "Test complete!\n\nCheck the 'Soup orders' tab for a new row,\nand your email for an HTML confirmation."
  );
}

function testReminder() {
  var ss   = SpreadsheetApp.getActiveSpreadsheet();
  var body = generateEmailBody("Your Weekly Soup Reminder from Ladle & Spoon", "Lia");
  GmailApp.sendEmail(LIA_EMAIL, "⏰ [TEST] Reminder preview", "", {
    htmlBody: body, from: SENDER_EMAIL, name: SENDER_NAME
  });
  SpreadsheetApp.getUi().alert("HTML reminder preview sent to " + LIA_EMAIL);
}
