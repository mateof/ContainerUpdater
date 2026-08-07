import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { Banner, Button, Input, Modal, cx } from '@/components/ui';
import { IconGithub, IconSearch } from '@/components/icons';
import { REPO_URL } from '@/components/MadeBy';
import { currentLocale } from '@/i18n';
import { helpSections, type Block } from './content';

/**
 * Ayuda dentro de la aplicacion.
 *
 * Modal con indice a la izquierda y contenido a la derecha. Se navega saltando
 * dentro del mismo panel en vez de cambiando de vista: la ayuda se consulta
 * mientras se esta haciendo algo, y perder el sitio obliga a empezar de nuevo.
 *
 * El contenido esta en `content.ts`, en los dos idiomas.
 */
export function HelpDialog({ onClose }: { onClose: () => void }): ReactNode {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const sections = useMemo(() => helpSections(currentLocale()), []);

  /**
   * Filtrado por texto. Busca tambien dentro de los bloques, no solo en los
   * titulos: quien escribe "red" no sabe en que seccion esta lo que necesita.
   */
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return sections;

    return sections.filter((section) => {
      if (section.title.toLowerCase().includes(needle)) return true;
      return section.blocks.some((block) => blockText(block).toLowerCase().includes(needle));
    });
  }, [sections, search]);

  const goTo = (id: string): void => {
    setActive(id);
    const element = bodyRef.current?.querySelector(`#help-${id}`);
    element?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      wide
      resizable
      storageKey="help"
      title={t('help.title')}
      description={t('help.subtitle')}
      footer={
        <>
          <a href={REPO_URL} target="_blank" rel="noreferrer noopener" className="mr-auto">
            <Button variant="ghost" icon={<IconGithub size={15} />}>
              {t('settings.viewOnGithub')}
            </Button>
          </a>
          <Button variant="primary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      <div className="flex min-h-[50vh] gap-4">
        {/* Indice. Oculto en pantallas estrechas: ahi el contenido ya se lee
            de corrido y un indice a un lado dejaria el texto sin espacio.

            `sticky` con `self-start` es lo que hace que acompane al scroll en
            vez de irse hacia arriba con el cuerpo: quien salta a una seccion
            del final se quedaba sin indice justo cuando queria seguir saltando.
            El `self-start` es imprescindible, porque por defecto un hijo de
            flex se estira a toda la altura y entonces no hay nada que fijar.
            Scroll propio por si el indice crece mas que la ventana. */}
        <nav className="sticky top-0 hidden max-h-[80vh] w-52 shrink-0 self-start overflow-y-auto border-r border-[var(--border)] pr-3 sm:block">
          <div className="relative mb-2">
            <IconSearch
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-faint)]"
            />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('common.search')}
              className="h-8 pl-7 text-[0.8125rem]"
              type="search"
            />
          </div>

          <ul className="space-y-0.5">
            {filtered.map((section) => (
              <li key={section.id}>
                <button
                  type="button"
                  onClick={() => goTo(section.id)}
                  className={cx(
                    'w-full rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left text-[0.8125rem]',
                    'transition-colors duration-[var(--dur-fast)]',
                    active === section.id
                      ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                      : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]',
                  )}
                >
                  {section.title}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div ref={bodyRef} className="min-w-0 flex-1 space-y-6">
          {filtered.length === 0 ? (
            <p className="py-8 text-center text-[0.8125rem] text-[var(--text-muted)]">
              {t('common.empty')}
            </p>
          ) : (
            filtered.map((section) => (
              <section key={section.id} id={`help-${section.id}`} className="scroll-mt-2">
                <h2 className="mb-2 text-[0.9375rem] font-semibold">{section.title}</h2>
                <div className="space-y-2.5">
                  {section.blocks.map((block, index) => (
                    <BlockView key={index} block={block} />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}

function BlockView({ block }: { block: Block }): ReactNode {
  switch (block.type) {
    case 'h':
      return (
        <h3 className="pt-2 text-[0.8125rem] font-semibold text-[var(--text)]">{block.text}</h3>
      );

    case 'p':
      return (
        <p className="text-[0.8125rem] leading-relaxed text-[var(--text-muted)]">{block.text}</p>
      );

    case 'ul':
      return (
        <ul className="space-y-1">
          {block.items.map((item, index) => (
            <li
              key={index}
              className="flex gap-2 text-[0.8125rem] leading-relaxed text-[var(--text-muted)]"
            >
              <span className="mt-[0.45rem] size-1 shrink-0 rounded-full bg-[var(--text-faint)]" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      );

    case 'code':
      return (
        <pre className="overflow-x-auto rounded-[var(--radius-sm)] bg-[var(--bg-inset)] p-3 font-mono text-[0.6875rem] leading-relaxed">
          {block.text}
        </pre>
      );

    case 'note':
      return (
        <Banner tone={block.tone} title={block.title}>
          {block.text}
        </Banner>
      );
  }
}

function blockText(block: Block): string {
  switch (block.type) {
    case 'ul':
      return block.items.join(' ');
    case 'note':
      return `${block.title} ${block.text}`;
    default:
      return block.text;
  }
}
