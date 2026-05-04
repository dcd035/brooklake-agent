const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --- RC4 encryption ---
function rc4(key, data) {
  const keyBytes = Buffer.from(key, 'utf8');
  const dataBytes = Buffer.from(data, 'utf8');
  const S = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + keyBytes[i % keyBytes.length]) % 256;
    [S[i], S[j]] = [S[j], S[i]];
  }
  let i = 0; j = 0;
  const out = [];
  for (const byte of dataBytes) {
    i = (i + 1) % 256;
    j = (j + S[i]) % 256;
    [S[i], S[j]] = [S[j], S[i]];
    out.push(byte ^ S[(S[i] + S[j]) % 256]);
  }
  return Buffer.from(out).toString('hex').toUpperCase();
}

async function bookTeeTime(params) {
  const { username, password, bookingDate, outingTime, bookerFirstName, bookerLastName, bookerEmail, guestNames = [] } = params;
  const log = [];
  const addLog = (msg) => { console.log(msg); log.push(msg); };
  let browser;
  try {
    addLog('Launching browser...');
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();

    addLog('Loading Brooklake login page...');
    await page.goto('https://www.brooklakecc.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });

    const encKey = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script'));
      for (const s of scripts) { const m = s.textContent.match(/var\s+k\s*=\s*['"]([^'"]+)['"]/); if (m) return m[1]; }
      const inp = document.querySelector('input[name="k"], input[id="k"]');
      return inp ? inp.value : null;
    });

    let rc4Key = encKey;
    if (!rc4Key) {
      const keyResp = await page.evaluate(async () => { const r = await fetch('/default.aspx?p=login&ajax=true&action=getkey', { method: 'GET', credentials: 'include' }); return r.text(); });
      try { const p = JSON.parse(keyResp); rc4Key = p.key || p.Key || keyResp.trim(); } catch { rc4Key = keyResp.trim(); }
    }
    if (!rc4Key) throw new Error('Could not retrieve RC4 key');
    addLog('Got RC4 key length: ' + rc4Key.length);

    const encUser = rc4(rc4Key, username);
    const encPass = rc4(rc4Key, password);
    const loginResp = await page.evaluate(async ({ encUser, encPass }) => {
      const r = await fetch('/default.aspx?p=login&ajax=true', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=' + encodeURIComponent(encUser) + '&password=' + encodeURIComponent(encPass) });
      return r.text();
    }, { encUser, encPass });

    let loginOk = false;
    try { const p = JSON.parse(loginResp); loginOk = p.success === true || p.Success === true || p.result === 'success' || loginResp.includes('success'); } catch { loginOk = loginResp.toLowerCase().includes('success') || loginResp.includes('1'); }
    if (!loginOk) { await page.goto('https://www.brooklakecc.com/default.aspx', { waitUntil: 'domcontentloaded', timeout: 15000 }); loginOk = !page.url().includes('login'); }
    if (!loginOk) throw new Error('Login failed');
    addLog('Login successful');

    function to24Hour(timeStr) {
      const m = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (!m) return timeStr;
      let h = parseInt(m[1], 10); const min = m[2], period = m[3].toUpperCase();
      if (period === 'AM' && h === 12) h = 0;
      if (period === 'PM' && h !== 12) h += 12;
      return String(h).padStart(2, '0') + ':' + min;
    }
    const timeFor24 = to24Hour(outingTime);
    addLog('Time converted: ' + outingTime + ' -> ' + timeFor24);

    const dialogUrl = 'https://www.brooklakecc.com/dialog.aspx?p=NetcaddyPop&tt=MakeTeeTime&NoModResize=1&NoNav=1&ShowFooter=False&courseid=1&date=' + encodeURIComponent(bookingDate) + '&time=' + encodeURIComponent(timeFor24) + '&hole=1&numholes=0&xsome=4&startletter=';
    addLog('Navigating to: ' + dialogUrl);
    await page.goto(dialogUrl, { waitUntil: 'networkidle', timeout: 30000 });

    addLog('Waiting for booking form...');
    try { await page.waitForSelector('select[id*="drpPartySize"], input[id*="drpPartySize"], a[id*="lbBook"], input[id*="lbBook"]', { timeout: 10000 }); addLog('Form loaded'); }
    catch { const t = await page.evaluate(() => document.body.innerText.substring(0, 300)); addLog('Form timeout - content: ' + t); }

    const validGuests = (guestNames || []).filter(n => n && n.trim());
    const partySize = validGuests.length === 0 ? 'Single' : validGuests.length === 1 ? 'Twosome' : validGuests.length === 2 ? 'Threesome' : 'Foursome';
    addLog('Party size: ' + partySize);

    try { await page.selectOption('select[id*="drpPartySize"], select[name*="drpPartySize"]', { label: partySize }, { timeout: 5000 }); addLog('Set party size'); }
    catch { addLog('Select fallback'); await page.evaluate((size) => { const inputs = Array.from(document.querySelectorAll('input[id*="drpPartySize"]')); for (const inp of inputs) { if (inp.type !== 'hidden') { inp.value = size; return; } } }, partySize); }

    await page.waitForTimeout(1000);

    for (let i = 0; i < Math.min(validGuests.length, 3); i++) {
      const playerNum = i + 2; const guestName = validGuests[i];
      const playerInput = await page.$('input[id*="P' + playerNum + '_PCombo_PlayerName"]:not([type="hidden"])');
      if (playerInput) { await playerInput.click({ clickCount: 3 }); await playerInput.type(guestName, { delay: 50 }); await page.waitForTimeout(800); await page.keyboard.press('Escape'); }
    }

    const bookBtn = await page.$('a[id*="lbBook"], input[id*="lbBook"], button[id*="lbBook"], a:has-text("Make Tee Time"), a:has-text("Book"), button:has-text("Book")');
    if (!bookBtn) { const t = await page.evaluate(() => document.body.innerText.substring(0, 500)); throw new Error('No Book button. Page: ' + t); }
    addLog('Clicking Book button...');
    await bookBtn.click();
    await page.waitForTimeout(4000);

    const resultText = await page.evaluate(() => document.body.innerText);
    const resultHtml = await page.evaluate(() => document.body.innerHTML.substring(0, 2000));
    addLog('Result (300): ' + resultText.substring(0, 300));

    const confirmed = /confirmation|confirmed|booking.*success|tee time.*booked|receipt/i.test(resultText) || /lbConfirm|ConfirmationNumber|confirmation/i.test(resultHtml);
    const unavailable = /not available|unavailable|already booked|tee time.*taken|no.*available/i.test(resultText);
    let bookingStatus, bookingMessage;
    if (confirmed) { bookingStatus = 'confirmed'; const match = resultText.match(/confirmation[^0-9]*([0-9]+)/i); bookingMessage = match ? 'Booking confirmed #' + match[1] : 'Booking confirmed.'; }
    else if (unavailable) { bookingStatus = 'unavailable'; bookingMessage = 'Tee time not available.'; }
    else { const hasError = /error|failed|invalid|problem/i.test(resultText); bookingStatus = hasError ? 'error' : 'confirmed'; bookingMessage = hasError ? 'Error: ' + resultText.substring(0, 200) : 'Submitted (no error).'; }
    addLog('Status: ' + bookingStatus + ' - ' + bookingMessage);
    return { success: bookingStatus === 'confirmed', bookingStatus, bookingMessage, log };
  } catch (err) { return { success: false, bookingStatus: 'error', bookingMessage: err.message, log }; }
  finally { if (browser) await browser.close(); }
}

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'brooklake-agent' }));

