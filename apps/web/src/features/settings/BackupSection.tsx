import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import type { BackupFile, RestoreReport } from '@cu/shared';
import { api } from '@/api/client';
import { Button, Card, Modal, SectionTitle, Switch, useToast } from '@/components/ui';
import { IconDownload, IconFile } from '@/components/icons';

/**
 * Copia de seguridad de la configuracion.
 *
 * Lo que se exporta y lo que no esta explicado en la propia pantalla, no solo
 * en la documentacion: un fichero llamado "copia de seguridad" que en realidad
 * no lleva las contrasenas es exactamente la clase de cosa que hay que decir
 * ANTES de que alguien confie en el para reinstalar.
 */
export function BackupSection(): ReactNode {
  const { t } = useTranslation();
  const notify = useToast();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);

  const [pending, setPending] = useState<BackupFile | null>(null);
  const [withSettings, setWithSettings] = useState(false);
  const [report, setReport] = useState<RestoreReport | null>(null);

  const restore = useMutation({
    mutationFn: (file: BackupFile) =>
      api.restoreBackup({ file, settings: withSettings, policies: true }),
    onSuccess: (result) => {
      setReport(result.report);
      setPending(null);
      void queryClient.invalidateQueries();
    },
    onError: () => notify(t('common.error'), 'danger'),
  });

  /**
   * La descarga se hace con un blob y no con un enlace directo al endpoint.
   *
   * El endpoint exige la cookie de sesion y responde JSON: navegar a el
   * funcionaria, pero en el movil abre una pestana con el JSON en pantalla en
   * vez de guardar el fichero. Con el blob se controla el nombre y se guarda
   * siempre.
   */
  const download = async () => {
    try {
      const file = await api.backup();
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `containerupdater-${new Date(file.createdAt).toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      notify(t('backup.exported'), 'ok');
    } catch {
      notify(t('common.error'), 'danger');
    }
  };

  const pickFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Se limpia el input o elegir el mismo fichero dos veces no dispararia el
    // evento la segunda vez.
    event.target.value = '';
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        setPending(JSON.parse(String(reader.result)) as BackupFile);
      } catch {
        notify(t('backup.invalidFile'), 'danger');
      }
    };
    reader.readAsText(file);
  };

  return (
    <Card className="p-5">
      <SectionTitle title={t('backup.title')} description={t('backup.help')} />

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" icon={<IconDownload size={15} />} onClick={() => void download()}>
          {t('backup.export')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<IconFile size={15} />}
          onClick={() => fileInput.current?.click()}
        >
          {t('backup.import')}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={pickFile}
        />
      </div>

      <p className="mt-3 text-[0.75rem] text-[var(--text-muted)]">{t('backup.noSecrets')}</p>

      {pending ? (
        <Modal
          open
          onOpenChange={(value) => !value && setPending(null)}
          title={t('backup.import')}
          description={new Date(pending.createdAt).toLocaleString()}
          footer={
            <>
              <Button variant="ghost" onClick={() => setPending(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                loading={restore.isPending}
                onClick={() => restore.mutate(pending)}
              >
                {t('backup.restore')}
              </Button>
            </>
          }
        >
          <div className="space-y-3 text-[0.8125rem]">
            <p>{t('backup.willRestore', { count: pending.policies?.length ?? 0 })}</p>
            <Switch
              checked={withSettings}
              onCheckedChange={setWithSettings}
              label={t('backup.alsoSettings')}
              hint={t('backup.alsoSettingsHelp')}
            />
            <p className="text-[0.75rem] text-[var(--text-muted)]">{t('backup.telegramNote')}</p>
          </div>
        </Modal>
      ) : null}

      {report ? (
        <Modal
          open
          onOpenChange={(value) => !value && setReport(null)}
          title={t('backup.restored')}
          footer={
            <Button variant="primary" onClick={() => setReport(null)}>
              {t('common.close')}
            </Button>
          }
        >
          <ul className="space-y-1 text-[0.8125rem]">
            <li>{t('backup.reportPolicies', { count: report.policies })}</li>
            <li>{t('backup.reportRegistries', { count: report.registries })}</li>
            {report.skipped.length > 0 ? (
              <li className="text-[var(--text-muted)]">
                {t('backup.reportSkipped', { items: report.skipped.join(', ') })}
              </li>
            ) : null}
          </ul>
        </Modal>
      ) : null}
    </Card>
  );
}
