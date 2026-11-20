"use client";

import { createContext, useContext, type ReactNode } from "react";
import { initialRuntimeCapabilities, type RuntimeCapabilities } from "./runtime-capabilities";
import { formatMessage, type MessageFormatter, type TranslationCatalog } from "./messages";

export interface RuntimeContextValue {
  readonly capabilities: RuntimeCapabilities;
  readonly refresh: () => void;
}

const RuntimeContext = createContext<RuntimeContextValue>({
  capabilities: initialRuntimeCapabilities,
  refresh: () => undefined,
});
const MessagesContext = createContext<TranslationCatalog | undefined>(undefined);

export function RuntimeCapabilitiesProvider({
  children,
  value,
  translations,
}: {
  readonly children: ReactNode;
  readonly value: RuntimeContextValue;
  readonly translations?: TranslationCatalog;
}) {
  return (
    <RuntimeContext.Provider value={value}>
      <MessagesContext.Provider value={translations}>{children}</MessagesContext.Provider>
    </RuntimeContext.Provider>
  );
}

export function useRuntimeCapabilities(): RuntimeContextValue {
  return useContext(RuntimeContext);
}

export function useTranslations(): TranslationCatalog | undefined {
  return useContext(MessagesContext);
}

export function useMessages(): MessageFormatter {
  const translations = useTranslations();
  return (key, ...args) => formatMessage(translations, key, ...args);
}
