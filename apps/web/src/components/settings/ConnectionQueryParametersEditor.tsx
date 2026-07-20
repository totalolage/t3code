import { normalizeRemoteQueryParameters, type RemoteQueryParameter } from "@t3tools/shared/remote";
import { ChevronDownIcon, PlusIcon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";

export interface QueryParameterRow extends RemoteQueryParameter {
  readonly id: string;
}

let nextRowId = 0;

export function makeQueryParameterRow(parameter?: RemoteQueryParameter): QueryParameterRow {
  nextRowId += 1;
  return {
    id: `query-parameter-${nextRowId}`,
    key: parameter?.key ?? "",
    value: parameter?.value ?? "",
  };
}

export function makeQueryParameterRows(
  parameters: ReadonlyArray<RemoteQueryParameter>,
): ReadonlyArray<QueryParameterRow> {
  return parameters.map(makeQueryParameterRow);
}

export function queryParametersFromRows(
  rows: ReadonlyArray<QueryParameterRow>,
): ReadonlyArray<RemoteQueryParameter> {
  return normalizeRemoteQueryParameters(rows.map(({ key, value }) => ({ key, value })));
}

interface ConnectionQueryParametersEditorProps {
  readonly rows: ReadonlyArray<QueryParameterRow>;
  readonly open: boolean;
  readonly disabled?: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRowsChange: (rows: ReadonlyArray<QueryParameterRow>) => void;
}

export function ConnectionQueryParametersEditor({
  rows,
  open,
  disabled,
  onOpenChange,
  onRowsChange,
}: ConnectionQueryParametersEditorProps) {
  const updateRow = (id: string, field: "key" | "value", value: string) => {
    onRowsChange(rows.map((row) => (row.id === id ? { ...row, [field]: value } : row)));
  };

  return (
    <Collapsible
      open={open}
      onOpenChange={(open) => {
        if (open && rows.length === 0) {
          onRowsChange([makeQueryParameterRow()]);
        }
        onOpenChange(open);
      }}
    >
      <CollapsibleTrigger
        disabled={disabled}
        className="flex w-full items-center justify-between rounded-md px-1 py-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span>Add query parameters</span>
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3.5 transition-transform", open && "rotate-180")}
        />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="space-y-2 pt-2">
          {rows.map((row) => (
            <div key={row.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem] gap-2">
              <Input
                aria-label="Query parameter key"
                value={row.key}
                onChange={(event) => updateRow(row.id, "key", event.target.value)}
                placeholder="Key"
                disabled={disabled}
                spellCheck={false}
              />
              <Input
                aria-label="Query parameter value"
                value={row.value}
                onChange={(event) => updateRow(row.id, "value", event.target.value)}
                placeholder="Value"
                disabled={disabled}
                spellCheck={false}
              />
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Remove query parameter"
                disabled={disabled}
                onClick={() => onRowsChange(rows.filter((item) => item.id !== row.id))}
              >
                <XIcon aria-hidden className="size-3.5" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Add query parameter"
            disabled={disabled}
            onClick={() => onRowsChange([...rows, makeQueryParameterRow()])}
          >
            <PlusIcon aria-hidden className="size-3.5" />
          </Button>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
