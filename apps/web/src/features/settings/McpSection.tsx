import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import {
  MCP_CLIENTS,
  MCP_SCOPES,
  MCP_SCOPE_RISK,
  buildSetup,
  type McpClient,
  type McpScope,
  type McpTokenCreated,
  type Shell,
} from '@cu/shared';
import { api } from '@/api/client';
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Modal,
  SectionTitle,
  Select,
  Skeleton,
  useToast,
} from '@/components/ui';
import { formatRelative } from '@/lib/format';
import { IconKey, IconTrash } from '@/components/icons';

/**
 * Acceso por MCP para asistentes de IA.
 *
 * Lo que hay que tener claro al usar esto, y por eso la pantalla lo dice y no
 * solo la documentacion: un token de aqui habla con una aplicacion que manda
 * sobre el socket de Docker. Segun los permisos que le des, puede con toda la
 * maquina. De ahi que los permisos se elijan uno a uno, que cada uno lleve su
 * nivel de riesgo a la vista, y que por defecto no venga marcado nada peligroso.
 */
export function McpSection(): ReactNode {
  const { t } = useTranslation();
  const notify = useToast();
  const queryClient = useQueryClient();

  const [creando, setCreando] = useState(false);
  const [creado, setCreado] = useState<McpTokenCreated | null>(null);

  const tokens = useQuery({ queryKey: ['mcp-tokens'], queryFn: () => api.mcpTokens() });

  const revocar = useMutation({
    mutationFn: (id: number) => api.revokeMcpToken(id),
    onSuccess: () => {
      notify(t('mcp.revoked'), 'ok');
      void queryClient.invalidateQueries({ queryKey: ['mcp-tokens'] });
    },
    onError: () => notify(t('common.error'), 'danger'),
  });

  return (
    <Card className="p-5">
      <SectionTitle
        title={t('mcp.title')}
        description={t('mcp.help')}
        action={
          <Button size="sm" variant="ghost" icon={<IconKey size={15} />} onClick={() => setCreando(true)}>
            {t('mcp.create')}
          </Button>
        }
      />

      {tokens.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : (tokens.data?.tokens.length ?? 0) === 0 ? (
        <p className="text-[0.8125rem] text-[var(--text-muted)]">{t('mcp.none')}</p>
      ) : (
        <ul className="space-y-1.5">
          {tokens.data?.tokens.map((token) => (
            <li
              key={token.id}
              className="flex min-w-0 flex-wrap items-center gap-2 rounded-[var(--radius-sm)] bg-[var(--bg-inset)] px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-[0.8125rem] font-medium">{token.name}</p>
                <p className="text-[0.6875rem] text-[var(--text-muted)]">
                  <span className="font-mono">{token.hint}…</span>
                  {' · '}
                  {token.lastUsedAt
                    ? t('mcp.lastUsed', { when: formatRelative(token.lastUsedAt) })
                    : t('mcp.neverUsed')}
                </p>
              </div>
              <div className="flex flex-wrap gap-1">
                {token.scopes.map((scope) => (
                  <Badge key={scope} tone={MCP_SCOPE_RISK[scope] === 'high' ? 'warn' : 'neutral'}>
                    {t(`mcp.scope_${scope.replace('.', '_')}`)}
                  </Badge>
                ))}
              </div>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t('mcp.revoke')}
                loading={revocar.isPending && revocar.variables === token.id}
                onClick={() => revocar.mutate(token.id)}
              >
                <IconTrash size={15} />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {creando ? (
        <CreateDialog
          onClose={() => setCreando(false)}
          onCreated={(resultado) => {
            setCreando(false);
            setCreado(resultado);
            void queryClient.invalidateQueries({ queryKey: ['mcp-tokens'] });
          }}
        />
      ) : null}

      {creado ? <ConnectDialog created={creado} onClose={() => setCreado(null)} /> : null}
    </Card>
  );
}

function CreateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (created: McpTokenCreated) => void;
}): ReactNode {
  const { t } = useTranslation();
  const notify = useToast();
  const [nombre, setNombre] = useState('');
  // Solo lectura marcada de salida: es lo que casi todo el mundo quiere y lo
  // unico que no puede romper nada.
  const [scopes, setScopes] = useState<Set<McpScope>>(() => new Set<McpScope>(['read']));

  const crear = useMutation({
    mutationFn: () =>
      api.createMcpToken({ name: nombre.trim() || 'MCP', scopes: [...scopes] }),
    onSuccess: onCreated,
    onError: () => notify(t('common.error'), 'danger'),
  });

  const alternar = (scope: McpScope): void =>
    setScopes((actuales) => {
      const siguiente = new Set(actuales);
      if (siguiente.has(scope)) siguiente.delete(scope);
      else siguiente.add(scope);
      return siguiente;
    });

  return (
    <Modal
      open
      onOpenChange={(abierto) => !abierto && onClose()}
      wide
      title={t('mcp.create')}
      description={t('mcp.createHelp')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={crear.isPending}
            disabled={scopes.size === 0}
            onClick={() => crear.mutate()}
          >
            {t('mcp.create')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('mcp.name')} hint={t('mcp.nameHelp')} htmlFor="mcp-name">
          <Input
            id="mcp-name"
            value={nombre}
            onChange={(event) => setNombre(event.target.value)}
            placeholder="Claude en el portatil"
          />
        </Field>

        <div>
          <p className="mb-1 text-[0.8125rem] font-medium">{t('mcp.scopes')}</p>
          <p className="mb-2 text-[0.75rem] text-[var(--text-muted)]">{t('mcp.scopesHelp')}</p>
          <ul className="space-y-1">
            {MCP_SCOPES.map((scope) => {
              const riesgo = MCP_SCOPE_RISK[scope];
              const clave = scope.replace('.', '_');
              return (
                <li key={scope}>
                  <label className="flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-sm)] px-2 py-1.5 hover:bg-[var(--bg-hover)]">
                    <input
                      type="checkbox"
                      checked={scopes.has(scope)}
                      onChange={() => alternar(scope)}
                      className="mt-0.5 size-4 shrink-0 cursor-pointer accent-[var(--accent)]"
                    />
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[0.8125rem] font-medium">
                          {t(`mcp.scope_${clave}`)}
                        </span>
                        {riesgo !== 'low' ? (
                          <Badge tone={riesgo === 'high' ? 'danger' : 'warn'}>
                            {t(riesgo === 'high' ? 'mcp.riskHigh' : 'mcp.riskMedium')}
                          </Badge>
                        ) : null}
                      </span>
                      <span className="block text-[0.75rem] text-[var(--text-muted)]">
                        {t(`mcp.scopeHelp_${clave}`)}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Se enseña el secreto UNA vez, con la orden ya montada.
 *
 * No se puede volver a consultar porque se guarda hasheado, igual que las
 * sesiones. Decirlo aqui, y no solo en la documentacion, es lo que evita que
 * alguien cierre el dialogo pensando que lo tendra a mano luego.
 */
function ConnectDialog({
  created,
  onClose,
}: {
  created: McpTokenCreated;
  onClose: () => void;
}): ReactNode {
  const { t } = useTranslation();
  const notify = useToast();
  const [cliente, setCliente] = useState<McpClient>('claude-code');
  const [shell, setShell] = useState<Shell>(() =>
    typeof navigator !== 'undefined' && /win/i.test(navigator.platform) ? 'powershell' : 'bash',
  );

  const url = `${window.location.origin}/api/mcp`;
  const snippet = buildSetup(cliente, { url, token: created.secret, shell });

  const copiar = async (texto: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(texto);
      notify(t('common.copied'), 'ok');
    } catch {
      notify(t('common.error'), 'danger');
    }
  };

  return (
    <Modal
      open
      onOpenChange={(abierto) => !abierto && onClose()}
      wide
      title={t('mcp.connectTitle')}
      description={t('mcp.connectHelp')}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="rounded-[var(--radius-sm)] border border-[var(--warn)] px-3 py-2 text-[0.8125rem]">
          {t('mcp.onlyOnce')}
        </div>

        <div className="flex flex-wrap gap-3">
          <Field label={t('mcp.client')} htmlFor="mcp-client">
            <Select
              id="mcp-client"
              value={cliente}
              onChange={(event) => setCliente(event.target.value as McpClient)}
            >
              {MCP_CLIENTS.map((entry) => (
                <option key={entry} value={entry}>
                  {t(`mcp.client_${entry.replace('-', '_')}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('mcp.shell')} htmlFor="mcp-shell">
            <Select
              id="mcp-shell"
              value={shell}
              onChange={(event) => setShell(event.target.value as Shell)}
            >
              <option value="bash">Linux / macOS</option>
              <option value="powershell">Windows (PowerShell)</option>
              <option value="cmd">Windows (cmd)</option>
            </Select>
          </Field>
        </div>

        {snippet.path ? (
          <p className="text-[0.75rem] text-[var(--text-muted)]">
            {t('mcp.configPath')} <span className="font-mono">{snippet.path}</span>
          </p>
        ) : null}

        <div className="relative">
          <pre className="max-h-64 overflow-auto rounded-[var(--radius-sm)] bg-[var(--bg-inset)] p-3 font-mono text-[0.75rem] whitespace-pre-wrap break-all">
            {snippet.content}
          </pre>
          <Button
            size="sm"
            variant="secondary"
            className="absolute right-2 top-2"
            onClick={() => void copiar(snippet.content)}
          >
            {t('common.copy')}
          </Button>
        </div>

        <p className="text-[0.75rem] text-[var(--text-muted)]">
          {t('mcp.urlNote', { url })}
        </p>
      </div>
    </Modal>
  );
}
