import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ChangeEvent, ReactNode } from 'react';
import { api, ApiError } from '@/api/client';
import { Badge, Banner, Button, Field, Input, Modal, Switch, cx, useToast } from '@/components/ui';
import { IconDownload } from '@/components/icons';

/**
 * Editor de los ficheros de un proyecto.
 *
 * Sirve para crear y para editar, porque son la misma pantalla con los mismos
 * dos ficheros: separarlas obligaria a mantener dos copias del editor y de sus
 * avisos.
 *
 * Es un `textarea` monoespaciado y no un editor de codigo de verdad. La razon
 * es de peso, literalmente: CodeMirror con su modo YAML son unos 200 KB, mas
 * que todo el resto de la aplicacion junta, para un fichero que se toca cada
 * varios meses desde un NAS que puede estar sirviendo por wifi.
 */

const COMPOSE_PLACEHOLDER = `services:
  reproductor:
    image: ghcr.io/ejemplo/reproductor:1.4.0
    restart: unless-stopped
    ports:
      - "8096:8096"
    environment:
      TZ: \${TZ}
    volumes:
      - ./datos:/config
`;

const ENV_PLACEHOLDER = `TZ=Europe/Madrid
PUID=1000
DB_PASSWORD=cambiame
`;

export function ProjectEditor({
  /** Proyecto a editar. Sin el, es una creacion. */
  project,
  onClose,
}: {
  project?: { key: string; name: string };
  onClose: () => void;
}): ReactNode {
  const { t } = useTranslation();
  const notify = useToast();
  const queryClient = useQueryClient();
  const editing = project !== undefined;

  const [projectName, setProjectName] = useState(project?.name ?? '');
  const [compose, setCompose] = useState('');
  const [env, setEnv] = useState('');
  const [start, setStart] = useState(true);
  const [tab, setTab] = useState<'compose' | 'env'>('compose');
  const [nameError, setNameError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(!editing);

  const dir = useQuery({ queryKey: ['projects-dir'], queryFn: () => api.projectsDir() });

  /**
   * Al editar se piden los dos ficheros por separado.
   *
   * El `.env` viene de una ruta propia que devuelve el texto en claro y deja
   * constancia en la auditoria, mientras que la de los ficheros devuelve los
   * secretos ocultos. No se puede editar lo que no se ve, asi que entrar aqui
   * es de por si el momento de registrar el acceso.
   */
  useEffect(() => {
    if (!editing || loaded) return;

    let cancelled = false;
    void (async () => {
      try {
        const [files, envRaw] = await Promise.all([
          api.projectFiles(project.key),
          api.projectEnvRaw(project.key).catch(() => ({ content: '' })),
        ]);
        if (cancelled) return;
        setCompose(files.files.compose);
        setEnv(envRaw.content);
        setLoaded(true);
      } catch {
        if (!cancelled) {
          notify(t('projects.filesUnavailable'), 'danger');
          onClose();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [editing, loaded, project, notify, onClose, t]);

  const save = useMutation({
    mutationFn: async () => {
      if (editing) {
        return api.saveProjectFiles({ projectKey: project.key, compose, env, apply: start });
      }
      return api.createProject({ name: projectName, compose, env, start });
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['containers'] });
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });

      const failure = 'startError' in result ? result.startError : ('applyError' in result ? result.applyError : undefined);
      if (failure) {
        // Guardar y arrancar son dos cosas distintas: que falle lo segundo no
        // deshace lo primero, y decir solo "error" haria pensar que se ha
        // perdido el trabajo.
        notify(t('projects.savedButNotStarted', { reason: failure }), 'danger');
      } else if (start) {
        notify(t('updates.runsInBackground'), 'info');
      } else {
        notify(t('common.saved'), 'ok');
      }
      onClose();
    },
    onError: (error) => {
      const code = error instanceof ApiError ? error.code : '';
      const message = error instanceof ApiError ? error.message : '';

      if (code === 'already-exists') {
        setNameError(t('projects.nameTaken'));
        return;
      }
      if (code === 'invalid-name') {
        setNameError(t('projects.nameInvalid'));
        return;
      }
      if (code === 'invalid-compose') {
        // Compose suele indicar la linea. Se muestra tal cual, que es mucho mas
        // util que traducirlo a un "fichero no valido" generico.
        setTab('compose');
        setSaveError(message || t('projects.composeInvalid'));
        return;
      }
      if (code === 'not-writable' || code === 'not-editable') {
        setSaveError(message);
        return;
      }
      setSaveError(message || t('common.error'));
    },
  });

  const canWrite = dir.data?.writable ?? false;
  const blocked = !editing && !canWrite;
  const valid = compose.trim().length > 0 && (editing || /^[a-z0-9][a-z0-9_-]*$/.test(projectName));

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      wide
      resizable
      storageKey="project-editor"
      title={editing ? t('projects.editFiles', { name: project.name }) : t('projects.newProject')}
      description={editing ? t('projects.editFilesHelp') : t('projects.newProjectHelp')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={blocked || !valid || !loaded}
            loading={save.isPending}
            onClick={() => {
              setSaveError(null);
              setNameError(null);
              save.mutate();
            }}
          >
            {editing ? t('common.save') : t('common.create')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {blocked ? (
          <Banner tone="danger" title={t('projects.cannotCreate')}>
            {dir.data?.reason}
          </Banner>
        ) : null}

        {saveError ? (
          <Banner tone="danger" title={t('projects.saveFailed')}>
            <pre className="mt-1 whitespace-pre-wrap font-mono text-[0.6875rem]">{saveError}</pre>
          </Banner>
        ) : null}

        {editing ? null : (
          <Field label={t('projects.name')} error={nameError ?? undefined} hint={t('projects.nameHelp')}>
            <Input
              value={projectName}
              onChange={(event) => {
                setProjectName(event.target.value.toLowerCase());
                setNameError(null);
              }}
              placeholder="reproductor"
              autoFocus
              disabled={blocked}
            />
          </Field>
        )}

        {dir.data?.path && !editing ? (
          <p className="font-mono text-[0.6875rem] text-[var(--text-muted)]">
            {dir.data.path}/{projectName || '…'}/docker-compose.yml
          </p>
        ) : null}

        {!blocked ? (
          <Switch
            checked={start}
            onCheckedChange={setStart}
            label={editing ? t('projects.applyAfterSave') : t('projects.startAfterCreate')}
            hint={t('projects.startHint')}
          />
        ) : null}

        <div className="flex gap-1 border-b border-[var(--border)]">
          <TabButton active={tab === 'compose'} onClick={() => setTab('compose')}>
            docker-compose.yml
          </TabButton>
          <TabButton active={tab === 'env'} onClick={() => setTab('env')}>
            .env
            {env.trim() ? <Badge tone="accent">{countEntries(env)}</Badge> : null}
          </TabButton>
        </div>

        {tab === 'compose' ? (
          <FileEditor
            value={compose}
            onChange={setCompose}
            placeholder={COMPOSE_PLACEHOLDER}
            accept=".yml,.yaml,text/yaml"
            disabled={blocked}
            label={t('projects.uploadCompose')}
          />
        ) : (
          <>
            <Banner tone="info" title={t('projects.envSecurity')}>
              {t('projects.envSecurityHelp')}
            </Banner>
            <FileEditor
              value={env}
              onChange={setEnv}
              placeholder={ENV_PLACEHOLDER}
              accept=".env,text/plain"
              disabled={blocked}
              label={t('projects.uploadEnv')}
            />
          </>
        )}
      </div>
    </Modal>
  );
}

/**
 * Area de texto con carga de fichero.
 *
 * Las dos vias que pidio el usuario, subir y pegar, acaban en el mismo sitio:
 * el fichero solo se lee para volcar su texto aqui, de forma que lo que se
 * guarda siempre es lo que se ve. Subir un fichero y que se guardase algo
 * distinto de lo mostrado seria el peor comportamiento posible.
 */
function FileEditor({
  value,
  onChange,
  placeholder,
  accept,
  disabled,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  accept: string;
  disabled?: boolean;
  label: string;
}): ReactNode {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const readFile = async (file: File): Promise<void> => {
    onChange(await file.text());
  };

  const onPick = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (file) void readFile(file);
    // Se limpia para que elegir el mismo fichero otra vez vuelva a disparar.
    event.target.value = '';
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[0.75rem] text-[var(--text-muted)]">{t('projects.pasteOrUpload')}</span>
        <>
          <input ref={input} type="file" accept={accept} onChange={onPick} className="hidden" />
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            icon={<IconDownload size={14} />}
            onClick={() => input.current?.click()}
          >
            {label}
          </Button>
        </>
      </div>

      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        // Los editores de YAML no admiten tabuladores y es un error facil de
        // cometer al pegar. Se sustituyen por dos espacios al vuelo.
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          event.preventDefault();
          const target = event.currentTarget;
          const { selectionStart, selectionEnd } = target;
          const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
          onChange(next);
          requestAnimationFrame(() => {
            target.selectionStart = target.selectionEnd = selectionStart + 2;
          });
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer.files?.[0];
          if (file) void readFile(file);
        }}
        className={cx(
          'h-[max(18rem,40vh)] w-full resize-y rounded-[var(--radius-sm)] border p-3',
          'bg-[var(--bg-inset)] font-mono text-[0.75rem] leading-relaxed',
          'focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40',
          dragging ? 'border-[var(--accent)]' : 'border-[var(--border)]',
        )}
      />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'flex items-center gap-1.5 px-3 py-1.5 font-mono text-[0.75rem]',
        'border-b-2 transition-colors duration-[var(--dur-fast)]',
        active
          ? 'border-[var(--accent)] text-[var(--text)]'
          : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]',
      )}
    >
      {children}
    </button>
  );
}

