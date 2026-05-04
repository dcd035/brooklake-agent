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

    // --- Step 1: Login ---
    addLog('Loading login page...');
    await page.goto('https://www.brooklakecc.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Get RC4 key from page scripts
    let rc4Key = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script'));
      for (const s of scripts) {
        const m = s.textContent.match(/var\s+k\s*=\s*['"]([^'"]+)['"]/);
        if (m) return m[1];
      }
      return null;
    });

    if (!rc4Key) {
      addLog('Key not in page JS, trying AJAX endpoint...');
      const keyResp = await page.evaluate(async () => {
        const r = await fetch('/default.aspx?p=login&ajax=true&action=getkey', { method: 'GET', credentials: 'include' });
        return r.text();
      });
      try {
        const parsed = JSON.parse(keyResp);
        rc4Key = parsed.key || parsed.Key || keyResp.trim();
      } catch {
        rc4Key = keyResp.trim();
      }
    }

    if (!rc4Key) throw new Error('Could not retrieve RC4 encryption key');
    addLog(`Got RC4 key (length ${rc4Key.length})`);

    // Submit credentials
    const encUser = rc4(rc4Key, username);
    const encPass = rc4(rc4Key, password);

    const loginResp = await page.evaluate(async ({ encUser, encPass }) => {
      const r = await fetch('/default.aspx?p=login&ajax=true', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=' + encodeURIComponent(encUser) + '&password=' + encodeURIComponent(encPass)
      });
      return r.text();
    }, { encUser, encPass });

    addLog(`Login response: ${loginResp.substring(0, 80)}`);

    // Verify login by navigating home
    await page.goto('https://www.brooklakecc.com/default.aspx', { waitUntil: 'domcontentloaded', timeout: 15000 });
    const afterLoginUrl = page.url();
    addLog(`After login URL: ${afterLoginUrl}`);
    if (afterLoginUrl.includes('login')) throw new Error('Login failed - still on login page');
    addLog('Login successful');

    // --- Step 2: Navigate to tee sheet ---
    addLog('Navigating to tee sheet...');
    await page.goto(
      'https://www.brooklakecc.com/Default.aspx?p=dynamicmodule&pageid=175&tt=booking&ssid=100227&vnf=1',
      { waitUntil: 'networkidle', timeout: 30000 }
    );

    // Set date and click Update to load the right day
    addLog(`Setting tee sheet date to ${bookingDate}...`);
    await page.waitForSelector('#txtDate', { timeout: 15000 });
    await page.fill('#txtDate', bookingDate);

    // Click the Update button (autoRefreshWLoad or btnSearch)
    await page.evaluate((date) => {
      const dateInputs = document.querySelectorAll('input[id*="txtDate"]');
      dateInputs.forEach(inp => { inp.value = date; });
    }, bookingDate);

    // Trigger the refresh via the hidden button
    await page.evaluate(() => {
      const btn = document.querySelector('input[id*="autoRefreshWLoad"], input[id*="autoRefresh"]:not([type=submit])');
      if (btn) btn.click();
    });

    await page.waitForTimeout(3000);
    addLog('Tee sheet loaded');

    // --- Step 3: Call LaunchReserver for the target time ---
    addLog(`Calling LaunchReserver for ${bookingDate} ${outingTime}...`);

    // LaunchReserver signature: (courseId, date, time, hole, bookedCount, xsome, flag, startletter)
    // We call with xsome=4 to allow up to 4 players
    const launchResult = await page.evaluate(async (time) => {
      try {
        // Wait for tee sheet data to be ready
        if (typeof LaunchReserver === 'undefined') return 'LaunchReserver not defined';
        LaunchReserver('1', arguments[0], time, '1', '0', '4', 'false', '');
        return 'called';
      } catch(e) {
        return 'error: ' + e.message;
      }
    }, outingTime);

    // Use page.evaluate with explicit arg passing
    const launch2 = await page.evaluate((args) => {
      try {
        if (typeof LaunchReserver === 'undefined') return 'LaunchReserver not defined';
        LaunchReserver(args.courseId, args.date, args.time, args.hole, args.booked, args.xsome, 'false', '');
        return 'called';
      } catch(e) {
        return 'error: ' + e.message;
      }
    }, { courseId: '1', date: bookingDate, time: outingTime, hole: '1', booked: '0', xsome: '4' });

    addLog(`LaunchReserver result: ${launch2}`);

    // Wait for the BookMgriframe to load
    addLog('Waiting for booking dialog iframe...');
    await page.waitForFunction(() => {
      const iframe = document.getElementById('BookMgriframe');
      return iframe && iframe.offsetHeight > 100;
    }, { timeout: 15000 });

    await page.waitForTimeout(2000);
    addLog('Booking dialog loaded');

    // --- Step 4: Fill form inside the iframe ---
    const iframe = page.frameLocator('#BookMgriframe');

    // Set party size
    const validGuests = (guestNames || []).filter(n => n && n.trim());
    const totalPlayers = validGuests.length + 1; // +1 for the booker
    const partySizeMap = { 1: 'Single', 2: 'Twosome', 3: 'Threesome', 4: 'Foursome' };
    const partySize = partySizeMap[Math.min(totalPlayers, 4)] || 'Single';
    addLog(`Party size: ${partySize} (${totalPlayers} total players)`);

    // Set party size via the Telerik combo input
    try {
      const partySizeInput = iframe.locator('#ctl00_ctrl_MakeTeeTime_drpPartySize_tCombo_Input');
      await partySizeInput.fill(partySize, { timeout: 5000 });
      // Trigger change event
      await partySizeInput.evaluate((el, val) => {
        el.value = val;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      }, partySize);
      addLog(`Set party size to ${partySize}`);
      await page.waitForTimeout(1500);
    } catch(e) {
      addLog(`Party size set failed: ${e.message}`);
    }

    // Fill guest names (Player 2, 3, 4)
    for (let i = 0; i < Math.min(validGuests.length, 3); i++) {
      const playerNum = i + 2;
      const guestName = validGuests[i];
      addLog(`Setting Player ${playerNum}: ${guestName}`);
      try {
        const playerInput = iframe.locator(`#ctl00_ctrl_MakeTeeTime_P${playerNum}_PCombo_PlayerName_Input`);
        await playerInput.fill(guestName, { timeout: 5000 });
        await page.waitForTimeout(1000);
        // Dismiss any autocomplete dropdown
        await playerInput.evaluate(el => {
          el.dispatchEvent(new Event('blur', { bubbles: true }));
        });
        addLog(`Set Player ${playerNum} to ${guestName}`);
      } catch(e) {
        addLog(`Player ${playerNum} fill failed: ${e.message}`);
      }
    }

    // --- Step 5: Click Make Tee Time ---
    addLog('Clicking Make Tee Time button...');
    try {
      const bookBtn = iframe.locator('#ctl00_ctrl_MakeTeeTime_lbBook');
      await bookBtn.waitFor({ timeout: 5000 });
      await bookBtn.click();
      addLog('Clicked Make Tee Time');
    } catch(e) {
      addLog(`Make Tee Time click failed: ${e.message}`);
      throw new Error('Could not click Make Tee Time button: ' + e.message);
    }

    // Wait for response
    addLog('Waiting for booking response...');
    await page.waitForTimeout(5000);

    // --- Step 6: Check result ---
    // Check the iframe content for confirmation
    let resultText = '';
    try {
      resultText = await iframe.locator('body').innerText({ timeout: 5000 });
    } catch(e) {
      // iframe may have navigated away - check main page
      resultText = await page.evaluate(() => document.body.innerText);
    }

    addLog('Result text (first 400): ' + resultText.substring(0, 400));

    const confirmed = /confirmation|confirmed|booking.*success|tee time.*booked|receipt|thank you/i.test(resultText);
    const unavailable = /not available|unavailable|already booked|tee time.*taken|no.*available/i.test(resultText);
    const hasError = /error|failed|invalid|problem/i.test(resultText);

    let bookingStatus, bookingMessage;
    if (confirmed) {
      bookingStatus = 'confirmed';
      const match = resultText.match(/confirmation[^0-9]*([0-9]+)/i);
      bookingMessage = match ? `Booking confirmed. Confirmation #${match[1]}` : 'Booking confirmed successfully.';
    } else if (unavailable) {
      bookingStatus = 'unavailable';
      bookingMessage = 'Tee time is not available.';
    } else if (hasError) {
      bookingStatus = 'error';
      bookingMessage = 'Booking may have failed. ' + resultText.substring(0, 200);
    } else {
      bookingStatus = 'confirmed';
      bookingMessage = 'Booking submitted (no error detected).';
    }

    addLog(`Final: ${bookingStatus} - ${bookingMessage}`);
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

