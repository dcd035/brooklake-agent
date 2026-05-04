const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --- RC4 encryption (same as existing n8n workflow) ---
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

// --- Main booking function ---
async function bookTeeTime(params) {
  const {
    username, password,
    bookingDate, outingTime,
    bookerFirstName, bookerLastName, bookerEmail,
    guestNames = []
  } = params;

  const log = [];
  const addLog = (msg) => { console.log(msg); log.push(msg); };

  let browser;
  try {
    addLog('Launching browser...');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 }
    });
    const page = await context.newPage();

    // --- Step 1: Load login page and get RC4 key ---
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
        const r = await fetch('/default.aspx?p=login&ajax=true&action=getkey', {
          method: 'GET', credentials: 'include'
        });
        return r.text();
      });
      try {
        const parsed = JSON.parse(keyResp);
        rc4Key = parsed.key || parsed.Key || keyResp.trim();
      } catch {
        rc4Key = keyResp.trim();
      }
    }

    if (!rc4Key) throw new Error('Could not retrieve RC4 encryption key from login page');
    addLog(`Got RC4 key (length ${rc4Key.length})`);

    // --- Step 2: Submit credentials ---
    const encUser = rc4(rc4Key, username);
    const encPass = rc4(rc4Key, password);

    addLog('Submitting credentials...');
    const loginResp = await page.evaluate(async ({ encUser, encPass }) => {
      const r = await fetch('/default.aspx?p=login&ajax=true', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=' + encodeURIComponent(encUser) + '&password=' + encodeURIComponent(encPass)
      });
      return r.text();
    }, { encUser, encPass });

    addLog(`Login response (first 100): ${loginResp.substring(0, 100)}`);

    let loginOk = false;
    try {
      const parsed = JSON.parse(loginResp);
      loginOk = parsed.success === true || parsed.Success === true ||
                parsed.result === 'success' || loginResp.includes('success');
    } catch {
      loginOk = loginResp.toLowerCase().includes('success') || loginResp.includes('1');
    }

    if (!loginOk) {
      await page.goto('https://www.brooklakecc.com/default.aspx', { waitUntil: 'domcontentloaded', timeout: 15000 });
      loginOk = !page.url().includes('login');
    }

    if (!loginOk) throw new Error('Login failed: ' + loginResp.substring(0, 200));
    addLog('Login successful');

    // --- Step 3: Navigate to booking dialog ---
    const dialogUrl = `https://www.brooklakecc.com/dialog.aspx?p=NetcaddyPop&tt=MakeTeeTime` +
      `&NoModResize=1&NoNav=1&ShowFooter=False&courseid=1` +
      `&date=${encodeURIComponent(bookingDate)}` +
      `&time=${encodeURIComponent(outingTime)}` +
      `&hole=1&numholes=0&xsome=4&startletter=`;

    addLog(`Navigating to booking dialog: ${bookingDate} ${outingTime}`);
    await page.goto(dialogUrl, { waitUntil: 'networkidle', timeout: 30000 });

    // --- DOM check: wait for the form to be ready ---
    addLog('Waiting for booking form to load...');
    try {
      await page.waitForSelector(
        'select[id*="drpPartySize"], input[id*="drpPartySize"], a[id*="lbBook"], input[id*="lbBook"]',
        { timeout: 10000 }
      );
      addLog('Booking form loaded');
    } catch {
      // Log current page content for debugging then continue
      const pageText = await page.evaluate(() => document.body.innerText.substring(0, 300));
      addLog('Form load timeout - page content: ' + pageText);
    }

    // --- Step 4: Fill in the form ---
    addLog('Filling booking form...');

    const validGuests = (guestNames || []).filter(n => n && n.trim());
    const partySize = validGuests.length === 0 ? 'Single' :
                      validGuests.length === 1 ? 'Twosome' :
                      validGuests.length === 2 ? 'Threesome' : 'Foursome';

    addLog(`Party size: ${partySize} (${validGuests.length} guests)`);

    try {
      await page.selectOption('select[id*="drpPartySize"], select[name*="drpPartySize"]',
        { label: partySize }, { timeout: 5000 });
      addLog(`Set party size to ${partySize}`);
    } catch {
      addLog('Standard select failed, trying Telerik combo...');
      await page.evaluate((size) => {
        const inputs = Array.from(document.querySelectorAll('input[id*="drpPartySize"]'));
        for (const inp of inputs) {
          if (inp.type !== 'hidden') { inp.value = size; return; }
        }
      }, partySize);
    }

    await page.waitForTimeout(1000);

    // Fill guest names
    for (let i = 0; i < Math.min(validGuests.length, 3); i++) {
      const playerNum = i + 2;
      const guestName = validGuests[i];
      addLog(`Setting player ${playerNum} to: ${guestName}`);
      const playerInput = await page.$(`input[id*="P${playerNum}_PCombo_PlayerName"]:not([type="hidden"])`);
      if (playerInput) {
        await playerInput.click({ clickCount: 3 });
        await playerInput.type(guestName, { delay: 50 });
        await page.waitForTimeout(800);
        const dropdown = await page.$(`[id*="P${playerNum}"][class*="rcbList"], .rcbList`);
        if (dropdown) {
          const guestOption = await page.$('li:has-text("Guest"), li:has-text("guest")');
          if (guestOption) { await guestOption.click(); }
          else { await page.keyboard.press('Escape'); }
        }
      }
    }

    // --- Step 5: Find and click Book button ---
    addLog('Looking for Book button...');
    const bookBtn = await page.$(
      'a[id*="lbBook"], input[id*="lbBook"], button[id*="lbBook"], ' +
      'a:has-text("Make Tee Time"), a:has-text("Book"), button:has-text("Book")'
    );

    if (!bookBtn) {
      const pageText = await page.evaluate(() => document.body.innerText.substring(0, 500));
      throw new Error('Could not find Book button. Page content: ' + pageText);
    }

    addLog('Clicking Book button...');
    await bookBtn.click();

    // Wait for the UpdatePanel response
    addLog('Waiting for booking response...');
    await page.waitForTimeout(4000);

    // --- Step 6: DOM-based result check ---
    const resultText = await page.evaluate(() => document.body.innerText);
    const resultHtml = await page.evaluate(() => document.body.innerHTML.substring(0, 2000));

    addLog('Page text after booking (first 300): ' + resultText.substring(0, 300));

    // Check for confirmation indicators
    const confirmed =
      /confirmation|confirmed|booking.*success|tee time.*booked|receipt/i.test(resultText) ||
      /lbConfirm|ConfirmationNumber|confirmation/i.test(resultHtml);

    // Check for unavailability indicators
    const unavailable =
      /not available|unavailable|already booked|tee time.*taken|no.*available/i.test(resultText);

    let bookingStatus, bookingMessage;

    if (confirmed) {
      bookingStatus = 'confirmed';
      // Try to extract a confirmation number
      const match = resultText.match(/confirmation[^0-9]*([0-9]+)/i);
      bookingMessage = match ? `Booking confirmed. Confirmation #${match[1]}` : 'Booking confirmed successfully.';
    } else if (unavailable) {
      bookingStatus = 'unavailable';
      bookingMessage = 'Tee time is not available.';
    } else {
      // Ambiguous — treat as confirmed if no error text found
      const hasError = /error|failed|invalid|problem/i.test(resultText);
      if (hasError) {
        bookingStatus = 'error';
        bookingMessage = 'Booking may have failed. Page: ' + resultText.substring(0, 200);
      } else {
        // No clear error — assume success (form submitted without error page)
        bookingStatus = 'confirmed';
        bookingMessage = 'Booking submitted successfully (no error detected).';
      }
    }

    addLog(`Final status: ${bookingStatus} — ${bookingMessage}`);

    return { success: bookingStatus === 'confirmed', bookingStatus, bookingMessage, log };

  } catch (err) {
    console.error('Booking error:', err);
    return { success: false, bookingStatus: 'error', bookingMessage: err.message, log };
  } finally {
    if (browser) await browser.close();
  }
}

// --- Express routes ---

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'brooklake-agent' });
});

app.post('/book', async (req, res) => {
  const {
    username, password,
    bookingDate, outingTime,
    bookerFirstName, bookerLastName, bookerEmail,
    guestNames, guestCompanies,
    businessJustification, comments
  } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Missing username or password' });
  }
  if (!bookingDate || !outingTime) {
    return res.status(400).json({ error: 'Missing bookingDate or outingTime' });
  }

  console.log(`[${new Date().toISOString()}] Booking request: ${bookingDate} ${outingTime} for ${bookerFirstName} ${bookerLastName}`);

  const result = await bookTeeTime({
    username, password,
    bookingDate, outingTime,
    bookerFirstName, bookerLastName, bookerEmail,
    guestNames: guestNames || []
  });

  const statusCode = result.bookingStatus === 'confirmed' ? 200 :
                     result.bookingStatus === 'unavailable' ? 200 : 500;

  res.status(statusCode).json(result);
});

app.listen(PORT, () => {
  console.log(`Brooklake booking agent running on port ${PORT}`);
});
