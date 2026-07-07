"""Take screenshots of the running dev server using Playwright."""
import asyncio
import os
import subprocess
import time
import sys
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        # Launch chromium directly (not connect to existing)
        browser = await p.chromium.launch(args=['--no-sandbox'])
        ctx = await browser.new_context(
            viewport={"width": 1440, "height": 900},
            color_scheme="dark",
        )
        page = await ctx.new_page()
        try:
            await page.goto("http://localhost:3000/", wait_until="networkidle", timeout=30000)
        except Exception as e:
            print(f"Failed to navigate: {e}")
            await browser.close()
            return False

        await page.wait_for_timeout(2000)
        await page.screenshot(path="/home/z/my-project/scripts/new-ui-login.png", full_page=False)
        print("✓ Login screenshot saved")

        # Try to login
        try:
            email_input = page.locator('input[type="email"]')
            if await email_input.count() > 0:
                await email_input.fill("uitest@example.com")
                continue_btn = page.locator('button:has-text("Continue with Email")')
                if await continue_btn.count() > 0:
                    await continue_btn.click()
                    await page.wait_for_timeout(3000)
                    await page.screenshot(path="/home/z/my-project/scripts/new-ui-empty.png", full_page=False)
                    print("✓ Empty state screenshot saved")
                else:
                    print("No 'Continue with Email' button found")
                    # Take screenshot anyway
                    await page.screenshot(path="/home/z/my-project/scripts/new-ui-empty.png", full_page=False)
        except Exception as e:
            print(f"Login attempt error: {e}")

        await browser.close()
        return True

ok = asyncio.run(main())
sys.exit(0 if ok else 1)
