const express = require('express');
const { chromium } = require('playwright');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

async function askGemini(apiKey, imageBase64, prompt) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  const result = await model.generateContent([
    prompt,
    { inlineData: { mimeType: 'image/png', data: imageBase64 } }
  ]);
  return result.response.text().trim();
}

async function screenshot(page) {
  const buf = await page.screenshot({ fullPage: false });
  return buf.toString('base64');
}

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
  const { username, password, geminiApiKey, bookingDate, outingTime, bookerFirstName, bookerLastName, bookerEmail, guestNames = [] } = params;
  const log = [];
  const addLog = (msg) => { console.log(msg); log.push(msg); };
  let browser;
  try {
    addLog('Launching browser...');
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    addLog('Loading Brooklake login page...');
    await page.goto('https://www.brooklakecc.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const encKey = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script'));
      for (const s of scripts) {
        const m = s.textContent.match(/var\s+k\s*=\s*['"]([^'"]+)['"]/);
        if (m) return m[1];
      }
      const inp = document.querySelector('input[name="k"], input[id="k"]');
      return inp ? inp.value : null;
    });
    let rc4Key = encKey;
    if (!rc4Key) {
      addLog('Key not in page JS, trying AJAX endpoint...');
      const keyResp = await page.evaluate(async () => {
        const r = await fetch('/default.aspx?p=login&ajax=true&action=getkey', { method: 'GET', credentials: 'include' });
        return r.text();
      });
      try { const parsed = JSON.parse(keyResp); rc4Key = parsed.key || parsed.Key || keyResp.trim(); } catch { rc4Key = keyResp.trim(); }
    }
    if (!rc4Key) throw new Error('Could not retrieve RC4 encryption key from login page');
    addLog('Got RC4 key (length ' + rc4Key.length + ')');
    const encUser = rc4(rc4Key, username);
    const encPass = rc4(rc4Key, password);
    addLog('Submitting credentials...');
    const loginResp = await page.evaluate(async ({ encUser, encPass }) => {
      const r = await fetch('/default.aspx?p=login&ajax=true', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=' + encodeURIComponent(encUser) + '&password=' + encodeURIComponent(encPass) });
      return r.text();
    }, { encUser, encPass });
    addLog('Login response: ' + loginResp.substring(0, 100));
    let loginOk = false;
    try { const parsed = JSON.parse(loginResp); loginOk = parsed.success === true || parsed.Success === true || parsed.result === 'success' || loginResp.includes('success'); } catch { loginOk = loginResp.toLowerCase().includes('success') || loginResp.includes('1'); }
    if (!loginOk) { await page.goto('https://www.brooklakecc.com/default.aspx', { waitUntil: 'domcontentloaded', timeout: 15000 }); loginOk = !page.url().includes('login'); }
    if (!loginOk) throw new Error('Login failed: ' + loginResp.substring(0, 200));
    addLog('Login successful');
    const dialogUrl = 'https://www.brooklakecc.com/dialog.aspx?p=NetcaddyPop&tt=MakeTeeTime&NoModResize=1&NoNav=1&ShowFooter=False&courseid=1&date=' + encodeURIComponent(bookingDate) + '&time=' + encodeURIComponent(outingTime) + '&hole=1&numholes=0&xsome=4&startletter=';
    addLog('Navigating to booking dialog: ' + bookingDate + ' ' + outingTime);
    await page.goto(dialogUrl, { waitUntil: 'networkidle', timeout: 30000 });
    let img = await screenshot(page);
    let vision = await askGemini(geminiApiKey, img, 'This is a tee time booking dialog. Is the form fully loaded and ready to fill in? Look for player name fields and a Book/Submit button. Reply with exactly one of: READY, ERROR, or LOADING. Then a colon and a brief reason.');
    addLog('Gemini dialog check: ' + vision);
    if (vision.startsWith('LOADING')) { addLog('Page still loading, waiting 3s...'); await page.waitForTimeout(3000); img = await screenshot(page); vision = await askGemini(geminiApiKey, img, 'Is this tee time booking form ready to fill in? Reply: READY, ERROR, or LOADING, then colon and reason.'); addLog('Gemini recheck: ' + vision); }
    if (vision.startsWith('ERROR')) throw new Error('Dialog page error detected by Gemini: ' + vision);
    addLog('Filling booking form...');
    const validGuests = (guestNames || []).filter(n => n && n.trim());
    const partySize = validGuests.length === 0 ? 'Single' : validGuests.length === 1 ? 'Twosome' : validGuests.length === 2 ? 'Threesome' : 'Foursome';
    try { await page.selectOption('select[id*="drpPartySize"], select[name*="drpPartySize"]', { label: partySize }, { timeout: 5000 }); addLog('Set party size to ' + partySize); } catch { addLog('Standard select failed, trying Telerik combo...'); await page.evaluate((size) => { const inputs = Array.from(document.querySelectorAll('input[id*="drpPartySize"]')); for (const inp of inputs) { if (inp.type !== 'hidden') { inp.value = size; return; } } }, partySize); }
    await page.waitForTimeout(1000);
    for (let i = 0; i < Math.min(validGuests.length, 3); i++) {
      const playerNum = i + 2;
      const guestName = validGuests[i];
      addLog('Setting player ' + playerNum + ' to: ' + guestName);
      const playerInput = await page.$('input[id*="P' + playerNum + '_PCombo_PlayerName"]:not([type="hidden"])');
      if (playerInput) { await playerInput.click({ clickCount: 3 }); await playerInput.type(guestName, { delay: 50 }); await page.waitForTimeout(800); const dropdown = await page.$('[id*="P' + playerNum + '"][class*="rcbList"], .rcbList'); if (dropdown) { const guestOption = await page.$('li:has-text("Guest"), li:has-text("guest")'); if (guestOption) { await guestOption.click(); } else { await page.keyboard.press('Escape'); } } }
    }
    img = await screenshot(page);
    vision = await askGemini(geminiApiKey, img, 'This is a tee time booking form. The booking is for ' + bookingDate + ' at ' + outingTime + '. Look at the form and tell me: is it filled in correctly? Is there a visible Book or Submit button? Any warnings or error messages? Reply with LOOKS_GOOD or ISSUE, then a colon and description.');
    addLog('Gemini pre-submit check: ' + vision);
    if (vision.startsWith('ISSUE')) addLog('Gemini flagged an issue but proceeding with submission...');
    addLog('Clicking Book button...');
    const bookBtn = await page.$('a[id*="lbBook"], input[id*="lbBook"], button[id*="lbBook"], a:has-text("Make Tee Time"), a:has-text("Book"), button:has-text("Book")');
    if (!bookBtn) throw new Error('Could not find the Book button on the page');
    await bookBtn.click();
    addLog('Waiting for booking response...');
    await page.waitForTimeout(4000);
    img = await screenshot(page);
    vision = await askGemini(geminiApiKey, img, 'A tee time booking was just submitted. Look at this screenshot carefully. Did the booking succeed? Look for confirmation text, booking numbers, success messages, or alternatively error messages, not available notices, or redirect to an error page. Reply with CONFIRMED, UNAVAILABLE, or ERROR, then a colon and quote the key text you see.');
    addLog('Gemini result check: ' + vision);
    let bookingStatus, bookingMessage;
    if (vision.startsWith('CONFIRMED')) { bookingStatus = 'confirmed'; bookingMessage = vision.substring(vision.indexOf(':') + 1).trim(); }
    else if (vision.startsWith('UNAVAILABLE')) { bookingStatus = 'unavailable'; bookingMessage = vision.substring(vision.indexOf(':') + 1).trim(); }
    else { bookingStatus = 'error'; bookingMessage = vision.substring(vision.indexOf(':') + 1).trim(); }
    addLog('Final status: ' + bookingStatus + ' — ' + bookingMessage);
    return { success: bookingStatus === 'confirmed', bookingStatus, bookingMessage, log };
  } catch (err) {
    console.error('Booking error:', err);
    return { success: false, bookingStatus: 'error', bookingMessage: err.message, log };
  } finally {
    if (browser) await browser.close();
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'brooklake-agent' });
});

app.post('/book', async (req, res) => {
  const { username, password, geminiApiKey, bookingDate, outingTime, bookerFirstName, bookerLastName, bookerEmail, guestNames, guestCompanies, businessJustification, comments } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });
  if (!geminiApiKey) return res.status(400).json({ error: 'Missing geminiApiKey' });
  if (!bookingDate || !outingTime) return res.status(400).json({ error: 'Missing bookingDate or outingTime' });
  console.log('[' + new Date().toISOString() + '] Booking request: ' + bookingDate + ' ' + outingTime + ' for ' + bookerFirstName + ' ' + bookerLastName);
  const result = await bookTeeTime({ username, password, geminiApiKey, bookingDate, outingTime, bookerFirstName, bookerLastName, bookerEmail, guestNames: guestNames || [] });
  const statusCode = result.bookingStatus === 'confirmed' ? 200 : result.bookingStatus === 'unavailable' ? 200 : 500;
  res.status(statusCode).json(result);
});

app.listen(PORT, () => {
  console.log('Brooklake booking agent running on port ' + PORT);
});
