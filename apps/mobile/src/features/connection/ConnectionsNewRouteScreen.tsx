import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { CameraView, useCameraPermissions } from "expo-camera";
import {
  StackActions,
  useNavigation,
  useRoute,
  type StaticScreenProps,
} from "@react-navigation/native";
import type { ConnectionOnboarding } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import type { RemoteQueryParameter } from "@t3tools/shared/remote";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Linking, Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ConnectionFormField } from "./ConnectionFormField";
import { ConnectionSheetButton } from "./ConnectionSheetButton";
import { QueryParameterFields } from "./QueryParameterFields";
import {
  buildPairingConnectionInput,
  extractPairingUrlFromQrPayload,
  pairingConnectionInputFromUrl,
  parsePairingUrl,
} from "./pairing";
import { applyPairingHostInput } from "./pairingHostInput";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";

type ConnectionsNewRouteParams = {
  readonly mode?: string;
  readonly pairingUrl?: string;
  readonly autoConnect?: string;
  /** Adds a route to this saved machine instead of a new environment. */
  readonly routeFor?: EnvironmentId;
};

export function ConnectionsNewRouteScreen({
  route,
}: StaticScreenProps<ConnectionsNewRouteParams | undefined>) {
  const {
    connectionPairingUrl,
    onChangeConnectionPairingUrl,
    onConnectPress,
    pairingConnectionError,
  } = useRemoteConnections();
  const navigation = useNavigation();
  const routeName = useRoute().name;
  const params = route.params ?? {};
  // Deep-link prefill exists for development automation only. A production
  // link must not arrive with attacker-chosen host and token already filled.
  const routePairingUrl = __DEV__ ? (params.pairingUrl?.trim() ?? "") : "";
  const shouldAutoConnect =
    __DEV__ &&
    routePairingUrl.length > 0 &&
    (params.autoConnect === "1" || params.autoConnect === "true");
  const insets = useSafeAreaInsets();
  const [hostInput, setHostInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [queryParameters, setQueryParameters] = useState<ReadonlyArray<RemoteQueryParameter>>([]);
  const [pairingFormError, setPairingFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showScanner, setShowScanner] = useState(params.mode === "scan_qr");
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [scannerLocked, setScannerLocked] = useState(false);
  const attemptedAutoConnectRef = useRef<string | null>(null);

  const headerIconColor = useUniwindTheme()["--color-icon"];

  const connectDisabled = isSubmitting || hostInput.trim().length === 0;
  const pairingError = pairingFormError ?? pairingConnectionError;

  useEffect(() => {
    const {
      host,
      code,
      queryParameters: nextQueryParameters,
    } = parsePairingUrl(connectionPairingUrl);
    setHostInput(host);
    setCodeInput(code);
    setQueryParameters(nextQueryParameters);
  }, [connectionPairingUrl]);

  useEffect(() => {
    if (routePairingUrl.length === 0) {
      return;
    }

    const { host, code, queryParameters: nextQueryParameters } = parsePairingUrl(routePairingUrl);
    setHostInput(host);
    setCodeInput(code);
    setQueryParameters(nextQueryParameters);
  }, [routePairingUrl]);

  useEffect(() => {
    if (pairingConnectionError) {
      setIsSubmitting(false);
    }
  }, [pairingConnectionError]);

  const handleHostChange = useCallback(
    (value: string) => {
      const next = applyPairingHostInput(
        { host: hostInput, code: codeInput, queryParameters },
        value,
      );
      setHostInput(next.host);
      setCodeInput(next.code);
      setQueryParameters(next.queryParameters);
      setPairingFormError(null);
    },
    [hostInput, codeInput, queryParameters],
  );

  const handleCodeChange = useCallback((value: string) => {
    setCodeInput(value);
    setPairingFormError(null);
  }, []);

  const handleQueryParametersChange = useCallback((value: ReadonlyArray<RemoteQueryParameter>) => {
    setQueryParameters(value);
    setPairingFormError(null);
  }, []);

  const openScanner = useCallback(async () => {
    if (cameraPermission?.granted) {
      setScannerLocked(false);
      setShowScanner(true);
      return;
    }

    const permission = await requestCameraPermission();
    if (permission.granted) {
      setScannerLocked(false);
      setShowScanner(true);
      return;
    }

    if (permission.canAskAgain) {
      Alert.alert(
        "Camera access needed",
        "Allow camera access to scan an environment pairing QR code.",
      );
      return;
    }

    Alert.alert(
      "Camera access needed",
      "Camera access was denied for this app. Open Settings to enable it.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Open Settings", onPress: () => void Linking.openSettings() },
      ],
    );
  }, [cameraPermission?.granted, requestCameraPermission]);

  const closeScanner = useCallback(() => {
    setShowScanner(false);
    setScannerLocked(false);
  }, []);

  const handleQrScan = useCallback(
    ({ data }: { readonly data: string }) => {
      if (scannerLocked) {
        return;
      }

      setScannerLocked(true);

      try {
        const pairingUrl = extractPairingUrlFromQrPayload(data);
        const { host, code, queryParameters: nextQueryParameters } = parsePairingUrl(pairingUrl);
        setHostInput(host);
        setCodeInput(code);
        setQueryParameters(nextQueryParameters);
        setPairingFormError(null);
        onChangeConnectionPairingUrl(pairingUrl);
        setShowScanner(false);
      } catch (error) {
        Alert.alert(
          "Invalid QR code",
          error instanceof Error ? error.message : "Scanned QR code was not recognized.",
        );
      } finally {
        setTimeout(() => {
          setScannerLocked(false);
        }, 600);
      }
    },
    [onChangeConnectionPairingUrl, scannerLocked],
  );

  const connectAndClose = useCallback(
    async (pairingInput: ConnectionOnboarding.PairingConnectionInput, replaceWithHome: boolean) => {
      setIsSubmitting(true);
      // The React-Compiler-powered memo-dependencies lint misreports deps of
      // async callbacks that use try/finally, so settle the flag via .finally.
      const result = await onConnectPress({
        ...pairingInput,
        ...(params.routeFor === undefined ? {} : { expectedEnvironmentId: params.routeFor }),
      }).finally(() => setIsSubmitting(false));
      if (AsyncResult.isSuccess(result)) {
        if (replaceWithHome || !navigation.canGoBack()) {
          navigation.dispatch(StackActions.replace("Home"));
        } else {
          navigation.goBack();
        }
      }
    },
    [navigation, onConnectPress, params.routeFor],
  );

  const handleSubmit = useCallback(async () => {
    setPairingFormError(null);

    let pairingInput: ConnectionOnboarding.PairingConnectionInput;
    try {
      pairingInput = buildPairingConnectionInput(hostInput, codeInput, queryParameters);
    } catch (error) {
      setPairingFormError(
        error instanceof Error ? error.message : "The pairing details are invalid.",
      );
      return;
    }

    await connectAndClose(pairingInput, false);
  }, [codeInput, connectAndClose, hostInput, queryParameters]);

  useEffect(() => {
    if (!shouldAutoConnect || attemptedAutoConnectRef.current === routePairingUrl) {
      return;
    }

    attemptedAutoConnectRef.current = routePairingUrl;
    void connectAndClose(pairingConnectionInputFromUrl(routePairingUrl), true);
  }, [connectAndClose, routePairingUrl, shouldAutoConnect]);

  return (
    <SettingsScreen
      formSheet={routeName === "ConnectionsNew"}
      title={showScanner ? "Scan QR Code" : "Add Environment"}
      actions={[
        {
          accessibilityLabel: showScanner ? "Close scanner" : "Scan QR code",
          icon: showScanner ? "xmark" : Platform.OS === "ios" ? "qrcode.viewfinder" : "camera",
          tintColor: headerIconColor,
          onPress: () => {
            if (showScanner) {
              closeScanner();
            } else {
              void openScanner();
            }
          },
        },
      ]}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 16,
        }}
      >
        <View collapsable={false} className="gap-5">
          {showScanner ? (
            cameraPermission?.granted ? (
              <View className="overflow-hidden rounded-[24px] border-continuous">
                <CameraView
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onBarcodeScanned={handleQrScan}
                  style={{ aspectRatio: 1, width: "100%" }}
                />
              </View>
            ) : (
              <View className="items-center gap-3 rounded-[24px] border-continuous bg-grouped-card px-5 py-8">
                <Text className="text-center text-sm leading-normal text-foreground-muted">
                  Camera permission is required to scan a QR code.
                </Text>
                <ConnectionSheetButton
                  compact
                  icon="camera"
                  label="Allow camera"
                  tone="secondary"
                  onPress={() => {
                    void openScanner();
                  }}
                />
              </View>
            )
          ) : (
            <View collapsable={false} className="gap-4 rounded-[24px] bg-grouped-card p-4">
              <ConnectionFormField
                label="Host"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="192.168.1.100:8080"
                value={hostInput}
                onChangeText={handleHostChange}
              />

              <ConnectionFormField
                label="Pairing code"
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="abc-123-xyz"
                value={codeInput}
                onChangeText={handleCodeChange}
              />

              <QueryParameterFields
                value={queryParameters}
                onChange={handleQueryParametersChange}
              />

              {pairingError ? <ErrorBanner message={pairingError} /> : null}

              <View className="android:flex-row android:justify-end">
                <ConnectionSheetButton
                  icon="plus"
                  label={isSubmitting ? "Pairing..." : "Add environment"}
                  disabled={connectDisabled}
                  tone="primary"
                  onPress={() => {
                    void handleSubmit();
                  }}
                />
              </View>
            </View>
          )}
        </View>
      </ScrollView>
    </SettingsScreen>
  );
}
