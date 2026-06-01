const { test } = require('@playwright/test');

test('medio console', async ({ page }) => {
  page.on('console', msg => console.log('CONSOLE', msg.type(), msg.text()));
  page.on('pageerror', err => console.log('PAGEERROR', err.message));
  page.on('requestfailed', req => console.log('REQFAIL', req.url(), req.failure()?.errorText));
  const resp = await page.goto('http://127.0.0.1:4174/compromiso-ambiental-y-social/medio-ambiente', { waitUntil: 'networkidle' });
  console.log('STATUS', resp && resp.status());
  await page.waitForTimeout(2000);
  const text = await page.evaluate(() => document.body.innerText.slice(0, 500));
  console.log('TEXT', text.replace(/\s+/g, ' ').trim());
});
