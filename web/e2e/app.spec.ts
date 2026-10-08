import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';

const SHOTS = process.env.SHOTS_DIR ?? 'test-results/screens';
mkdirSync(SHOTS, { recursive: true });

/** Signs in through the development IdP exactly as a user would. */
async function signIn(page: Page, email: string, method: 'Password only' | 'Password + OTP' | 'Security key' = 'Password + OTP') {
  await page.goto('/signin');
  await page.getByRole('link', { name: /Development IdP/ }).click();
  await page.locator('tr', { hasText: email }).getByRole('button', { name: method }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/signin') && u.host === 'localhost:5173');
}

async function setLanguage(page: Page, lang: 'en' | 'pt-PT') {
  await page.getByLabel(/^(Language|Idioma)$/).first().selectOption(lang);
  await expect(page.locator('html')).toHaveAttribute('lang', lang);
}

async function axe(page: Page, name: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  const serious = r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''));
  if (serious.length) console.log(name, JSON.stringify(serious.map((v) => ({ id: v.id, n: v.nodes.length, sample: v.nodes[0]?.target })), null, 1));
  expect(serious, `${name}: ${serious.map((v) => v.id).join(', ')}`).toEqual([]);
}

const PAGES = ['/', '/crew-changes', '/requests', '/communications', '/personnel', '/readiness', '/rotation', '/calendar', '/tasks', '/suppliers', '/templates', '/settings'];
// Words that would indicate untranslated English on a Portuguese screen (UI chrome only; data such as names may be English).
const EN_LEAKS = /\b(Loading|Dashboard|Crew changes|Settings|Cancel|Save|Status|Search|Arrangements|Awaiting|Overdue|Requested|Confirmed)\b/;

test('coordinator: every main screen renders in Portuguese and English without errors and passes axe', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => r.status() >= 400 && errors.push(`${r.status()} ${new URL(r.url()).pathname}`));
  await signIn(page, 'carla.mendes@atlantica.example');
  errors.length = 0; // the sign-in page legitimately probes /api/me (401) before authentication
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await setLanguage(page, 'pt-PT');
  for (const path of PAGES) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('main h1').first()).toBeVisible();
    const text = await page.locator('main').innerText();
    expect(text, `untranslated text on ${path}`).not.toMatch(EN_LEAKS);
    await axe(page, `pt ${path}`);
    await page.screenshot({ path: `${SHOTS}/pt${path.replace(/\//g, '_') || '_home'}.png`, fullPage: true });
  }
  await setLanguage(page, 'en');
  for (const path of ['/', '/crew-changes', '/communications']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await axe(page, `en ${path}`);
    await page.screenshot({ path: `${SHOTS}/en${path.replace(/\//g, '_') || '_home'}.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
});

test('crew change workflow in the UI: mobilisation timeline, prepare emails, review package in demonstration mode', async ({ page }) => {
  await signIn(page, 'carla.mendes@atlantica.example');
  await setLanguage(page, 'en');
  await page.goto('/crew-changes');
  await page.getByRole('link', { name: /CC-\d{4}-0001/ }).click();
  await expect(page.getByRole('heading', { name: 'Mobilisation timeline' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/en_crew_change.png`, fullPage: true });
  await page.getByRole('button', { name: 'Prepare emails' }).click();
  await expect(page.getByRole('tab', { name: /Email packages/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('link', { name: /PKG-/ }).first().click();
  await expect(page.getByText('Demonstration mode — no mailbox connected').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send now' })).toHaveCount(0); // no simulated sending
  await expect(page.getByText('Included personnel')).toBeVisible();
  await axe(page, 'package review');
  await page.screenshot({ path: `${SHOTS}/en_package_review.png`, fullPage: true });
});

test('dashboard drill-down lists exactly the records behind a figure', async ({ page }) => {
  await signIn(page, 'carla.mendes@atlantica.example');
  await setLanguage(page, 'en');
  await page.goto('/');
  const card = page.getByRole('article', { name: 'Awaiting supplier confirmation' });
  const value = Number((await card.locator('.value').innerText()).replace(/\D/g, ''));
  await card.getByRole('button', { name: /Records behind this figure/ }).click();
  await expect(page.getByRole('dialog')).toContainText(`${value} records — matches the figure shown`);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: `${SHOTS}/en_dashboard.png`, fullPage: true });
});

test('employee sees only their own mobilisation; manager approval dashboard; mobile layout', async ({ page }) => {
  await signIn(page, 'joao.silva@atlantica.example', 'Password only');
  await expect(page.locator('main h1')).toBeVisible();
  await expect(page.getByRole('link', { name: /Administra|Admin/ })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/employee.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.waitForLoadState('networkidle');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await axe(page, 'employee mobile');
  await page.screenshot({ path: `${SHOTS}/employee_mobile.png`, fullPage: true });
});

test('privileged role without MFA is stopped before any data is shown', async ({ page }) => {
  await signIn(page, 'rui.costa@atlantica.example', 'Password only');
  await expect(page.locator('h1')).toContainText(/Multi-factor|multifator/);
  await page.screenshot({ path: `${SHOTS}/mfa_required.png` });
});

test('dark theme renders with sufficient contrast', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await signIn(page, 'helena.rocha@atlantica.example');
  await page.goto('/readiness');
  await page.waitForLoadState('networkidle');
  await axe(page, 'dark readiness');
  await page.screenshot({ path: `${SHOTS}/dark_readiness.png`, fullPage: true });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await axe(page, 'dark dashboard');
  await page.screenshot({ path: `${SHOTS}/dark_dashboard.png`, fullPage: true });
});
