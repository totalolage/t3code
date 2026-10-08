import type { RemoteQueryParameter } from "@t3tools/shared/remote";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ConnectionSheetButton } from "./ConnectionSheetButton";

export function QueryParameterFields(props: {
  readonly value: ReadonlyArray<RemoteQueryParameter>;
  readonly onChange: (value: ReadonlyArray<RemoteQueryParameter>) => void;
}) {
  const updateParameter = (index: number, field: "key" | "value", nextValue: string) => {
    props.onChange(
      props.value.map((parameter, parameterIndex) =>
        parameterIndex === index ? { ...parameter, [field]: nextValue } : parameter,
      ),
    );
  };

  const removeParameter = (index: number) => {
    props.onChange(props.value.filter((_, parameterIndex) => parameterIndex !== index));
  };

  return (
    <View className="gap-2">
      <View className="gap-1.5">
        <Text className="text-2xs font-t3-bold tracking-[0.8px] uppercase text-foreground-muted">
          Routing parameters
        </Text>
        <Text className="text-xs leading-normal text-foreground-muted">
          Optional query parameters for this environment.
        </Text>
      </View>

      {props.value.map((parameter, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- Query parameters are controlled ordered pairs, so their identity is positional.
        <View key={index} className="flex-row items-center gap-2">
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={`Query parameter ${index + 1} key`}
            placeholder="Key"
            value={parameter.key}
            onChangeText={(nextValue) => updateParameter(index, "key", nextValue)}
            className="min-w-0 flex-1 rounded-[14px] border border-input-border bg-input px-3 py-3 text-base text-foreground"
          />
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={`Query parameter ${index + 1} value`}
            placeholder="Value"
            value={parameter.value}
            onChangeText={(nextValue) => updateParameter(index, "value", nextValue)}
            className="min-w-0 flex-1 rounded-[14px] border border-input-border bg-input px-3 py-3 text-base text-foreground"
          />
          <Pressable
            accessibilityLabel={`Remove query parameter ${index + 1}`}
            accessibilityRole="button"
            accessibilityHint="Removes this query parameter"
            className="h-[42px] w-[42px] items-center justify-center rounded-[14px] border border-danger-border bg-danger active:opacity-70"
            onPress={() => removeParameter(index)}
          >
            <SymbolView
              name={{ ios: "minus", android: "remove" }}
              size={14}
              tintColorClassName="accent-danger-foreground"
              type="monochrome"
            />
          </Pressable>
        </View>
      ))}

      <ConnectionSheetButton
        compact
        icon="plus"
        label="Add query parameter"
        tone="secondary"
        onPress={() => props.onChange([...props.value, { key: "", value: "" }])}
      />
    </View>
  );
}
