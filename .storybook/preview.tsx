import { TRANSLATED_LOCALES, type TranslatedLocale } from "@openbot/i18n";
import { installPointerFocusGuard } from "@openbot/ui/pointer-focus";
import { flush } from "solid-js";
import type { Preview } from "storybook-solidjs-vite";
import { renderToCanvas as solidRenderToCanvas } from "storybook-solidjs-vite/renderer/solid-next";
import { StaticI18nProvider } from "../src/renderer/src/i18n-context";
import "../src/renderer/src/styles.css";
import "./preview.css";

installPointerFocusGuard();

function isTranslatedLocale(value: unknown): value is TranslatedLocale {
  return TRANSLATED_LOCALES.some((locale) => locale === value);
}

const preview: Preview = {
  // The toolbar switches every story's text, so a translation can be read in its real layout.
  globalTypes: {
    locale: {
      description: "Interface language",
      toolbar: { icon: "globe", items: [...TRANSLATED_LOCALES], dynamicTitle: true },
    },
    // The palette of tokens-light.css or the dark base, as the app's root attribute selects it.
    colorScheme: {
      description: "Color scheme",
      toolbar: { icon: "contrast", items: ["dark", "light"], dynamicTitle: true },
    },
  },
  initialGlobals: { locale: "en", colorScheme: "dark" },
  // The Solid renderer writes the args and the globals into stores just before it draws a story, and
  // Solid 2 commits a store write at its next flush. The first draw read empty stores: a story with
  // args threw on a missing prop, and the commit drew every story a second time, so a story that
  // installs a mock `window.openbot` lost it to the cleanup of the first draw.
  renderToCanvas: (context, canvas) => {
    flush();
    return solidRenderToCanvas(context, canvas);
  },
  decorators: [
    (Story, context) => {
      document.documentElement.dataset.openbotColorScheme = context.globals.colorScheme === "light" ? "light" : "dark";
      return (
        <StaticI18nProvider locale={isTranslatedLocale(context.globals.locale) ? context.globals.locale : "en"}>
          <Story />
        </StaticI18nProvider>
      );
    },
  ],
  parameters: {
    layout: "fullscreen",
    a11y: {
      test: "error",
    },
    controls: {
      expanded: true,
    },
  },
};

export default preview;