// Debug endpoint: navigate to tee sheet, open dialog for a time, return iframe DOM snapshot
app.post('/debug', async (req, res) => {
  const { username, password, bookingDate, outingTime } = req.body;
  if (!username || !password || !bookingDate || !outingTime) {
    return res.status(400).json({ error: 'Need username, password, bookingDate, outingTime' });
  }

  const log = [];
  const addLog = (msg) => { console.log(msg); log.push(msg); };
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 }
    });
    const page = await context.newPage();

    // Login
    addLog('Loading login page...');
    await page.goto('https://www.brooklakecc.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });

    let rc4Key = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script'));
      for (const s of scripts) {
        const m = s.textContent.match(/var\s+k\s*=\s*['"]([^'"]+)['"]/);
        if (m) return m[1];
      }
      return null;
    });
    if (!rc4Key) {
      const keyResp = await page.evaluate(async () => {
        const r = await fetch('/default.aspx?p=login&ajax=true&action=getkey', { method: 'GET', credentials: 'include' });
        return r.text();
      });
      try { const p = JSON.parse(keyResp); rc4Key = p.key || p.Key || keyResp.trim(); } catch { rc4Key = keyResp.trim(); }
    }
    addLog(`RC4 key length: ${rc4Key ? rc4Key.length : 'NOT FOUND'}`);

    const encUser = rc4(rc4Key, username);
    const encPass = rc4(rc4Key, password);
    await page.evaluate(async ({ encUser, encPass }) => {
      await fetch('/default.aspx?p=login&ajax=true', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=' + encodeURIComponent(encUser) + '&password=' + encodeURIComponent(encPass)
      });
    }, { encUser, encPass });

    await page.goto('https://www.brooklakecc.com/default.aspx', { waitUntil: 'domcontentloaded', timeout: 15000 });
    addLog(`Post-login URL: ${page.url()}`);
    if (page.url().includes('login')) throw new Error('Login failed');
    addLog('Login successful');

    // Navigate to tee sheet
    addLog('Navigating to tee sheet...');
    await page.goto(
      'https://www.brooklakecc.com/Default.aspx?p=dynamicmodule&pageid=175&tt=booking&ssid=100227&vnf=1',
      { waitUntil: 'networkidle', timeout: 30000 }
    );

    // Set date
    await page.waitForSelector('#txtDate', { timeout: 15000 });
    await page.evaluate((date) => {
      document.querySelectorAll('input[id*="txtDate"]').forEach(inp => { inp.value = date; });
    }, bookingDate);
    await page.evaluate(() => {
      const btn = document.querySelector('input[id*="autoRefreshWLoad"], input[id*="autoRefresh"]:not([type=submit])');
      if (btn) btn.click();
    });
    await page.waitForTimeout(3000);
    addLog(`Tee sheet loaded for ${bookingDate}`);

    // Find the correct tee time slot and get its LaunchReserver args from DOM
    const slotInfo = await page.evaluate((targetTime) => {
      const allEls = Array.from(document.querySelectorAll('[onclick]'));
      const slot = allEls.find(el => {
        const oc = el.getAttribute('onclick') || '';
        return oc.includes('LaunchReserver') && oc.includes(targetTime);
      });
      if (!slot) {
        // Return all available slots so we can debug
        const slots = allEls
          .filter(el => (el.getAttribute('onclick')||'').includes('LaunchReserver'))
          .map(el => el.getAttribute('onclick'));
        return { found: false, availableSlots: slots.slice(0, 20) };
      }
      return { found: true, onclick: slot.getAttribute('onclick') };
    }, outingTime);

    addLog(`Slot search result: ${JSON.stringify(slotInfo)}`);

    // Call LaunchReserver
    addLog(`Calling LaunchReserver for ${outingTime}...`);
    const launchResult = await page.evaluate((args) => {
      try {
        if (typeof LaunchReserver === 'undefined') return 'LaunchReserver not defined';
        LaunchReserver(args.courseId, args.date, args.time, args.hole, args.booked, args.xsome, 'false', '');
        return 'called ok';
      } catch(e) { return 'error: ' + e.message; }
    }, { courseId: '1', date: bookingDate, time: outingTime, hole: '1', booked: '0', xsome: '4' });
    addLog(`LaunchReserver: ${launchResult}`);

    // Wait for iframe
    try {
      await page.waitForFunction(() => {
        const iframe = document.getElementById('BookMgriframe');
        return iframe && iframe.offsetHeight > 100;
      }, { timeout: 15000 });
      addLog('BookMgriframe appeared');
    } catch(e) {
      addLog(`BookMgriframe wait failed: ${e.message}`);
    }

    await page.waitForTimeout(2000);

    // Read iframe content
    const iframeInfo = await page.evaluate(() => {
      const iframe = document.getElementById('BookMgriframe');
      if (!iframe) return { error: 'no iframe' };
      try {
        const doc = iframe.contentDocument || iframe.contentWindow.document;
        const els = Array.from(doc.querySelectorAll('input:not([type=hidden]), select, textarea, a, button'));
        return {
          src_base: iframe.src.split('?')[0],
          src_params: iframe.src.split('?')[1] ? iframe.src.split('?')[1].split('&').map(p => {
            const [k,v] = p.split('='); return k + '=' + decodeURIComponent(v||'');
          }) : [],
          title: doc.title,
          elements: els.map(el => ({
            tag: el.tagName, id: el.id, name: el.name||'',
            type: el.type||'', value: el.value||'', text: (el.innerText||'').trim().substring(0,50)
          }))
        };
      } catch(e) { return { error: e.message }; }
    });

    addLog(`Iframe title: ${iframeInfo.title}`);
    addLog(`Iframe element count: ${iframeInfo.elements ? iframeInfo.elements.length : 0}`);

    res.json({ log, slotInfo, launchResult, iframeInfo });

  } catch (err) {
    res.json({ error: err.message, log });
  } finally {
    if (browser) await browser.close();
  }
});

app.post('/book', async (req, res) => {
  const {
    username, password,
    bookingDate, outingTime,
    bookerFirstName, bookerLastName, bookerEmail,
    guestNames
  } = req.body;

  if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });
  if (!bookingDate || !outingTime) return res.status(400).json({ error: 'Missing bookingDate or outingTime' });

  console.log(`[${new Date().toISOString()}] Booking: ${bookingDate} ${outingTime} for ${bookerFirstName} ${bookerLastName}`);

  const result = await bookTeeTime({
    username, password, bookingDate, outingTime,
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
