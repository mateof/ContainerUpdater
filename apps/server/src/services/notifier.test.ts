import { describe, expect, it } from 'vitest';
import { dedupeKey } from '../db/repositories/notifications.js';
import { escapeHtml } from './notifier.js';

describe('dedupeKey', () => {
  const base = {
    channel: 'telegram',
    kind: 'update_available',
    imageRef: 'registry-1.docker.io/library/nginx:latest',
    digest: 'sha256:aaa',
    chatId: 123,
  };

  it('es estable para la misma combinacion', () => {
    expect(dedupeKey(base)).toBe(dedupeKey({ ...base }));
  });

  it('cambia con el digest, que es lo que hace que se vuelva a avisar', () => {
    // El requisito es no repetir avisos, pero SI avisar cuando `latest` pasa a
    // apuntar a una imagen genuinamente nueva. Incluir el digest en la clave es
    // lo que consigue las dos cosas a la vez.
    expect(dedupeKey({ ...base, digest: 'sha256:bbb' })).not.toBe(dedupeKey(base));
  });

  it('separa destinatarios', () => {
    // Dos personas autorizadas deben recibir cada una su aviso.
    expect(dedupeKey({ ...base, chatId: 999 })).not.toBe(dedupeKey(base));
  });

  it('separa imagenes y tipos de aviso', () => {
    expect(dedupeKey({ ...base, imageRef: 'otra:latest' })).not.toBe(dedupeKey(base));
    expect(dedupeKey({ ...base, kind: 'update_applied' })).not.toBe(dedupeKey(base));
  });
});

describe('escapeHtml', () => {
  it('escapa los tres caracteres que rompen el HTML de Telegram', () => {
    expect(escapeHtml('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;');
  });

  it('escapa el ampersand primero para no romper las entidades', () => {
    // Escapar `<` antes que `&` convertiria `&lt;` en `&amp;lt;`.
    expect(escapeHtml('a & b < c')).toBe('a &amp; b &lt; c');
  });

  it('deja intactos los caracteres habituales de una referencia de imagen', () => {
    // Este es el motivo de usar HTML y no MarkdownV2: los puntos, guiones,
    // barras y guiones bajos no necesitan escaparse.
    const ref = 'ghcr.io/mateof/mock-server:1.2.3-alpine';
    expect(escapeHtml(ref)).toBe(ref);
  });
});
