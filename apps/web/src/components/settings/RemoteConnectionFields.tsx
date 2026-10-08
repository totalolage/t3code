import { PlusIcon, Trash2Icon } from "lucide-react";
import { useId } from "react";

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  applyRemotePairingUrlToFields,
  getRemotePairingUrlFields,
  type RemoteConnectionFieldsValue,
} from "./remoteConnectionFields";

export function RemoteConnectionFields({
  value,
  onChange,
  disabled = false,
  autoFocus = false,
  hostLabel = "Host",
  showPairingCode = true,
  pairingUrlHint = "Paste a full pairing URL here to fill the host, pairing code, and query parameters automatically.",
}: {
  readonly value: RemoteConnectionFieldsValue;
  readonly onChange: (value: RemoteConnectionFieldsValue) => void;
  readonly disabled?: boolean;
  readonly autoFocus?: boolean;
  readonly hostLabel?: string;
  readonly showPairingCode?: boolean;
  readonly pairingUrlHint?: string;
}) {
  const parameterId = useId();

  const updateParameter = (index: number, field: "key" | "value", nextValue: string) => {
    onChange({
      ...value,
      queryParameters: value.queryParameters.map((parameter, parameterIndex) =>
        parameterIndex === index ? { ...parameter, [field]: nextValue } : parameter,
      ),
    });
  };

  const addParameter = () => {
    onChange({
      ...value,
      queryParameters: [...value.queryParameters, { key: "", value: "" }],
    });
  };

  const removeParameter = (index: number) => {
    onChange({
      ...value,
      queryParameters: value.queryParameters.filter(
        (_, parameterIndex) => parameterIndex !== index,
      ),
    });
  };
  const parameterRows = value.queryParameters.map((parameter, index) => ({
    id: `${parameterId}-${index}`,
    index,
    parameter,
  }));

  return (
    <div className="space-y-4">
      <div className={cn("grid gap-3", showPairingCode && "sm:grid-cols-[minmax(0,1fr)_10rem]")}>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">{hostLabel}</span>
          <Input
            value={value.host}
            onChange={(event) =>
              onChange(
                applyRemotePairingUrlToFields(value, event.currentTarget.value, {
                  preservePairingCode: !showPairingCode,
                }),
              )
            }
            onPaste={(event) => {
              const next = getRemotePairingUrlFields(
                value,
                event.clipboardData.getData("text/plain"),
                {
                  acceptTokenlessUrl: true,
                  preservePairingCode: !showPairingCode,
                },
              );
              if (next === null) return;
              event.preventDefault();
              onChange(next);
            }}
            placeholder="backend.example.com"
            disabled={disabled}
            autoFocus={autoFocus}
            spellCheck={false}
          />
        </label>
        {showPairingCode ? (
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">Pairing code</span>
            <Input
              value={value.pairingCode}
              onChange={(event) => onChange({ ...value, pairingCode: event.currentTarget.value })}
              placeholder="PAIRCODE"
              disabled={disabled}
              spellCheck={false}
            />
          </label>
        ) : null}
      </div>
      <p className="text-2xs text-muted-foreground">{pairingUrlHint}</p>

      <section className="space-y-2.5" aria-label="Additional query parameters">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-xs font-medium text-foreground">Additional query parameters</h3>
            <p className="mt-1 text-2xs text-muted-foreground">
              Values are sent in the order shown. Duplicate keys are preserved.
            </p>
          </div>
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={addParameter}
            aria-label="Add query parameter"
          >
            <PlusIcon className="size-3.5" />
            Add parameter
          </Button>
        </div>

        {value.queryParameters.length > 0 ? (
          <div className="space-y-2">
            {parameterRows.map(({ id, index, parameter }) => {
              const keyId = `${parameterId}-${index}-key`;
              const valueId = `${parameterId}-${index}-value`;
              const rowLabel = `Query parameter ${index + 1}`;
              return (
                <div
                  key={id}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2"
                  role="group"
                  aria-label={rowLabel}
                >
                  <label className="min-w-0">
                    <span className="mb-1 block text-2xs text-muted-foreground">Key</span>
                    <Input
                      id={keyId}
                      value={parameter.key}
                      onChange={(event) => updateParameter(index, "key", event.currentTarget.value)}
                      aria-label={`${rowLabel} key`}
                      placeholder="key"
                      disabled={disabled}
                      spellCheck={false}
                    />
                  </label>
                  <label className="min-w-0">
                    <span className="mb-1 block text-2xs text-muted-foreground">Value</span>
                    <Input
                      id={valueId}
                      value={parameter.value}
                      onChange={(event) =>
                        updateParameter(index, "value", event.currentTarget.value)
                      }
                      aria-label={`${rowLabel} value`}
                      placeholder="value"
                      disabled={disabled}
                      spellCheck={false}
                    />
                  </label>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove ${rowLabel.toLowerCase()}`}
                    disabled={disabled}
                    onClick={() => removeParameter(index)}
                  >
                    <Trash2Icon aria-hidden className="size-3.5" />
                  </Button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
            No additional query parameters.
          </p>
        )}
      </section>
    </div>
  );
}
