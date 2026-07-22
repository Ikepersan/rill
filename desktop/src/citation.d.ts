declare module "citeproc" {
  export default class Engine {
    constructor(system: { retrieveLocale: (language: string) => string; retrieveItem: (id: string) => unknown }, style: string, language?: string);
    updateItems(ids: string[]): void;
    makeBibliography(): [unknown, string[]] | false;
  }
}

declare module "@citation-js/plugin-csl/lib/styles.json" {
  const styles: Record<string, string>;
  export default styles;
}

declare module "@citation-js/plugin-csl/lib/locales.json" {
  const locales: Record<string, string>;
  export default locales;
}
