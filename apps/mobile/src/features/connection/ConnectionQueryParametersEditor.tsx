import type { RemoteQueryParameter } from "@t3tools/shared/remote";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";

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
  return rows.map(({ key, value }) => ({ key, value }));
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
  const iconColor = useThemeColor("--color-icon-subtle");

  const updateRow = (id: string, field: "key" | "value", value: string) => {
    onRowsChange(rows.map((row) => (row.id === id ? { ...row, [field]: value } : row)));
  };

  return (
    <View className="gap-2">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open, disabled }}
        disabled={disabled}
        className="flex-row items-center justify-between py-1 active:opacity-70 disabled:opacity-50"
        onPress={() => {
          const nextOpen = !open;
          if (nextOpen && rows.length === 0) {
            onRowsChange([makeQueryParameterRow()]);
          }
          onOpenChange(nextOpen);
        }}
      >
        <Text className="text-xs font-t3-bold text-foreground-muted">Add query parameters</Text>
        <SymbolView
          name="chevron.down"
          size={11}
          tintColor={iconColor}
          type="monochrome"
          style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }}
        />
      </Pressable>

      {open ? (
        <View className="gap-2">
          {rows.map((row) => (
            <View key={row.id} className="flex-row items-center gap-2">
              <TextInput
                accessibilityLabel="Query parameter key"
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="Key"
                value={row.key}
                editable={!disabled}
                onChangeText={(value) => updateRow(row.id, "key", value)}
                className="min-w-0 flex-1 rounded-[12px] border border-input-border bg-input px-3 py-2.5 text-sm text-foreground"
              />
              <TextInput
                accessibilityLabel="Query parameter value"
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="Value"
                value={row.value}
                editable={!disabled}
                onChangeText={(value) => updateRow(row.id, "value", value)}
                className="min-w-0 flex-1 rounded-[12px] border border-input-border bg-input px-3 py-2.5 text-sm text-foreground"
              />
              <Pressable
                accessibilityLabel="Remove query parameter"
                accessibilityRole="button"
                disabled={disabled}
                className="h-9 w-9 items-center justify-center rounded-[12px] active:opacity-70 disabled:opacity-50"
                onPress={() => onRowsChange(rows.filter((item) => item.id !== row.id))}
              >
                <SymbolView name="xmark" size={12} tintColor={iconColor} type="monochrome" />
              </Pressable>
            </View>
          ))}
          <Pressable
            accessibilityLabel="Add query parameter"
            accessibilityRole="button"
            disabled={disabled}
            className="h-9 w-9 items-center justify-center rounded-[12px] active:opacity-70 disabled:opacity-50"
            onPress={() => onRowsChange([...rows, makeQueryParameterRow()])}
          >
            <SymbolView name="plus" size={13} tintColor={iconColor} type="monochrome" />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
