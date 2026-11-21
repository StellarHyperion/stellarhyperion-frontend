"use client";

import type { ReactElement } from "react";
import { RouteError } from "../components/common/RouteError";

export default function Error(props: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}): ReactElement {
  return <RouteError {...props} flow="bridge view" backHref="/" />;
}