app.post('/debug', async (req, res) => {
  const { username, password, bookingDate, outingTime } = req.body;
  if (!username || !password || !bookingDate || !outingTime) return res.status(400).json({ error: 'Need username, password, bookingDate, outingTime' });
  const log = []; const addLog = (msg) => { console.log(msg); log.push(msg); };
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    addLog('Loading login page...');
    await page.goto('https://www.brooklakecc.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const encKey = await page.evaluate(() => { const scripts = Array.from(document.querySelectorAll('script')); for (const s of scripts) { const m = s.textContent.match(/var\s+k\s*=\s*['"]([^'"]+)['"]/); if (m) return m[1]; } const inp = document.querySelector('input[name="k"], input[id="k"]'); return inp ? inp.value : null; });
    let rc4Key = encKey;
    if (!rc4Key) { const keyResp = await page.evaluate(async () => { const r = await fetch('/default.aspx?p=login&ajax=true&action=getkey', { method: 'GET', credentials: 'include' }); return r.text(); }); try { const p = JSON.parse(keyResp); rc4Key = p.key || p.Key || keyResp.trim(); } catch { rc4Key = keyResp.trim(); } }
    addLog('RC4 key length: ' + (rc4Key ? rc4Key.length : 'NOT FOUND'));
    const encUser = rc4(rc4Key, username); const encPass = rc4(rc4Key, password);
    const loginResp = await page.evaluate(async ({ encUser, encPass }) => { const r = await fetch('/default.aspx?p=login&ajax=true', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=' + encodeURIComponent(encUser) + '&password=' + encodeURIComponent(encPass) }); return r.text(); }, { encUser, encPass });
    addLog('Login snippet: ' + loginResp.substring(0, 80));
    await page.goto('https://www.brooklakecc.com/default.aspx', { waitUntil: 'domcontentloaded', timeout: 15000 });
    addLog('Post-login URL: ' + page.url());
    function to24Hour(timeStr) { const m = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i); if (!m) return timeStr; let h = parseInt(m[1], 10); const min = m[2], period = m[3].toUpperCase(); if (period === 'AM' && h === 12) h = 0; if (period === 'PM' && h !== 12) h += 12; return String(h).padStart(2, '0') + ':' + min; }
    const time24 = to24Hour(outingTime);
    addLog('Time: ' + outingTime + ' -> ' + time24);
    const dialogUrl = 'https://www.brooklakecc.com/dialog.aspx?p=NetcaddyPop&tt=MakeTeeTime&NoModResize=1&NoNav=1&ShowFooter=False&courseid=1&date=' + encodeURIComponent(bookingDate) + '&time=' + encodeURIComponent(time24) + '&hole=1&numholes=0&xsome=4&startletter=';
    addLog('Dialog URL: ' + dialogUrl);
    await page.goto(dialogUrl, { waitUntil: 'networkidle', timeout: 30000 });
    addLog('Dialog URL after nav: ' + page.url());
    const pageTitle = await page.title();
    const pageText = await page.evaluate(() => document.body.innerText);
    const pageHtml = await page.evaluate(() => document.body.innerHTML);
    const formElements = await page.evaluate(() => { const els = Array.from(document.querySelectorAll('input, select, button, a[href]')); return els.slice(0, 50).map(el => ({ tag: el.tagName, id: el.id, name: el.name || '', type: el.type || '', value: el.value || '', text: el.innerText ? el.innerText.substring(0, 50) : '', href: el.href || '' })); });
    addLog('Title: ' + pageTitle);
    addLog('Text (500): ' + pageText.substring(0, 500));
    addLog('Form elements: ' + formElements.length);
    res.json({ log, pageTitle, pageText: pageText.substring(0, 2000), pageHtml: pageHtml.substring(0, 3000), formElements, dialogUrl });
  } catch (err) { res.json({ error: err.message, log }); }
  finally { if (browser) await browser.close(); }
});

app.post('/book', async (req, res) => {
  const { username, password, bookingDate, outingTime, bookerFirstName, bookerLastName, bookerEmail, guestNames } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });
  if (!bookingDate || !outingTime) return res.status(400).json({ error: 'Missing bookingDate or outingTime' });
  console.log('[' + new Date().toISOString() + '] Booking: ' + bookingDate + ' ' + outingTime + ' for ' + bookerFirstName + ' ' + bookerLastName);
  const result = await bookTeeTime({ username, password, bookingDate, outingTime, bookerFirstName, bookerLastName, bookerEmail, guestNames: guestNames || [] });
  const statusCode = result.bookingStatus === 'confirmed' ? 200 : result.bookingStatus === 'unavailable' ? 200 : 500;
  res.status(statusCode).json(result);
});

app.listen(PORT, () => console.log('Brooklake booking agent running on port ' + PORT));
