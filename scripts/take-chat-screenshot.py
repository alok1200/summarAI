"""Take screenshot of chat with YouTube URL typed in input."""
import asyncio
import sys
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=['--no-sandbox'])
        ctx = await browser.new_context(
            viewport={"width": 1440, "height": 900},
            color_scheme="dark",
        )
        # Inject auth cookie by logging in
        page = await ctx.new_page()
        try:
            await page.goto("http://localhost:3000/", wait_until="networkidle", timeout=30000)
        except Exception as e:
            print(f"Failed to navigate: {e}")
            await browser.close()
            return False

        await page.wait_for_timeout(1500)
        
        # Login with email direct
        try:
            email_input = page.locator('input[type="email"]')
            await email_input.fill("uitest@example.com")
            continue_btn = page.locator('button:has-text("Continue with Email")')
            await continue_btn.click()
            await page.wait_for_timeout(2500)
        except Exception as e:
            print(f"Login error: {e}")
        
        # Type a YouTube URL into the chat input
        try:
            textarea = page.locator('textarea').first
            await textarea.click()
            await textarea.fill("https://www.youtube.com/watch?v=s0jL3EKxt6I")
            await page.wait_for_timeout(1500)
            await page.screenshot(path="/home/z/my-project/scripts/new-ui-yt-chip.png", full_page=False)
            print("✓ YouTube chip screenshot saved")
        except Exception as e:
            print(f"Typing error: {e}")
        
        await browser.close()
        return True

asyncio.run(main())
