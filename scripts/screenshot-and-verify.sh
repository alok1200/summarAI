#!/bin/bash
set -e
cd /home/z/my-project

pkill -9 -f "next dev" 2>/dev/null || true
pkill -9 -f "next-server" 2>/dev/null || true
sleep 2

# Start dev server
nohup npx next dev -p 3000 --hostname 0.0.0.0 > /tmp/next-dev.log 2>&1 &
DEV_PID=$!
echo "Started dev server PID=$DEV_PID"

# Wait for ready
for i in {1..30}; do
  if curl -s -o /dev/null http://localhost:3000/ 2>/dev/null; then
    echo "Dev server ready after $i attempts"
    break
  fi
  sleep 1
done

# Quick HTTP check
curl -s -o /dev/null -w "Login HTTP: %{http_code}\n" http://localhost:3000/

# Take screenshots using puppeteer-core + the chrome that's already running
cat > /tmp/snap.js << 'JSEOF'
const puppeteer = require('puppeteer-core');
(async () => {
  // Find a chrome instance to connect to — try CDP on common ports
  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:40225',
    defaultViewport: { width: 1440, height: 900 },
  }).catch(() => null);

  if (!browser) {
    console.log('Could not connect to existing chrome, aborting');
    process.exit(1);
  }

  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));
  await page.screenshot({ path: '/home/z/my-project/scripts/new-ui-login.png' });
  console.log('✓ Login screenshot saved');

  // Try to login
  try {
    await page.type('input[type="email"]', 'uitest@example.com');
    await page.click('button:has-text("Continue with Email")');
    await new Promise(r => setTimeout(r, 3000));
    await page.screenshot({ path: '/home/z/my-project/scripts/new-ui-empty.png' });
    console.log('✓ Empty state screenshot saved');
  } catch (e) {
    console.log('Login failed:', e.message);
  }

  await page.close();
  await browser.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
JSEOF

NODE_PATH=/home/z/my-project/node_modules node /tmp/snap.js 2>&1 | tail -20

# Cleanup
kill -9 $DEV_PID 2>/dev/null || true
