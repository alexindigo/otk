// SPDX-License-Identifier: LGPL-3.0-only
import { render } from "@solidjs/web";
import App from "./ui/App.tsx";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./theme.css";
render(() => <App />, document.getElementById("app")!);
