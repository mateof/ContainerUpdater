import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import type { BlockDevice, DiskDeviceConfigInput } from '@cu/shared';
import { api } from '@/api/client';
import { Badge, Card, Input, SectionTitle, useToast } from '@/components/ui';

function parseNumber(value: string): number | null {
  const trimmed = value.trim().replace(',', '.');
  if (trimmed === '') return null;
  const number = Number(trimmed);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function DiskDevicesSection({ enabled }: { enabled: boolean }): ReactNode {
  const { t } = useTranslation();
  const notify = useToast();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ['disk-io', 'devices'],
    queryFn: () => api.diskDevices(),
    enabled,
  });

  const save = useMutation({
    mutationFn: ({ name, body }: { name: string; body: DiskDeviceConfigInput }) => api.saveDiskDevice(name, body),
    onSuccess: () => {
      notify(t('settings.diskSaved'), 'ok');
      void queryClient.invalidateQueries({ queryKey: ['disk-io'] });
    },
    onError: () => notify(t('common.error'), 'danger'),
  });

  if (!enabled) return null;
  const devices = data?.devices ?? [];

  return (
    <Card className="p-5">
      <SectionTitle title={t('settings.diskDevices')} description={t('settings.diskDevicesDescription')} />
      {devices.length === 0 ? (
        <p className="text-[0.8125rem] text-[var(--text-muted)]">{t('settings.diskDevicesEmpty')}</p>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {devices.map((device) => (
            <DeviceRow
              key={device.name}
              device={device}
              onSave={(body) => save.mutate({ name: device.name, body })}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function DeviceRow({
  device,
  onSave,
}: {
  device: BlockDevice;
  onSave: (body: DiskDeviceConfigInput) => void;
}): ReactNode {
  const { t } = useTranslation();
  const [tbw, setTbw] = useState(device.tbwTb?.toString() ?? '');
  const [written, setWritten] = useState(device.writtenTb?.toString() ?? '');
  const [threshold, setThreshold] = useState(device.thresholdMbPerMin?.toString() ?? '');

  const commit = (field: keyof DiskDeviceConfigInput, raw: string, current: number | null) => {
    const value = parseNumber(raw);
    if (value === current) return;
    onSave({ [field]: field === 'thresholdMbPerMin' && value === 0 ? null : value });
  };

  const tbwValue = parseNumber(tbw);
  const writtenValue = parseNumber(written);
  const writtenOverTbw = tbwValue !== null && tbwValue > 0 && writtenValue !== null && writtenValue > tbwValue;

  const below = device.kind !== 'physical' && device.disks.length > 0 ? device.disks.join(', ') : null;

  return (
    <li className="py-3 space-y-2">
      <label className="flex cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          checked={device.watched}
          onChange={(event) =>
            onSave({ watched: event.target.checked === device.watchedByDefault ? null : event.target.checked })
          }
        />
        <span className="font-medium tabular-nums">{device.name}</span>
        <Badge tone={device.kind === 'physical' ? 'accent' : 'neutral'}>{t(`settings.diskKind_${device.kind}`)}</Badge>
        {device.label ? <span className="truncate text-[0.75rem] text-[var(--text-faint)]">{device.label}</span> : null}
        {below ? (
          <span className="truncate text-[0.75rem] text-[var(--text-faint)]">{t('settings.diskOn', { disks: below })}</span>
        ) : null}
      </label>

      {device.watched ? (
        <div className="grid gap-3 pl-7 sm:grid-cols-3">
          <NumberField
            id={`tbw-${device.name}`}
            label={t('settings.diskTbw')}
            value={tbw}
            onChange={setTbw}
            onBlur={() => commit('tbwTb', tbw, device.tbwTb)}
          />
          <NumberField
            id={`written-${device.name}`}
            label={t('settings.diskWritten')}
            hint={t('settings.diskWrittenHelp')}
            warning={writtenOverTbw ? t('settings.diskWrittenOverTbw', { tbw: tbwValue }) : undefined}
            value={written}
            onChange={setWritten}
            onBlur={() => commit('writtenTb', written, device.writtenTb)}
          />
          <NumberField
            id={`threshold-${device.name}`}
            label={t('settings.diskThreshold')}
            placeholder={t('settings.diskDefault')}
            value={threshold}
            onChange={setThreshold}
            onBlur={() => commit('thresholdMbPerMin', threshold, device.thresholdMbPerMin)}
          />
        </div>
      ) : null}
    </li>
  );
}

function NumberField({
  id,
  label,
  hint,
  warning,
  value,
  placeholder,
  onChange,
  onBlur,
}: {
  id: string;
  label: string;
  hint?: string;
  warning?: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  onBlur: () => void;
}): ReactNode {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[0.75rem] font-medium">
        {label}
      </label>
      <Input
        id={id}
        inputMode="decimal"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        className="w-28"
      />
      {warning ? (
        <p role="alert" className="text-[0.6875rem] font-medium text-[var(--warn)] leading-snug">
          {warning}
        </p>
      ) : null}
      {hint ? <p className="text-[0.6875rem] text-[var(--text-muted)] leading-snug">{hint}</p> : null}
    </div>
  );
}
