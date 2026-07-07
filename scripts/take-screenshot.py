"""Take a screenshot of the running dev server using Playwright."""
import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        # Login screen (dark mode)
        ctx = await browser.new_context(
            viewport={"width": 1440, "height": 900},
            color_scheme="dark",
        )
        page = await ctx.new_page()
        await page.goto("http://localhost:3000/", wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(1500)
        await page.screenshot(path="/home/z/my-project/scripts/new-ui-login.png", full_page=False)
        print("✓ Login screenshot saved")

        # Try to login to see the empty state
        # Click "Continue with Email" if available, or use Sign in
        try:
            # Fill email
            email_input = page.locator('input[type="email"]')
            if await email_input.count() > 0:
                await email_input.fill("test-ui-check@example.com")
                # Try Continue with Email button
                continue_btn = page.locator('button:has-text("Continue with Email")')
                if await continue_btn.count() > 0:
                    await continue_btn.click()
                    await page.wait_for_timeout(3000)
                    await page.screenshot(path="/home/z/my-project/scripts/new-ui-empty.png", full_page=False)
                    print("✓ Empty state screenshot saved")
        except Exception as e:
            print(f"Login attempt: {e}")

        await browser.close()

asyncio.run(main())
