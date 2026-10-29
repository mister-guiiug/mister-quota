import { describe, expect, it } from 'vitest';
import { escapeHtml } from './oauth';

describe('escapeHtml', () => {
  it('neutralise une balise venue de l’URL de retour', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('échappe aussi les guillemets et l’esperluette', () => {
    expect(escapeHtml(`a&b "c" 'd'`)).toBe('a&amp;b &quot;c&quot; &#39;d&#39;');
  });

  it('laisse intacte une erreur OAuth ordinaire', () => {
    expect(escapeHtml('access_denied')).toBe('access_denied');
  });
});
