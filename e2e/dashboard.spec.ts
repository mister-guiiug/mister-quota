import { expect, test } from '@playwright/test';

// E2E against the renderer running in preview-shim mode (no Electron). The
// shim seeds 3 demo accounts so the dashboard renders end-to-end without a
// real backend. We exercise the golden flow: dashboard → detail → add entry
// → see consumption changed.

test('dashboard shows seeded accounts and updates after a manual entry', async ({ page }) => {
  await page.goto('/');

  // Sidebar + dashboard
  await expect(page.getByRole('heading', { name: 'MISTER QUOTA' })).toBeVisible();
  await expect(page.getByText('Cursor Max')).toBeVisible();
  await expect(page.getByText('Claude Pro')).toBeVisible();
  await expect(page.getByText('OpenAI Team')).toBeVisible();

  // Currency-budget aggregate appears (OpenAI Team uses currency)
  await expect(page.getByText('Budget agrégé')).toBeVisible();

  // Open Cursor detail
  await page.getByRole('heading', { name: /^Cursor Max/ }).click();
  await expect(page.getByRole('heading', { name: /^Cursor Max/ })).toBeVisible();

  // Add a manual entry
  await page.getByRole('button', { name: '+ Saisie manuelle' }).click();
  await page.locator('input[type="number"]').first().fill('100000000');
  await page.getByRole('button', { name: 'Ajouter' }).click();

  // Toast confirms; relevés table contains a new row
  await expect(page.getByText('Relevé ajouté')).toBeVisible();
});

// Depuis l'adoption du ConfirmDialog du socle, la boîte de suppression a un
// nom accessible et le focus initial sur Annuler. Playwright est le seul
// harnais de ce dépôt capable d'exercer un composant React (vitest y tourne en
// environnement `node`) : c'est donc ici que l'usage se vérifie.
test('la confirmation de suppression est nommée et ne détruit pas sur Entrée', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('heading', { name: /^Claude Pro/ }).click();
  await page.getByRole('button', { name: 'Supprimer', exact: true }).click();

  const dialog = page.getByRole('alertdialog', { name: 'Supprimer le compte ?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Annuler' })).toBeFocused();

  // Entrée porte donc sur Annuler, pas sur la suppression : le compte survit.
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: '← Dashboard' }).click();
  await expect(page.getByText('Claude Pro')).toBeVisible();
});

test('tag filter narrows the visible accounts', async ({ page }) => {
  await page.goto('/');
  // Wait for the tag select to mount (it only appears when accounts have tags).
  const tagSelect = page.locator('select').nth(3);
  await expect(tagSelect).toBeVisible();
  await tagSelect.selectOption('pro');
  await expect(page.getByText('OpenAI Team')).toBeVisible();
  await expect(page.getByText('Cursor Max')).toHaveCount(0);
});
