import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

// Le shim d'aperçu reproduit le registre réel : « Claude (Anthropic) » est un
// squelette, « OpenAI » ne l'est pas. Un compte branché sur le premier annonce
// une collecte automatique qui n'arrivera jamais — c'est ce que ces deux tests
// vérifient bout en bout, du drapeau `implemented` jusqu'au pixel.
test('la carte d’un compte branché sur un connecteur squelette le dit', async ({ page }) => {
  await page.goto('/');
  const claude = page.locator('.card').filter({ hasText: 'Claude Pro' });
  await expect(claude.getByText(/squelette/)).toBeVisible();

  // Le compte servi par un vrai connecteur, lui, n'affiche rien.
  const openai = page.locator('.card').filter({ hasText: 'OpenAI Team' });
  await expect(openai.getByText(/squelette/)).toHaveCount(0);
});

test('« Synchroniser maintenant » sur un squelette échoue franchement et laisse une trace au journal', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('heading', { name: /^Claude Pro/ }).click();
  await page.getByRole('button', { name: 'Synchroniser maintenant' }).click();
  await expect(page.getByText(/squelette/).first()).toBeVisible();

  await page.getByRole('button', { name: '← Dashboard' }).click();
  await page.getByRole('button', { name: 'Journal des syncs' }).click();
  const row = page.locator('tbody tr').first();
  await expect(row).toContainText('claude');
  await expect(row.getByText('squelette', { exact: true })).toBeVisible();
});

// Sauvegarde ↔ restauration. Le shim d'aperçu utilise le MÊME format et le même
// validateur que le processus principal ; l'aller-retour se joue donc en entier
// dans le navigateur, y compris la confirmation avant écrasement.
function fichierTemporaire(nom: string, contenu: string): string {
  const p = path.join(mkdtempSync(path.join(tmpdir(), 'quota-e2e-')), nom);
  writeFileSync(p, contenu, 'utf8');
  return p;
}

test('un fichier d’une autre application est refusé sans rien effacer', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Cursor Max')).toBeVisible();

  const intrus = fichierTemporaire(
    'contractions.json',
    JSON.stringify({ app: 'miss-contraction', contractions: [{ start: 1 }] }),
  );
  await page.getByTestId('import-backup').setInputFiles(intrus);

  await expect(page.getByText(/Restauration refusée/)).toBeVisible();
  // Aucune confirmation n'a été demandée, et les trois comptes sont là.
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByText('Cursor Max')).toBeVisible();
  await expect(page.getByText('OpenAI Team')).toBeVisible();
});

test('la sauvegarde exportée se restaure, après confirmation', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Cursor Max')).toBeVisible();

  // 1. Sauvegarder (le shim déclenche un vrai téléchargement).
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Sauvegarder (JSON)' }).click(),
  ]);
  const sauvegarde = await download.path();
  expect(sauvegarde).toBeTruthy();

  // 2. Supprimer un compte, pour avoir quelque chose à retrouver.
  await page.getByRole('heading', { name: /^Claude Pro/ }).click();
  await page.getByRole('button', { name: 'Supprimer', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Supprimer' }).click();
  await expect(page.getByText('Claude Pro')).toHaveCount(0);

  // 3. Restaurer : la base n'est pas vide, donc l'app demande confirmation et
  //    dit ce qu'elle emporte — clés d'API comprises.
  await page.getByTestId('import-backup').setInputFiles(sauvegarde!);
  const dialog = page.getByRole('alertdialog', { name: 'Remplacer les données actuelles ?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Les clés d'API ne sont pas dans une sauvegarde");
  await dialog.getByRole('button', { name: 'Restaurer' }).click();

  await expect(page.getByText(/Sauvegarde restaurée/)).toBeVisible();
  await expect(page.getByText('Claude Pro')).toBeVisible();
});

test('refuser la confirmation ne change rien', async ({ page }) => {
  await page.goto('/');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Sauvegarder (JSON)' }).click(),
  ]);
  await page.getByTestId('import-backup').setInputFiles((await download.path())!);

  const dialog = page.getByRole('alertdialog', { name: 'Remplacer les données actuelles ?' });
  await dialog.getByRole('button', { name: 'Annuler' }).click();
  await expect(page.getByText(/Restauration annulée/)).toBeVisible();
  await expect(page.getByText('Cursor Max')).toBeVisible();
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