/** Cuantas variables tiene el .env, para avisar de un vistazo de que hay algo. */
function countEntries(text: string): number {
  return text
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('#') && line.includes('='))
    .length;
}

/**
 * Lista del `.env` en modo lectura, con los secretos tapados.
 *
 * Se usa en la ficha del proyecto: enseña que variables hay sin enseñar lo que
 * valen, que es lo que hace falta el noventa por ciento de las veces.
 */
export function EnvSummary({ projectKey }: { projectKey: string }): ReactNode {
  const { t } = useTranslation();
  const notify = useToast();
  const [revealed, setRevealed] = useState<Record<string, string>>({});

  const { data } = useQuery({
    queryKey: ['project-files', projectKey],
    queryFn: () => api.projectFiles(projectKey),
  });

  const reveal = useMutation({
    mutationFn: (key: string) => api.revealEnvValue(projectKey, key),
    onSuccess: (result, key) => setRevealed((current) => ({ ...current, [key]: result.value })),
    onError: () => notify(t('common.error'), 'danger'),
  });

  if (!data?.files.envExists) return null;

  return (
    <ul className="space-y-1">
      {data.files.env.map((entry) => (
        <li key={entry.key} className="flex items-center gap-2 text-[0.75rem]">
          <span className="shrink-0 font-mono text-[var(--text-muted)]">{entry.key}</span>
          <span className="min-w-0 flex-1 truncate text-right font-mono">
            {revealed[entry.key] ?? entry.value}
          </span>
          {entry.secret && revealed[entry.key] === undefined ? (
            <Button
              size="sm"
              variant="ghost"
              loading={reveal.isPending && reveal.variables === entry.key}
              onClick={() => reveal.mutate(entry.key)}
            >
              {t('projects.reveal')}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
